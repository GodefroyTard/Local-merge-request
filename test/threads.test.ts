import { describe, expect, test } from "vitest";
import { Locator, mapRange, splitLines } from "../src/core/anchor";
import { createReview, refreshReview } from "../src/core/reviews";
import { Store } from "../src/core/store";
import {
  addMessage,
  createThread,
  deleteMessage,
  editMessage,
  setSeverity,
  setStatus,
} from "../src/core/threads";
import { applicableSuggestion, applySuggestion, extractSuggestions, planSuggestion } from "../src/core/suggestions";
import { Review } from "../src/core/types";
import { numbered, TestRepo } from "./helpers";

async function setup(content = numbered(30)) {
  const repo = TestRepo.create();
  repo.commit({ "src/a.py": numbered(30, "orig"), "other.txt": "x\n" });
  repo.git("checkout", "-q", "-b", "feat");
  repo.commit({ "src/a.py": content });
  const store = await Store.open(repo.dir);
  const review = await createReview(store, { from: "main", to: "feat" });
  return { repo, store, review };
}

async function refreshed(store: Store, review: Review) {
  return (await refreshReview(store, review.id)).review;
}

describe("thread creation", () => {
  test("anchored multi-line thread stores path, side, lines and snippet", async () => {
    const { store, review } = await setup();
    const t = await createThread(store, review, {
      severity: "blocking",
      body: "rename",
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 10, endLine: 14, origin: { kind: "version", n: 1 } },
    });
    expect(t.status).toBe("open");
    expect(t.anchor).toMatchObject({ path: "src/a.py", side: "new", startLine: 10, endLine: 14, origin: { kind: "version", n: 1 } });
    expect(t.anchor!.lines).toEqual(["line 10", "line 11", "line 12", "line 13", "line 14"]);
    expect(await store.readThread(review.id, t.id)).toEqual(t);
  });

  test("old side reads the base content", async () => {
    const { store, review } = await setup();
    const t = await createThread(store, review, {
      severity: "question",
      body: "?",
      author: "user",
      anchor: { path: "src/a.py", side: "old", startLine: 2, endLine: 2, origin: { kind: "version", n: 1 } },
    });
    expect(t.anchor!.lines).toEqual(["orig 2"]);
  });

  test("general thread and validation errors", async () => {
    const { store, review } = await setup();
    const t = await createThread(store, review, { severity: "suggestion", body: "global", author: "user" });
    expect(t.anchor).toBeNull();
    await expect(createThread(store, review, { severity: "suggestion", body: "  ", author: "user" })).rejects.toThrow(/empty/);
    await expect(
      createThread(store, review, { severity: "nit" as never, body: "x", author: "user" }),
    ).rejects.toThrow(/severity/);
    await expect(
      createThread(store, review, {
        severity: "blocking",
        body: "x",
        author: "user",
        anchor: { path: "src/a.py", side: "new", startLine: 29, endLine: 31, origin: { kind: "version", n: 1 } },
      }),
    ).rejects.toThrow(/invalid line range/);
  });

  test("working-tree thread stores a snapshot", async () => {
    const { repo, store, review } = await setup();
    repo.write("src/a.py", "new first\n" + numbered(30));
    const t = await createThread(store, review, {
      severity: "blocking",
      body: "no",
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 1, endLine: 1, origin: { kind: "worktree" } },
    });
    expect(t.anchor!.origin).toMatchObject({ kind: "worktree", baseVersion: 1 });
    expect(t.anchor!.lines).toEqual(["new first"]);
    const snap = (t.anchor!.origin as { snapshot: string }).snapshot;
    expect(await store.readSnapshot(review.id, snap)).toBe("new first\n" + numbered(30));
    expect(repo.status()).toBe("M src/a.py");
  });
});

