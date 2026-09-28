import { describe, expect, test } from "vitest";
import { Store } from "../src/core/store";
import {
  createReview,
  isViewed,
  latestVersion,
  readContent,
  refreshReview,
  setReviewState,
  setViewed,
  viewFiles,
} from "../src/core/reviews";
import { createThread } from "../src/core/threads";
import { TestRepo } from "./helpers";

async function setup() {
  const repo = TestRepo.create();
  const base = repo.commit({ "a.txt": "a\n", "b.txt": "b\n" });
  repo.git("checkout", "-q", "-b", "feat");
  const head = repo.commit({ "a.txt": "a2\n" });
  const store = await Store.open(repo.dir);
  return { repo, base, head, store };
}

describe("creation", () => {
  test("stores refs as typed and a first version from the merge-base", async () => {
    const { repo, base, head, store } = await setup();
    repo.git("checkout", "-q", "main");
    repo.commit({ "b.txt": "b on main\n" });
    const review = await createReview(store, { from: "main", to: "feat" });
    expect(review.from).toBe("main");
    expect(review.to).toBe("feat");
    expect(review.title).toBe("feat");
    expect(review.versions).toEqual([{ n: 1, base, head, at: expect.any(String) }]);
    expect(await viewFiles(store, review, { kind: "full", version: 1 })).toEqual([
      { status: "M", path: "a.txt", oldPath: "a.txt" },
    ]);
  });

  test("fails on an unresolvable ref and writes nothing", async () => {
    const { store } = await setup();
    await expect(createReview(store, { from: "main", to: "does-not-exist" })).rejects.toThrow(/"does-not-exist"/);
    expect(await store.listReviews()).toEqual([]);
  });

  test("fails on an empty range", async () => {
    const { store } = await setup();
    await expect(createReview(store, { from: "feat", to: "feat" })).rejects.toThrow(/no change/);
  });
});

describe("versions", () => {
  test("appends a version when the head moves, keeps old ones", async () => {
    const { repo, store } = await setup();
    const review = await createReview(store, { from: "main", to: "feat" });
    const v1 = review.versions[0];
    const newHead = repo.commit({ "b.txt": "b2\n" });
    const { review: r2, appended } = await refreshReview(store, review.id);
    expect(appended).toBe(true);
    expect(r2.versions).toHaveLength(2);
    expect(r2.versions[0]).toEqual(v1);
    expect(latestVersion(r2)).toMatchObject({ n: 2, head: newHead });
  });

  test("does nothing when refs did not move, even with concurrent refreshes", async () => {
    const { repo, store } = await setup();
    const review = await createReview(store, { from: "main", to: "feat" });
    expect((await refreshReview(store, review.id)).appended).toBe(false);
    repo.commit({ "b.txt": "b2\n" });
    await Promise.all([1, 2, 3, 4].map(() => refreshReview(store, review.id)));
    expect((await store.readReview(review.id)).versions).toHaveLength(2);
  });

  test("flags a deleted ref and stays readable", async () => {
    const { repo, store } = await setup();
    const review = await createReview(store, { from: "main", to: "feat" });
    repo.git("checkout", "-q", "main");
    repo.git("branch", "-D", "feat");
    const { review: r, appended } = await refreshReview(store, review.id);
    expect(appended).toBe(false);
    expect(r.missingRef).toBe(true);
    expect(await viewFiles(store, r, { kind: "full", version: 1 })).toHaveLength(1);
  });
});

describe("views", () => {
  test("interdiff only shows changes between heads; worktree view shows uncommitted changes", async () => {
    const { repo, store } = await setup();
    const review = await createReview(store, { from: "main", to: "feat" });
    repo.commit({ "b.txt": "b2\n" });
    const { review: r } = await refreshReview(store, review.id);
    expect(await viewFiles(store, r, { kind: "interdiff", from: 1, to: 2 })).toEqual([
      { status: "M", path: "b.txt", oldPath: "b.txt" },
    ]);

    repo.write("a.txt", "uncommitted\n");
    expect(await viewFiles(store, r, { kind: "worktree" })).toEqual([{ status: "M", path: "a.txt", oldPath: "a.txt" }]);
    expect((await viewFiles(store, r, { kind: "full", version: 2 })).map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(await readContent(store, null, "a.txt")).toBe("uncommitted\n");
  });
});

describe("lifecycle and viewed flags", () => {
  test("closing and reopening keeps data", async () => {
    const { store } = await setup();
    const review = await createReview(store, { from: "main", to: "feat" });
    await createThread(store, review, { severity: "question", body: "why?", author: "user" });
    await setViewed(store, review.id, review.versions[0].head, "a.txt", true);
    await setReviewState(store, review.id, "closed");
    const reopened = await setReviewState(store, review.id, "open");
    expect(reopened.state).toBe("open");
    expect(reopened.viewed["a.txt"]).toBeDefined();
    expect(await store.listThreads(review.id)).toHaveLength(1);
  });

  test("a viewed file becomes not viewed when its content changes", async () => {
    const { repo, store } = await setup();
    const review = await createReview(store, { from: "main", to: "feat" });
    const v1 = review.versions[0].head;
    let r = await setViewed(store, review.id, v1, "a.txt", true);
    expect(await isViewed(store, r, v1, "a.txt")).toBe(true);
    const v2 = repo.commit({ "a.txt": "a3\n" });
    r = (await refreshReview(store, review.id)).review;
    expect(await isViewed(store, r, v2, "a.txt")).toBe(false);
    r = await setViewed(store, review.id, v2, "a.txt", false);
    expect(r.viewed).toEqual({});
  });
});
