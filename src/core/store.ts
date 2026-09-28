import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { readJson, updateJson, writeFileAtomic, writeJson } from "./fsutil";
import { commonDir, topLevel } from "./git";
import { Review, ReviewError, Thread } from "./types";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newId(length = 8): string {
  const bytes = randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i++) id += ID_ALPHABET[bytes[i] % 32];
  return id;
}

/** Local reviews of one repository, stored under `<git common dir>/local-reviews/`. */
export class Store {
  private constructor(
    /** Working tree top-level the store was opened from. */
    readonly repo: string,
    readonly root: string,
  ) {}

  static async open(cwd: string): Promise<Store> {
    const repo = await topLevel(cwd);
    return new Store(repo, path.join(await commonDir(repo), "local-reviews"));
  }

  reviewDir(id: string): string {
    return path.join(this.root, id);
  }

  private reviewFile(id: string): string {
    return path.join(this.reviewDir(id), "review.json");
  }

  private threadFile(reviewId: string, threadId: string): string {
    return path.join(this.reviewDir(reviewId), "threads", `${threadId}.json`);
  }

  async listReviewIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async readReview(id: string): Promise<Review> {
    const review = await readJson<Review>(this.reviewFile(id));
    if (!review) throw new ReviewError(`review ${id} not found`);
    return review;
  }

  async listReviews(): Promise<Review[]> {
    const reviews: Review[] = [];
    for (const id of await this.listReviewIds()) {
      const review = await readJson<Review>(this.reviewFile(id));
      if (review) reviews.push(review);
    }
    return reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createReview(review: Review): Promise<void> {
    await writeJson(this.reviewFile(review.id), review);
  }

  async updateReview(id: string, fn: (r: Review) => Review | undefined | Promise<Review | undefined>): Promise<Review> {
    const result = await updateJson<Review>(this.reviewFile(id), (current) => {
      if (!current) throw new ReviewError(`review ${id} not found`);
      return fn(current);
    });
    return result!;
  }

  async deleteReview(id: string): Promise<void> {
    await fs.rm(this.reviewDir(id), { recursive: true, force: true });
  }

  /** Resolves a full id or a unique prefix. */
  async resolveReviewId(prefix: string): Promise<string> {
    const ids = await this.listReviewIds();
    if (ids.includes(prefix)) return prefix;
    const matches = ids.filter((id) => id.startsWith(prefix));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new ReviewError(`no review matches "${prefix}"`);
    throw new ReviewError(`"${prefix}" is ambiguous: ${matches.join(", ")}`);
  }

  async listThreads(reviewId: string): Promise<Thread[]> {
    const dir = path.join(this.reviewDir(reviewId), "threads");
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const threads: Thread[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const t = await readJson<Thread>(path.join(dir, name));
      if (t) threads.push(t);
    }
    return threads.sort((a, b) => (a.messages[0]?.at ?? "").localeCompare(b.messages[0]?.at ?? ""));
  }

  async readThread(reviewId: string, threadId: string): Promise<Thread> {
    const t = await readJson<Thread>(this.threadFile(reviewId, threadId));
    if (!t) throw new ReviewError(`thread ${threadId} not found in review ${reviewId}`);
    return t;
  }

  async createThread(reviewId: string, thread: Thread): Promise<void> {
    await writeJson(this.threadFile(reviewId, thread.id), thread);
  }

  async updateThread(reviewId: string, threadId: string, fn: (t: Thread) => Thread | undefined): Promise<Thread> {
    const result = await updateJson<Thread>(this.threadFile(reviewId, threadId), (current) => {
      if (!current) throw new ReviewError(`thread ${threadId} not found in review ${reviewId}`);
      return fn(current);
    });
    return result!;
  }

  async deleteThread(reviewId: string, threadId: string): Promise<void> {
    await fs.rm(this.threadFile(reviewId, threadId), { force: true });
  }

  /** Finds a thread by id or unique prefix across all reviews. */
  async findThread(prefix: string): Promise<{ reviewId: string; thread: Thread }> {
    const matches: { reviewId: string; thread: Thread }[] = [];
    for (const reviewId of await this.listReviewIds()) {
      for (const thread of await this.listThreads(reviewId)) {
        if (thread.id === prefix) return { reviewId, thread };
        if (thread.id.startsWith(prefix)) matches.push({ reviewId, thread });
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new ReviewError(`no thread matches "${prefix}"`);
    throw new ReviewError(`"${prefix}" is ambiguous: ${matches.map((m) => m.thread.id).join(", ")}`);
  }

  async putSnapshot(reviewId: string, content: string): Promise<string> {
    const hash = createHash("sha256").update(content).digest("hex");
    const file = path.join(this.reviewDir(reviewId), "snapshots", hash);
    try {
      await fs.access(file);
    } catch {
      await writeFileAtomic(file, content);
    }
    return hash;
  }

  async readSnapshot(reviewId: string, hash: string): Promise<string> {
    return fs.readFile(path.join(this.reviewDir(reviewId), "snapshots", hash), "utf8");
  }
}