describe("messages and statuses", () => {
  test("replies, edits and deletes own messages only", async () => {
    const { store, review } = await setup();
    const t = await createThread(store, review, { severity: "question", body: "q", author: "user" });
    const t2 = await addMessage(store, review.id, t.id, "claude", "answer");
    const claudeMsg = t2.messages[1];
    expect(claudeMsg.author).toBe("claude");
    await expect(editMessage(store, review.id, t.id, claudeMsg.id, "user", "hijack")).rejects.toThrow(/author/);
    const t3 = await editMessage(store, review.id, t.id, claudeMsg.id, "claude", "better answer");
    expect(t3.messages[1]).toMatchObject({ body: "better answer", editedAt: expect.any(String) });
    expect(await deleteMessage(store, review.id, t.id, claudeMsg.id, "claude")).toMatchObject({ messages: [{ body: "q" }] });
    expect(await deleteMessage(store, review.id, t.id, t.messages[0].id, "user")).toBeNull();
    expect(await store.listThreads(review.id)).toEqual([]);
  });

  test("claude can only move open to addressed; user can do anything", async () => {
    const { store, review } = await setup();
    const t = await createThread(store, review, { severity: "blocking", body: "fix", author: "user" });
    await expect(setStatus(store, review.id, t.id, "resolved", "claude")).rejects.toThrow(/cannot/);
    const a = await setStatus(store, review.id, t.id, "addressed", "claude");
    expect(a.status).toBe("addressed");
    expect(a.events).toEqual([{ type: "status", from: "open", to: "addressed", author: "claude", at: expect.any(String) }]);
    await expect(setStatus(store, review.id, t.id, "open", "claude")).rejects.toThrow(/cannot/);
    expect((await setStatus(store, review.id, t.id, "open", "user")).status).toBe("open");
    expect((await setStatus(store, review.id, t.id, "resolved", "user")).status).toBe("resolved");
    expect((await setSeverity(store, review.id, t.id, "question")).severity).toBe("question");
  });

  test("concurrent replies on the same thread are all kept", async () => {
    const { store, review } = await setup();
    const t = await createThread(store, review, { severity: "question", body: "q", author: "user" });
    await Promise.all(Array.from({ length: 10 }, (_, i) => addMessage(store, review.id, t.id, i % 2 ? "user" : "claude", `m${i}`)));
    expect((await store.readThread(review.id, t.id)).messages).toHaveLength(11);
  });
});

describe("anchor mapping", () => {
  test("mapRange shifts, detects changes and insertions inside the range", () => {
    const from = splitLines(numbered(10));
    expect(mapRange(from, ["x", "y", "z", ...from], 4, 6)).toEqual({ startLine: 7, endLine: 9 });
    const changed = [...from];
    changed[4] = "changed";
    expect(mapRange(from, changed, 4, 6)).toBeNull();
    expect(mapRange(from, [...from.slice(0, 4), "inserted", ...from.slice(4)], 4, 6)).toBeNull();
    expect(mapRange(from, from.slice(0, 3), 4, 6)).toBeNull();
  });

  test("threads follow shifted lines to later versions and become outdated when changed", async () => {
    const { repo, store, review } = await setup();
    const t = await createThread(store, review, {
      severity: "blocking",
      body: "x",
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 10, endLine: 14, origin: { kind: "version", n: 1 } },
    });
    repo.commit({ "src/a.py": "a\nb\nc\n" + numbered(30) });
    let r = await refreshed(store, review);
    expect(await new Locator(store, r).locate(t.anchor!, r.versions[1].head)).toEqual({
      outdated: false,
      path: "src/a.py",
      startLine: 13,
      endLine: 17,
    });

    repo.commit({ "src/a.py": "a\nb\nc\n" + numbered(30).replace("line 12\n", "line twelve\n") });
    r = await refreshed(store, review);
    expect(await new Locator(store, r).locate(t.anchor!, r.versions[2].head)).toEqual({ outdated: true, path: "src/a.py" });
  });

  test("threads follow renames and are outdated on deletion", async () => {
    const { repo, store, review } = await setup();
    const t = await createThread(store, review, {
      severity: "blocking",
      body: "x",
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 3, endLine: 3, origin: { kind: "version", n: 1 } },
    });
    repo.git("mv", "src/a.py", "src/b.py");
    repo.commit({ "src/b.py": "top\n" + numbered(30) });
    let r = await refreshed(store, review);
    expect(await new Locator(store, r).locate(t.anchor!, r.versions[1].head)).toEqual({
      outdated: false,
      path: "src/b.py",
      startLine: 4,
      endLine: 4,
    });
    repo.git("rm", "-q", "src/b.py");
    repo.commit({});
    r = await refreshed(store, review);
    expect((await new Locator(store, r).locate(t.anchor!, r.versions[2].head)).outdated).toBe(true);
  });

  test("working-tree anchors map to the next committed version and to the current working tree", async () => {
    const { repo, store, review } = await setup();
    repo.write("src/a.py", "fix\n" + numbered(30));
    const t = await createThread(store, review, {
      severity: "blocking",
      body: "this fix is wrong",
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 5, endLine: 6, origin: { kind: "worktree" } },
    });
    repo.write("src/a.py", "fix\nmore\n" + numbered(30));
    let r = await refreshed(store, review);
    expect(await new Locator(store, r).locate(t.anchor!, null)).toEqual({ outdated: false, path: "src/a.py", startLine: 6, endLine: 7 });

    repo.commit({});
    r = await refreshed(store, review);
    expect(await new Locator(store, r).locate(t.anchor!, r.versions[1].head)).toEqual({
      outdated: false,
      path: "src/a.py",
      startLine: 6,
      endLine: 7,
    });
  });

  test("old-side anchors map between base contents", async () => {
    const { repo, store, review } = await setup();
    const t = await createThread(store, review, {
      severity: "question",
      body: "x",
      author: "user",
      anchor: { path: "src/a.py", side: "old", startLine: 2, endLine: 2, origin: { kind: "version", n: 1 } },
    });
    repo.git("checkout", "-q", "main");
    repo.commit({ "src/a.py": "head\n" + numbered(30, "orig") });
    repo.git("checkout", "-q", "feat");
    repo.git("merge", "-q", "--no-edit", "-X", "theirs", "main");
    const r = await refreshed(store, review);
    expect(await new Locator(store, r).locate(t.anchor!, r.versions[1].base)).toEqual({
      outdated: false,
      path: "src/a.py",
      startLine: 3,
      endLine: 3,
    });
  });
});

