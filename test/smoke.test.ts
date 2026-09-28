import { expect, test } from "vitest";
import { TestRepo } from "./helpers";

test("helper creates a repository with commits and a worktree", () => {
  const repo = TestRepo.create();
  repo.commit({ "a.txt": "a\n" });
  repo.git("branch", "feat");
  const wt = repo.addWorktree("feat");
  expect(repo.git("log", "--oneline").split("\n")).toHaveLength(1);
  expect(wt).toContain("-wt-feat");
});
