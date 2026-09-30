import { promises as fs } from "node:fs";
import * as path from "node:path";
import { blobId, changedFiles, diffStats, mergeBase, resolveCommit, showFile } from "./git";
import { newId, Store } from "./store";
import { FileChange, LineStats, Review, ReviewError, SCHEMA_VERSION, Version, View } from "./types";

const now = () => new Date().toISOString();

async function resolveRange(store: Store, from: string, to: string): Promise<{ base: string; head: string } | null> {
  const fromSha = await resolveCommit(store.repo, from);
  const head = await resolveCommit(store.repo, to);
  if (!fromSha || !head) return null;
  return { base: await mergeBase(store.repo, fromSha, head), head };
}

export async function createReview(store: Store, opts: { from: string; to: string; title?: string }): Promise<Review> {
  for (const ref of [opts.from, opts.to]) {
    if (!(await resolveCommit(store.repo, ref))) throw new ReviewError(`ref "${ref}" does not resolve to a commit`);
  }
  const range = (await resolveRange(store, opts.from, opts.to))!;
  if ((await changedFiles(store.repo, range.base, range.head)).length === 0) {
    throw new ReviewError(`range ${opts.from}..${opts.to} has no change`);
  }
  const review: Review = {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    title: opts.title?.trim() || opts.to,
    from: opts.from,
    to: opts.to,
    state: "open",
    createdAt: now(),
    versions: [{ n: 1, base: range.base, head: range.head, at: now() }],
    missingRef: false,
    viewed: {},
  };
  await store.createReview(review);
  return review;
}

export function latestVersion(review: Review): Version {
  return review.versions[review.versions.length - 1];
}

export function getVersion(review: Review, n: number): Version {
  const v = review.versions.find((x) => x.n === n);
  if (!v) throw new ReviewError(`review ${review.id} has no version ${n}`);
  return v;
}

/** Re-resolves the refs and appends a version when base or head moved. */
export async function refreshReview(store: Store, id: string): Promise<{ review: Review; appended: boolean }> {
  const current = await store.readReview(id);
  const range = await resolveRange(store, current.from, current.to);
  let appended = false;
  const review = await store.updateReview(id, (r) => {
    if (!range) {
      if (r.missingRef) return undefined;
      return { ...r, missingRef: true };
    }
    const last = latestVersion(r);
    if (last.base === range.base && last.head === range.head) {
      return r.missingRef ? { ...r, missingRef: false } : undefined;
    }
    appended = true;
    return {
      ...r,
      missingRef: false,
      versions: [...r.versions, { n: last.n + 1, base: range.base, head: range.head, at: now() }],
    };
  });
  return { review, appended };
}

export async function refreshAll(store: Store, includeClosed = false): Promise<Review[]> {
  const reviews: Review[] = [];
  for (const r of await store.listReviews()) {
    if (r.state === "closed" && !includeClosed) continue;
    reviews.push(r.state === "open" ? (await refreshReview(store, r.id)).review : r);
  }
  return reviews;
}

/** Commits on each side of a view; `right === null` means the working tree. */
export function viewSides(review: Review, view: View): { left: string; right: string | null } {
  switch (view.kind) {
    case "full": {
      const v = getVersion(review, view.version);
      return { left: v.base, right: v.head };
    }
    case "interdiff":
      return { left: getVersion(review, view.from).head, right: getVersion(review, view.to).head };
    case "worktree":
      return { left: latestVersion(review).head, right: null };
  }
}

export function viewFiles(store: Store, review: Review, view: View): Promise<FileChange[]> {
  const { left, right } = viewSides(review, view);
  return changedFiles(store.repo, left, right);
}

export function viewStats(store: Store, review: Review, view: View): Promise<Map<string, LineStats>> {
  const { left, right } = viewSides(review, view);
  return diffStats(store.repo, left, right);
}

/** Content at a commit, or in the working tree when `sha` is null; null when the file does not exist. */
export async function readContent(store: Store, sha: string | null, file: string): Promise<string | null> {
  if (sha) return showFile(store.repo, sha, file);
  try {
    return await fs.readFile(path.join(store.repo, file), "utf8");
  } catch {
    return null;
  }
}

export async function setViewed(store: Store, id: string, head: string, file: string, viewed: boolean): Promise<Review> {
  const blob = viewed ? await blobId(store.repo, head, file) : null;
  return store.updateReview(id, (r) => {
    const next = { ...r.viewed };
    if (blob) next[file] = blob;
    else delete next[file];
    return { ...r, viewed: next };
  });
}

export async function isViewed(store: Store, review: Review, head: string, file: string): Promise<boolean> {
  const stored = review.viewed[file];
  return !!stored && stored === (await blobId(store.repo, head, file));
}

export function setReviewState(store: Store, id: string, state: Review["state"]): Promise<Review> {
  return store.updateReview(id, (r) => (r.state === state ? undefined : { ...r, state }));
}
