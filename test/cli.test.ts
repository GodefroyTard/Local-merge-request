import { describe, expect, test } from "vitest";
import { run } from "../src/cli/run";
import { createThread, Store } from "../src/core";
import { numbered, TestRepo } from "./helpers";

async function lreview(repo: TestRepo, argv: string[], stdin: string | null = null) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: repo.dir,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    readStdin: async () => stdin,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function jsonOf(repo: TestRepo, argv: string[]) {
  const r = await lreview(repo, [...argv, "--json"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out);
}

function setup() {
  const repo = TestRepo.create();
  repo.commit({ "src/a.py": numbered(30, "orig") });
  repo.git("checkout", "-q", "-b", "feat");
  repo.commit({ "src/a.py": numbered(30) });
  return repo;
}

async function threadOn(repo: TestRepo, reviewId: string, body = "fix it", startLine = 10, endLine = 14) {
  const store = await Store.open(repo.dir);
  return createThread(store, await store.readReview(reviewId), {
    severity: "blocking",
    body,
    author: "user",
    anchor: { path: "src/a.py", side: "new", startLine, endLine, origin: { kind: "version", n: 1 } },
  });
}

describe("general behaviour", () => {
  test("help, usage errors and exit codes", async () => {
    const repo = setup();
    expect((await lreview(repo, ["--help"])).code).toBe(0);
    expect((await lreview(repo, [])).code).toBe(2);
    const bad = await lreview(repo, ["frobnicate"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/unknown command/);
    expect((await lreview(repo, ["list", "--bogus"])).code).toBe(2);
    const notRepo = await run(["list"], { cwd: "/", out: () => {}, err: () => {}, readStdin: async () => null });
    expect(notRepo).toBe(1);
  });

  test("--repo targets another repository", async () => {
    const repo = setup();
    const other = TestRepo.create();
    other.commit({ "x": "x\n" });
    const r = await run(["create", "--repo", repo.dir, "--from", "main", "--to", "feat"], {
      cwd: other.dir,
      out: () => {},
      err: () => {},
      readStdin: async () => null,
    });
    expect(r).toBe(0);
    expect(await jsonOf(repo, ["list"])).toHaveLength(1);
  });
});

describe("create, list and lifecycle", () => {
  test("create then list with counts; JSON output is pure", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat", "--title", "My review"]);
    expect(review).toMatchObject({ title: "My review", from: "main", to: "feat" });
    const t1 = await threadOn(repo, review.id);
    await threadOn(repo, review.id, "second");
    const t3 = await threadOn(repo, review.id, "third");
    await lreview(repo, ["status", t1.id, "addressed"]);
    await lreview(repo, ["status", t3.id, "resolved", "--as", "user"]);
    const [row] = await jsonOf(repo, ["list"]);
    expect(row.threadCounts).toEqual({ open: 1, addressed: 1, resolved: 1 });
    const text = await lreview(repo, ["list"]);
    expect(text.out).toMatch(/open 1 \/ addressed 1 \/ resolved 1/);
  });

  test("list refreshes versions", async () => {
    const repo = setup();
    await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    repo.commit({ "b.txt": "b\n" });
    const [row] = await jsonOf(repo, ["list"]);
    expect(row.versions).toHaveLength(2);
  });

  test("create errors", async () => {
    const repo = setup();
    const r = await lreview(repo, ["create", "--from", "main", "--to", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/"nope"/);
    expect((await lreview(repo, ["create", "--from", "main"])).code).toBe(2);
  });

  test("close, reopen, list --all and delete --yes", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    await jsonOf(repo, ["close", review.id]);
    expect(await jsonOf(repo, ["list"])).toEqual([]);
    expect(await jsonOf(repo, ["list", "--all"])).toHaveLength(1);
    await jsonOf(repo, ["reopen", review.id.slice(0, 4)]);
    const refused = await lreview(repo, ["delete", review.id]);
    expect(refused.code).not.toBe(0);
    expect(await jsonOf(repo, ["list"])).toHaveLength(1);
    await jsonOf(repo, ["delete", review.id, "--yes"]);
    expect(await jsonOf(repo, ["list", "--all"])).toEqual([]);
  });
});

describe("review resolution", () => {
  test("implicit review targeting HEAD, and ambiguity", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    expect((await jsonOf(repo, ["show"])).review.id).toBe(review.id);
    const second = await jsonOf(repo, ["create", "--from", "main", "--to", "HEAD", "--title", "other"]);
    const r = await lreview(repo, ["show"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(review.id);
    expect(r.err).toContain(second.id);
  });
});

describe("show", () => {
  test("locates threads in the working tree and marks outdated ones", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    const moved = await threadOn(repo, review.id, "moved", 10, 14);
    const changed = await threadOn(repo, review.id, "changed", 25, 25);
    repo.write("src/a.py", "x\ny\n" + numbered(30).replace("line 25\n", "line 25 edited\n"));
    const shown = await jsonOf(repo, ["show"]);
    const byId = Object.fromEntries(shown.threads.map((t: { id: string }) => [t.id, t]));
    expect(byId[moved.id].location).toEqual({ outdated: false, path: "src/a.py", startLine: 12, endLine: 16 });
    expect(byId[changed.id].location).toEqual({ outdated: true, path: "src/a.py" });

    const text = await lreview(repo, ["show"]);
    expect(text.out).toContain(`${moved.id}  [blocking] open  src/a.py:12-16`);
    expect(text.out).toContain("src/a.py (OUTDATED)");
    expect(text.out).toContain("line 25");
  });

  test("filters by status, resolved hidden by default, shows suggestions", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    const t = await threadOn(repo, review.id, "```suggestion\nnew line\n```");
    const done = await threadOn(repo, review.id, "done");
    await lreview(repo, ["status", done.id, "resolved", "--as", "user"]);
    const shown = await jsonOf(repo, ["show"]);
    expect(shown.threads.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect(shown.threads[0].suggestion).toBe("new line");
    expect((await jsonOf(repo, ["show", "--status", "resolved"])).threads.map((x: { id: string }) => x.id)).toEqual([done.id]);
    expect((await lreview(repo, ["show", "--status", "weird"])).code).toBe(2);
  });
});

describe("replying and statuses", () => {
  test("reply from argument or stdin, as claude by default", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    const t = await threadOn(repo, review.id);
    const a = await jsonOf(repo, ["reply", t.id.slice(0, 5), "Done."]);
    expect(a.messages[1]).toMatchObject({ author: "claude", body: "Done." });
    const b = await lreview(repo, ["reply", t.id, "--json"], "from stdin\n");
    expect(JSON.parse(b.out).messages[2]).toMatchObject({ author: "claude", body: "from stdin\n" });
    const c = await lreview(repo, ["reply", t.id]);
    expect(c.code).toBe(2);
    const u = await jsonOf(repo, ["reply", t.id, "mine", "--as", "user"]);
    expect(u.messages[3].author).toBe("user");
  });

  test("address with message marks addressed; resolution refused as claude", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    const t = await threadOn(repo, review.id);
    const a = await jsonOf(repo, ["address", t.id, "Renamed as requested."]);
    expect(a.status).toBe("addressed");
    expect(a.messages[1]).toMatchObject({ author: "claude", body: "Renamed as requested." });
    const refused = await lreview(repo, ["status", t.id, "resolved"]);
    expect(refused.code).toBe(1);
    const store = await Store.open(repo.dir);
    expect((await store.readThread(review.id, t.id)).status).toBe("addressed");
    expect((await jsonOf(repo, ["status", t.id, "resolved", "--as", "user"])).status).toBe("resolved");
    expect((await lreview(repo, ["address", t.id])).code).toBe(1);
  });

  test("address without message never reads stdin", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    const t = await threadOn(repo, review.id);
    const r = await run(["address", t.id, "--json"], {
      cwd: repo.dir,
      out: () => {},
      err: () => {},
      readStdin: () => new Promise(() => {}),
    });
    expect(r).toBe(0);
  });
});

describe("apply-suggestion", () => {
  test("applies and marks addressed, or fails with the reason", async () => {
    const repo = setup();
    const review = await jsonOf(repo, ["create", "--from", "main", "--to", "feat"]);
    const ok = await threadOn(repo, review.id, "```suggestion\nLINE 10\n```", 10, 10);
    const ko = await threadOn(repo, review.id, "```suggestion\nLINE 20\n```", 20, 20);
    repo.write("src/a.py", numbered(30).replace("line 20\n", "line 20 edited\n"));

    const applied = await jsonOf(repo, ["apply-suggestion", ok.id]);
    expect(applied).toMatchObject({ path: "src/a.py", startLine: 10, endLine: 10, replacement: ["LINE 10"] });
    expect(repo.read("src/a.py")).toContain("LINE 10\n");
    expect(repo.git("diff", "--cached", "--name-only")).toBe("");

    const refused = await lreview(repo, ["apply-suggestion", ko.id]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/changed since the comment/);
  });
});
