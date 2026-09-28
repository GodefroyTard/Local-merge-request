import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

export class TestRepo {
  constructor(readonly dir: string) {}

  static create(): TestRepo {
    const root = mkdtempSync(path.join(tmpdir(), "lreview-test-"));
    created.push(root);
    const dir = path.join(root, "repo");
    mkdirSync(dir);
    const repo = new TestRepo(dir);
    repo.git("init", "-q", "-b", "main");
    repo.git("config", "user.email", "test@example.com");
    repo.git("config", "user.name", "Test");
    repo.git("config", "commit.gpgsign", "false");
    return repo;
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8" }).trim();
  }

  write(file: string, content: string): void {
    const full = path.join(this.dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  read(file: string): string {
    return readFileSync(path.join(this.dir, file), "utf8");
  }

  commit(files: Record<string, string>, message = "commit"): string {
    for (const [f, c] of Object.entries(files)) this.write(f, c);
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  /** Creates a linked worktree next to the repository and returns its path. */
  addWorktree(branch: string): string {
    const wt = `${this.dir}-wt-${branch.replace(/\W/g, "_")}`;
    this.git("worktree", "add", "-q", wt, branch);
    return wt;
  }

  status(): string {
    return this.git("status", "--porcelain");
  }
}

export const lines = (...ls: string[]) => ls.map((l) => l + "\n").join("");
export const numbered = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join("");
