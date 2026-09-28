import { promises as fs } from "node:fs";
import * as path from "node:path";

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lock, "wx");
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function writeJson(file: string, data: unknown): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

/** Locked read-modify-write. Returning undefined from `fn` leaves the file untouched. */
export async function updateJson<T>(file: string, fn: (current: T | null) => T | undefined | Promise<T | undefined>): Promise<T | null> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  return withLock(file, async () => {
    const current = await readJson<T>(file);
    const next = await fn(current);
    if (next === undefined) return current;
    await writeJson(file, next);
    return next;
  });
}
