import { promises as fs } from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { changedFiles, diffStats, commonDir, mergeBase, resolveCommit, showFile, blobId, topLevel } from "../src/core/git";
import { readJson, updateJson } from "../src/core/fsutil";
import { Store } from "../src/core/store";
import { createReview } from "../src/core/reviews";
import { TestRepo } from "./helpers";

describe("git wrapper", () => {
  test("resolves refs, merge-base, contents and renames", async () => {
    const repo = TestRepo.create();
    const base = repo.commit({ "a.txt": "a\n", "b.txt": "b1\nb2\nb3\nb4\nb5\n" });
    repo.git("checkout", "-q", "-b", "feat");
    repo.git("mv", "b.txt", "c.txt");
    const head = repo.commit({ "a.txt": "a2\n" });

    expect(await resolveCommit(repo.dir, "feat")).toBe(head);
    expect(await resolveCommit(repo.dir, "nope")).toBeNull();
    expect(await resolveCommit(repo.dir, "--help")).toBeNull();
    expect(await mergeBase(repo.dir, "main", "feat")).toBe(base);
    expect(await showFile(repo.dir, head, "a.txt")).toBe("a2\n");
    expect(await showFile(repo.dir, head, "b.txt")).toBeNull();
    expect(await blobId(repo.dir, head, "c.txt")).toMatch(/^[0-9a-f]{40}$/);

    const files = await changedFiles(repo.dir, base, head);
    expect(files).toContainEqual({ status: "M", path: "a.txt", oldPath: "a.txt" });
    expect(files).toContainEqual({ status: "R", path: "c.txt", oldPath: "b.txt" });
  });

  test("line stats per file, including renames and binaries", async () => {
    const repo = TestRepo.create();
    const base = repo.commit({ "a.txt": "a\nb\n", "b.txt": "one\ntwo\nthree\nfour\n" });
    repo.git("mv", "b.txt", "c.txt");
    repo.write("c.txt", "one\ntwo\nthree\nfour\nfive\n");
    const head = repo.commit({ "a.txt": "a\nB\nc\n", "bin.dat": "\0\x01" });

    const stats = await diffStats(repo.dir, base, head);
    expect(stats.get("a.txt")).toEqual({ added: 2, removed: 1 });
    expect(stats.get("c.txt")).toEqual({ added: 1, removed: 0 });
    expect(stats.get("bin.dat")).toEqual({ added: null, removed: null });

    repo.write("a.txt", "changed\n");
    expect((await diffStats(repo.dir, head, null)).get("a.txt")).toEqual({ added: 1, removed: 3 });
  });

  test("diff against the working tree", async () => {
    const repo = TestRepo.create();
    const head = repo.commit({ "a.txt": "a\n" });
    repo.write("a.txt", "changed\n");
    expect(await changedFiles(repo.dir, head, null)).toEqual([{ status: "M", path: "a.txt", oldPath: "a.txt" }]);
  });

  test("a linked worktree resolves to the same common dir", async () => {
    const repo = TestRepo.create();
    repo.commit({ "a.txt": "a\n" });
    repo.git("branch", "feat");
    const wt = repo.addWorktree("feat");
    expect(await commonDir(wt)).toBe(await commonDir(repo.dir));
    expect(await topLevel(wt)).toBe(await fs.realpath(wt));
  });
});

describe("locked JSON updates", () => {
  test("concurrent writers lose no update", async () => {
    const repo = TestRepo.create();
    const file = path.join(repo.dir, "counter.json");
    await Promise.all(
      Array.from({ length: 40 }, () => updateJson<{ n: number }>(file, (cur) => ({ n: (cur?.n ?? 0) + 1 }))),
    );
    expect(await readJson<{ n: number }>(file)).toEqual({ n: 40 });
    expect((await fs.readdir(repo.dir)).filter((f) => f.includes("lock") || f.includes("tmp"))).toEqual([]);
  });

  test("a stale lock is taken over", async () => {
    const repo = TestRepo.create();
    const file = path.join(repo.dir, "x.json");
    await fs.writeFile(`${file}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.lock`, old, old);
    await updateJson(file, () => ({ ok: true }));
    expect(await readJson(file)).toEqual({ ok: true });
  });
});

describe("store", () => {
  test("stores reviews under the common dir, shared by worktrees, invisible to git status", async () => {
    const repo = TestRepo.create();
    repo.commit({ "a.txt": "a\n" });
    repo.git("checkout", "-q", "-b", "feat");
    repo.commit({ "a.txt": "b\n" });
    repo.git("checkout", "-q", "main");

    const store = await Store.open(repo.dir);
    expect(store.root).toBe(path.join(await fs.realpath(repo.dir), ".git", "local-reviews"));
    const review = await createReview(store, { from: "main", to: "feat" });

    const wt = repo.addWorktree("feat");
    const other = await Store.open(wt);
    expect((await other.listReviews()).map((r) => r.id)).toEqual([review.id]);
    expect(repo.status()).toBe("");
  });

  test("resolves ids by unique prefix and deletes reviews", async () => {
    const repo = TestRepo.create();
    repo.commit({ "a.txt": "a\n" });
    repo.git("checkout", "-q", "-b", "feat");
    repo.commit({ "a.txt": "b\n" });
    const store = await Store.open(repo.dir);
    const review = await createReview(store, { from: "main", to: "feat", title: "T" });

    expect(await store.resolveReviewId(review.id.slice(0, 3))).toBe(review.id);
    await expect(store.resolveReviewId("zzzzzzzzz")).rejects.toThrow(/no review/);
    const json = await readJson<{ schemaVersion: number }>(path.join(store.reviewDir(review.id), "review.json"));
    expect(json?.schemaVersion).toBe(1);

    await store.deleteReview(review.id);
    expect(await store.listReviews()).toEqual([]);
  });
});
