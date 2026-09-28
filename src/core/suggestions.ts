import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Locator, splitLines } from "./anchor";
import { writeFileAtomic } from "./fsutil";
import { readContent } from "./reviews";
import { Store } from "./store";
import { setStatus } from "./threads";
import { Author, Review, ReviewError, Thread } from "./types";

const SUGGESTION_BLOCK = /^```suggestion[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

export function extractSuggestions(body: string): string[] {
  return [...body.matchAll(SUGGESTION_BLOCK)].map((m) => m[1].replace(/\r?\n$/, ""));
}

/** Suggestion of the most recent message holding exactly one suggestion block. */
export function applicableSuggestion(thread: Thread): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const blocks = extractSuggestions(thread.messages[i].body);
    if (blocks.length === 1) return blocks[0];
  }
  return null;
}

export interface SuggestionPlan {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string[];
  newContent: string;
}

/**
 * Computes the working-tree edit for a thread's suggestion. `current` overrides the on-disk content
 * (e.g. an open editor buffer).
 */
export async function planSuggestion(store: Store, review: Review, thread: Thread, current?: string): Promise<SuggestionPlan> {
  const suggestion = applicableSuggestion(thread);
  if (suggestion === null) throw new ReviewError(`thread ${thread.id} has no applicable suggestion`);
  const anchor = thread.anchor;
  if (!anchor) throw new ReviewError("suggestions cannot be applied on a general thread");
  if (anchor.side !== "new") throw new ReviewError("suggestions cannot be applied on an old-side comment");

  const loc = await new Locator(store, review).locate(anchor, null);
  if (loc.outdated) throw new ReviewError(`the code changed since the comment on ${anchor.path}`);
  const content = current ?? (await readContent(store, null, loc.path));
  if (content === null) throw new ReviewError(`${loc.path} does not exist in the working tree`);

  const lines = splitLines(content);
  const actual = lines.slice(loc.startLine - 1, loc.endLine);
  if (actual.length !== anchor.lines.length || actual.some((l, i) => l !== anchor.lines[i])) {
    throw new ReviewError(`the code changed since the comment on ${loc.path}:${loc.startLine}-${loc.endLine}`);
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const replacement = suggestion === "" ? [] : suggestion.split(/\r?\n/);
  const next = [...lines.slice(0, loc.startLine - 1), ...replacement, ...lines.slice(loc.endLine)];
  const trailing = content === "" || /\r?\n$/.test(content) ? eol : "";
  return {
    path: loc.path,
    startLine: loc.startLine,
    endLine: loc.endLine,
    replacement,
    newContent: next.length ? next.join(eol) + trailing : "",
  };
}

/** Applies the suggestion on disk and marks the thread addressed. Never stages anything. */
export async function applySuggestion(store: Store, review: Review, thread: Thread, author: Author): Promise<SuggestionPlan> {
  const plan = await planSuggestion(store, review, thread);
  const file = path.join(store.repo, plan.path);
  const { mode } = await fs.stat(file);
  await writeFileAtomic(file, plan.newContent);
  await fs.chmod(file, mode);
  if (thread.status === "open") await setStatus(store, review.id, thread.id, "addressed", author);
  return plan;
}
