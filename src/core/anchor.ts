import { diffArrays } from "diff";
import { changedFiles } from "./git";
import { getVersion, readContent } from "./reviews";
import { Store } from "./store";
import { Anchor, FileChange, Review } from "./types";

export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Maps each 0-based line of `from` to its 0-based line in `to`, or null when removed or modified. */
export function lineMap(from: string[], to: string[]): (number | null)[] {
  const map: (number | null)[] = new Array(from.length).fill(null);
  let i = 0;
  let j = 0;
  for (const part of diffArrays(from, to)) {
    const count = part.value.length;
    if (part.added) {
      j += count;
    } else if (part.removed) {
      i += count;
    } else {
      for (let k = 0; k < count; k++) map[i + k] = j + k;
      i += count;
      j += count;
    }
  }
  return map;
}

/** Relocates a 1-based inclusive range; null when a line of it changed or lines were inserted inside it. */
export function mapRange(
  from: string[],
  to: string[],
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } | null {
  const map = lineMap(from, to);
  const mapped: number[] = [];
  for (let l = startLine; l <= endLine; l++) {
    const m = map[l - 1];
    if (m === null || m === undefined) return null;
    mapped.push(m);
  }
  const start = mapped[0] + 1;
  const end = mapped[mapped.length - 1] + 1;
  if (end - start !== endLine - startLine) return null;
  return { startLine: start, endLine: end };
}

export type Location =
  | { outdated: false; path: string; startLine: number; endLine: number }
  | { outdated: true; path: string };

/** Relocates anchors of one review onto commits or the working tree, caching git lookups. */
export class Locator {
  private renames = new Map<string, Promise<FileChange[]>>();
  private contents = new Map<string, Promise<string | null>>();

  constructor(
    private readonly store: Store,
    private readonly review: Review,
  ) {}

  private content(sha: string | null, file: string): Promise<string | null> {
    const key = `${sha ?? "worktree"}:${file}`;
    let p = this.contents.get(key);
    if (!p) {
      p = readContent(this.store, sha, file);
      // The working tree changes under us: never cache it.
      if (sha) this.contents.set(key, p);
    }
    return p;
  }

  private changes(from: string, to: string | null): Promise<FileChange[]> {
    if (to === null) return changedFiles(this.store.repo, from, null);
    const key = `${from}..${to}`;
    let p = this.renames.get(key);
    if (!p) {
      p = changedFiles(this.store.repo, from, to);
      this.renames.set(key, p);
    }
    return p;
  }

  /** Commit the anchor was placed on (for worktree anchors: the head they were written over) and its content. */
  async origin(anchor: Anchor): Promise<{ sha: string; content: string | null }> {
    if (anchor.origin.kind === "version") {
      const v = getVersion(this.review, anchor.origin.n);
      const sha = anchor.side === "new" ? v.head : v.base;
      return { sha, content: await this.content(sha, anchor.path) };
    }
    const sha = getVersion(this.review, anchor.origin.baseVersion).head;
    return { sha, content: await this.store.readSnapshot(this.review.id, anchor.origin.snapshot) };
  }

  /** Location of the anchor in `target` (a commit SHA, or null for the working tree). */
  async locate(anchor: Anchor, target: string | null): Promise<Location> {
    const origin = await this.origin(anchor);
    let targetPath = anchor.path;
    if (origin.sha !== target || anchor.origin.kind === "worktree") {
      const change = (await this.changes(origin.sha, target)).find((c) => c.oldPath === anchor.path);
      if (change?.status === "D") return { outdated: true, path: anchor.path };
      if (change) targetPath = change.path;
    }
    const targetContent = await this.content(target, targetPath);
    if (origin.content === null || targetContent === null) return { outdated: true, path: anchor.path };
    if (origin.content === targetContent) {
      return { outdated: false, path: targetPath, startLine: anchor.startLine, endLine: anchor.endLine };
    }
    const range = mapRange(splitLines(origin.content), splitLines(targetContent), anchor.startLine, anchor.endLine);
    return range ? { outdated: false, path: targetPath, ...range } : { outdated: true, path: anchor.path };
  }
}
