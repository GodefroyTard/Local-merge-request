import { splitLines } from "./anchor";
import { getVersion, latestVersion, readContent } from "./reviews";
import { newId, Store } from "./store";
import {
  Anchor,
  AnchorOrigin,
  Author,
  Review,
  ReviewError,
  SCHEMA_VERSION,
  Severity,
  SEVERITIES,
  Side,
  Thread,
  ThreadStatus,
} from "./types";

const now = () => new Date().toISOString();

export interface NewAnchor {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  /** A version number, or the working tree (optionally with the content being commented, e.g. an unsaved buffer). */
  origin: { kind: "version"; n: number } | { kind: "worktree"; content?: string };
}

async function buildAnchor(store: Store, review: Review, a: NewAnchor): Promise<Anchor> {
  let content: string | null;
  let origin: AnchorOrigin;
  if (a.origin.kind === "version") {
    const v = getVersion(review, a.origin.n);
    content = await readContent(store, a.side === "new" ? v.head : v.base, a.path);
    origin = { kind: "version", n: v.n };
  } else {
    if (a.side !== "new") throw new ReviewError("working-tree anchors must be on the new side");
    content = a.origin.content ?? (await readContent(store, null, a.path));
    if (content === null) throw new ReviewError(`${a.path} does not exist in the working tree`);
    origin = { kind: "worktree", snapshot: await store.putSnapshot(review.id, content), baseVersion: latestVersion(review).n };
  }
  if (content === null) throw new ReviewError(`${a.path} does not exist on the ${a.side} side`);
  const lines = splitLines(content);
  if (!Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine < 1 || a.endLine < a.startLine || a.endLine > lines.length) {
    throw new ReviewError(`invalid line range ${a.startLine}-${a.endLine} for ${a.path} (${lines.length} lines)`);
  }
  return {
    path: a.path,
    side: a.side,
    startLine: a.startLine,
    endLine: a.endLine,
    lines: lines.slice(a.startLine - 1, a.endLine),
    origin,
  };
}

function checkBody(body: string): string {
  if (!body.trim()) throw new ReviewError("message is empty");
  return body;
}

export function checkSeverity(severity: string): Severity {
  if (!SEVERITIES.includes(severity as Severity)) throw new ReviewError(`invalid severity "${severity}" (expected ${SEVERITIES.join(", ")})`);
  return severity as Severity;
}

export async function createThread(
  store: Store,
  review: Review,
  opts: { severity: Severity; body: string; author: Author; anchor?: NewAnchor },
): Promise<Thread> {
  const thread: Thread = {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    severity: checkSeverity(opts.severity),
    status: "open",
    anchor: opts.anchor ? await buildAnchor(store, review, opts.anchor) : null,
    messages: [{ id: newId(), author: opts.author, body: checkBody(opts.body), at: now() }],
    events: [],
  };
  await store.createThread(review.id, thread);
  return thread;
}

export function addMessage(store: Store, reviewId: string, threadId: string, author: Author, body: string): Promise<Thread> {
  checkBody(body);
  return store.updateThread(reviewId, threadId, (t) => ({
    ...t,
    messages: [...t.messages, { id: newId(), author, body, at: now() }],
  }));
}

function ownMessageIndex(t: Thread, messageId: string, author: Author): number {
  const i = t.messages.findIndex((m) => m.id === messageId);
  if (i < 0) throw new ReviewError(`message ${messageId} not found`);
  if (t.messages[i].author !== author) throw new ReviewError("only the author of a message can change it");
  return i;
}

export function editMessage(store: Store, reviewId: string, threadId: string, messageId: string, author: Author, body: string): Promise<Thread> {
  checkBody(body);
  return store.updateThread(reviewId, threadId, (t) => {
    const i = ownMessageIndex(t, messageId, author);
    const messages = [...t.messages];
    messages[i] = { ...messages[i], body, editedAt: now() };
    return { ...t, messages };
  });
}

/** Deletes one's own message; the thread is removed with its last message. */
export async function deleteMessage(store: Store, reviewId: string, threadId: string, messageId: string, author: Author): Promise<Thread | null> {
  const t = await store.updateThread(reviewId, threadId, (cur) => {
    const i = ownMessageIndex(cur, messageId, author);
    return { ...cur, messages: cur.messages.filter((_, k) => k !== i) };
  });
  if (t.messages.length === 0) {
    await store.deleteThread(reviewId, threadId);
    return null;
  }
  return t;
}

export function canSetStatus(author: Author, from: ThreadStatus, to: ThreadStatus): boolean {
  if (author === "user") return true;
  return from === "open" && to === "addressed";
}

export function setStatus(store: Store, reviewId: string, threadId: string, to: ThreadStatus, author: Author): Promise<Thread> {
  return store.updateThread(reviewId, threadId, (t) => {
    if (t.status === to) return undefined;
    if (!canSetStatus(author, t.status, to)) {
      throw new ReviewError(`${author} cannot change thread ${t.id} from ${t.status} to ${to}`);
    }
    return { ...t, status: to, events: [...t.events, { type: "status", from: t.status, to, author, at: now() }] };
  });
}

export function setSeverity(store: Store, reviewId: string, threadId: string, severity: Severity): Promise<Thread> {
  checkSeverity(severity);
  return store.updateThread(reviewId, threadId, (t) => (t.severity === severity ? undefined : { ...t, severity }));
}
