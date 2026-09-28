import * as vscode from "vscode";
import { Side } from "../core";

export const SCHEME = "lreview";

/** A file at a commit, as one side of a review diff. */
export interface FileDoc {
  kind: "file";
  repo: string;
  review: string;
  sha: string;
  path: string;
  role: "left" | "right";
  /** Anchor produced by commenting this document; absent when commenting is disabled. */
  anchor?: { side: Side; version: number };
}

/** Review overview holding the general threads. */
export interface OverviewDoc {
  kind: "overview";
  repo: string;
  review: string;
}

/** Read-only page of a thread that cannot be shown inline (outdated, old side in the in-progress view). */
export interface ThreadDoc {
  kind: "thread";
  repo: string;
  review: string;
  thread: string;
}

export type DocRef = FileDoc | OverviewDoc | ThreadDoc;

export function toUri(ref: DocRef): vscode.Uri {
  const p =
    ref.kind === "file" ? `/${ref.path}` : ref.kind === "overview" ? `/review-${ref.review}.md` : `/thread-${ref.thread}.md`;
  return vscode.Uri.from({ scheme: SCHEME, path: p, query: JSON.stringify(ref) });
}

export function fromUri(uri: vscode.Uri): DocRef | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  try {
    return JSON.parse(uri.query) as DocRef;
  } catch {
    return undefined;
  }
}