describe("suggestions", () => {
  const suggestionBody = (text: string) => "Try this:\n```suggestion\n" + text + "\n```\n";

  test("extraction and applicable suggestion", async () => {
    expect(extractSuggestions(suggestionBody("a\nb"))).toEqual(["a\nb"]);
    expect(extractSuggestions("```suggestion\n```\n")).toEqual([""]);
    expect(extractSuggestions("```python\nx\n```")).toEqual([]);
    const { store, review } = await setup();
    const t = await createThread(store, review, { severity: "suggestion", body: suggestionBody("one"), author: "user" });
    const t2 = await addMessage(store, review.id, t.id, "user", suggestionBody("x") + suggestionBody("y"));
    expect(applicableSuggestion(t2)).toBe("one");
    const t3 = await addMessage(store, review.id, t.id, "user", suggestionBody("two"));
    expect(applicableSuggestion(t3)).toBe("two");
  });

  test("applies on unchanged code, marks addressed, stages nothing", async () => {
    const { repo, store, review } = await setup();
    const t = await createThread(store, review, {
      severity: "suggestion",
      body: suggestionBody("LINE TEN\nLINE TEN BIS"),
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 10, endLine: 11, origin: { kind: "version", n: 1 } },
    });
    repo.write("src/a.py", "shifted\n" + numbered(30));
    const plan = await applySuggestion(store, review, t, "claude");
    expect(plan).toMatchObject({ path: "src/a.py", startLine: 11, endLine: 12 });
    const expected = splitLines("shifted\n" + numbered(30));
    expected.splice(10, 2, "LINE TEN", "LINE TEN BIS");
    expect(repo.read("src/a.py")).toBe(expected.join("\n") + "\n");
    expect((await store.readThread(review.id, t.id)).status).toBe("addressed");
    expect(repo.git("diff", "--cached", "--name-only")).toBe("");
  });

  test("preserves CRLF line endings", async () => {
    const { store, review } = await setup("a\r\nb\r\nc\r\n");
    const t = await createThread(store, review, {
      severity: "suggestion",
      body: suggestionBody("B"),
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 2, endLine: 2, origin: { kind: "version", n: 1 } },
    });
    const plan = await planSuggestion(store, review, t);
    expect(plan.newContent).toBe("a\r\nB\r\nc\r\n");
  });

  test("refuses when the code changed, on general threads, on old side, without suggestion", async () => {
    const { repo, store, review } = await setup();
    const t = await createThread(store, review, {
      severity: "suggestion",
      body: suggestionBody("X"),
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 10, endLine: 10, origin: { kind: "version", n: 1 } },
    });
    repo.write("src/a.py", numbered(30).replace("line 10\n", "line 10 edited\n"));
    const before = repo.read("src/a.py");
    await expect(applySuggestion(store, review, t, "user")).rejects.toThrow(/changed since the comment/);
    expect(repo.read("src/a.py")).toBe(before);
    expect((await store.readThread(review.id, t.id)).status).toBe("open");

    const general = await createThread(store, review, { severity: "suggestion", body: suggestionBody("X"), author: "user" });
    await expect(planSuggestion(store, review, general)).rejects.toThrow(/general thread/);
    const old = await createThread(store, review, {
      severity: "suggestion",
      body: suggestionBody("X"),
      author: "user",
      anchor: { path: "src/a.py", side: "old", startLine: 1, endLine: 1, origin: { kind: "version", n: 1 } },
    });
    await expect(planSuggestion(store, review, old)).rejects.toThrow(/old-side/);
    const none = await createThread(store, review, {
      severity: "suggestion",
      body: "no block",
      author: "user",
      anchor: { path: "src/a.py", side: "new", startLine: 1, endLine: 1, origin: { kind: "version", n: 1 } },
    });
    await expect(planSuggestion(store, review, none)).rejects.toThrow(/no applicable suggestion/);
  });
});
