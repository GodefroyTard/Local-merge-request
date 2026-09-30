export const SCHEMA_VERSION = 1;

export type Author = "user" | "claude";
export type Severity = "blocking" | "suggestion" | "question";
export type ThreadStatus = "open" | "addressed" | "resolved";
export type ReviewState = "open" | "closed";
export type Side = "old" | "new";

export const SEVERITIES: readonly Severity[] = ["blocking", "suggestion", "question"];
export const STATUSES: readonly ThreadStatus[] = ["open", "addressed", "resolved"];

export interface Version {
  n: number;
  base: string;
  head: string;
  at: string;
}

export interface Review {
  schemaVersion: number;
  id: string;
  title: string;
  from: string;
  to: string;
  state: ReviewState;
  createdAt: string;
  versions: Version[];
  missingRef: boolean;
  /** path -> blob id of the head-side content when marked viewed */
  viewed: Record<string, string>;
}

export type AnchorOrigin =
  | { kind: "version"; n: number }
  | { kind: "worktree"; snapshot: string; baseVersion: number };

export interface Anchor {
  path: string;
  side: Side;
  /** 1-based, inclusive */
  startLine: number;
  endLine: number;
  lines: string[];
  origin: AnchorOrigin;
}

export interface Message {
  id: string;
  author: Author;
  body: string;
  at: string;
  editedAt?: string;
}

export interface StatusEvent {
  type: "status";
  from: ThreadStatus;
  to: ThreadStatus;
  author: Author;
  at: string;
}

export interface Thread {
  schemaVersion: number;
  id: string;
  severity: Severity;
  status: ThreadStatus;
  anchor: Anchor | null;
  messages: Message[];
  events: StatusEvent[];
}

export type View =
  | { kind: "full"; version: number }
  | { kind: "interdiff"; from: number; to: number }
  | { kind: "worktree" };

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface FileChange {
  status: ChangeStatus;
  /** path on the right side (for deletions: the deleted path) */
  path: string;
  /** path on the left side */
  oldPath: string;
}

export interface LineStats {
  added: number | null;
  removed: number | null;
}

export class ReviewError extends Error {}
