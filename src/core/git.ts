import { execFile } from "node:child_process";
import * as path from "node:path";
import { ChangeStatus, FileChange, LineStats } from "./types";

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 256 * 1024 * 1024, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === "number" ? err.code : null;
          reject(new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || err.message}`, args, stderr, code));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export async function topLevel(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function commonDir(repo: string): Promise<string> {
  const out = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return path.resolve(repo, out);
}

/** Resolves a ref to a commit SHA, or null when it does not exist. */
export async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  if (!ref || ref.startsWith("-")) return null;
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  return (await git(repo, ["merge-base", a, b])).trim();
}

/** Files changed between two commits, or between a commit and the working tree when `to` is null. */
export async function changedFiles(repo: string, from: string, to: string | null): Promise<FileChange[]> {
  const args = ["diff", "--name-status", "-M", "-z", "--no-ext-diff", from];
  if (to) args.push(to);
  const out = await git(repo, args);
  const parts = out.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++][0] as ChangeStatus;
    if (status === "R" || status === "C") {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      files.push({ status, path: newPath, oldPath });
    } else {
      const p = parts[i++];
      files.push({ status, path: p, oldPath: p });
    }
  }
  return files;
}

/** Added and removed line counts per right-side path; null counts for binary files. */
export async function diffStats(repo: string, from: string, to: string | null): Promise<Map<string, LineStats>> {
  const args = ["diff", "--numstat", "-M", "-z", "--no-ext-diff", from];
  if (to) args.push(to);
  const parts = (await git(repo, args)).split("\0");
  const stats = new Map<string, LineStats>();
  for (let i = 0; i < parts.length - 1; ) {
    const [added, removed, file] = parts[i++].split("\t");
    // Renames leave the path empty and put the old and new paths in the next two fields.
    const p = file || (i++, parts[i++]);
    stats.set(p, added === "-" ? { added: null, removed: null } : { added: Number(added), removed: Number(removed) });
  }
  return stats;
}

/** File content at a commit, or null when the path does not exist there. */
export async function showFile(repo: string, sha: string, file: string): Promise<string | null> {
  try {
    return await git(repo, ["cat-file", "blob", `${sha}:${file}`]);
  } catch {
    return null;
  }
}

export async function blobId(repo: string, sha: string, file: string): Promise<string | null> {
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", `${sha}:${file}`])).trim() || null;
  } catch {
    return null;
  }
}

/** Target of origin/HEAD, e.g. "origin/develop", or null. */
export async function defaultTarget(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

export async function currentBranch(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

export interface RefInfo {
  name: string;
  kind: "branch" | "remote" | "tag";
}

export async function listRefs(repo: string): Promise<RefInfo[]> {
  const out = await git(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const refs: RefInfo[] = [];
  for (const full of out.split("\n").filter(Boolean)) {
    if (full.endsWith("/HEAD")) continue;
    if (full.startsWith("refs/heads/")) refs.push({ name: full.slice(11), kind: "branch" });
    else if (full.startsWith("refs/remotes/")) refs.push({ name: full.slice(13), kind: "remote" });
    else if (full.startsWith("refs/tags/")) refs.push({ name: full.slice(10), kind: "tag" });
  }
  return refs;
}

export interface CommitInfo {
  sha: string;
  subject: string;
}

export async function recentCommits(repo: string, count = 30): Promise<CommitInfo[]> {
  const out = await git(repo, ["log", `-n${count}`, "--format=%H%x09%s"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha, subject: rest.join("\t") };
    });
}
