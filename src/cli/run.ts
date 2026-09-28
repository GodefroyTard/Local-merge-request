import * as path from "node:path";
import {
  applicableSuggestion,
  applySuggestion,
  addMessage,
  Author,
  createReview,
  latestVersion,
  Locator,
  Location,
  refreshAll,
  refreshReview,
  resolveCommit,
  Review,
  ReviewError,
  setReviewState,
  setStatus,
  STATUSES,
  Store,
  Thread,
  ThreadStatus,
} from "../core";
import { GitError } from "../core/git";
import { checkFlags, flag, hasFlag, ParsedArgs, parseArgs, UsageError } from "./args";

export interface Io {
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  readStdin: () => Promise<string | null>;
}

const USAGE = `Usage: lreview [--repo <path>] [--json] <command> [...]

Commands:
  create --from <ref> --to <ref> [--title <text>]   create a review
  list [--all]                                      list open reviews (all with --all)
  show [review] [--status <status>]...              show threads (non-resolved by default)
  reply <thread> [message|-]                        add a message (stdin when omitted or "-")
  address <thread> [message|-]                      optionally reply ("-": stdin), then mark addressed
  status <thread> <open|addressed|resolved>         change a thread status
  apply-suggestion <thread>                         apply the thread's suggestion to the working tree
  close [review] | reopen [review]                  close or reopen a review
  delete <review> --yes                             delete a review

Options:
  --repo <path>   repository (default: current directory)
  --json          machine-readable output
  --as user       act as the user instead of claude (reply, address, status, apply-suggestion)

A review is an id or unique prefix; when omitted, the only open review whose --to
resolves to HEAD is used. A thread is an id or unique prefix.`;

const short = (sha: string) => sha.slice(0, 8);

function author(args: ParsedArgs): Author {
  const as = flag(args, "as");
  if (as === undefined || as === "claude") return "claude";
  if (as === "user") return "user";
  throw new UsageError(`--as expects "user" or "claude"`);
}

async function messageArg(args: ParsedArgs, index: number, io: Io, required: boolean): Promise<string | null> {
  const given = args.positionals[index];
  if (given !== undefined && given !== "-") return given;
  // Without "-", only read stdin when the message is mandatory, so `address <t>` never waits on an open pipe.
  if (given === undefined && !required) return null;
  const stdin = await io.readStdin();
  if (stdin !== null && stdin.trim()) return stdin;
  if (required) throw new UsageError("a message is required (argument or stdin)");
  return null;
}

async function pickReview(store: Store, ref: string | undefined): Promise<Review> {
  if (ref) return store.readReview(await store.resolveReviewId(ref));
  const head = await resolveCommit(store.repo, "HEAD");
  const candidates: Review[] = [];
  const open = (await store.listReviews()).filter((r) => r.state === "open");
  for (const r of open) {
    if (head && (await resolveCommit(store.repo, r.to)) === head) candidates.push(r);
  }
  if (candidates.length === 1) return candidates[0];
  const list = (candidates.length ? candidates : open).map((r) => `  ${r.id}  ${r.title}  (${r.from}..${r.to})`).join("\n");
  if (candidates.length > 1) throw new ReviewError(`several open reviews target HEAD, pass one:\n${list}`);
  throw new ReviewError(open.length ? `no open review targets HEAD, pass one:\n${list}` : "no open review");
}

function counts(threads: Thread[]): Record<ThreadStatus, number> {
  const c = { open: 0, addressed: 0, resolved: 0 };
  for (const t of threads) c[t.status]++;
  return c;
}

function describeLocation(t: Thread, loc: Location | null): string {
  if (!t.anchor) return "general";
  if (t.anchor.side === "old") return `${t.anchor.path}:${t.anchor.startLine}-${t.anchor.endLine} (old side of v${originVersion(t)})`;
  if (!loc || loc.outdated) return `${t.anchor.path} (OUTDATED)`;
  return `${loc.path}:${loc.startLine}-${loc.endLine}`;
}

function originVersion(t: Thread): string {
  const o = t.anchor!.origin;
  return o.kind === "version" ? String(o.n) : `${o.baseVersion}+worktree`;
}

const indent = (text: string, prefix = "    │ ") =>
  text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");

async function cmdCreate(store: Store, args: ParsedArgs, io: Io, json: boolean) {
  checkFlags(args, ["repo", "json", "from", "to", "title"]);
  const from = flag(args, "from");
  const to = flag(args, "to");
  if (!from || !to) throw new UsageError("create requires --from and --to");
  const review = await createReview(store, { from, to, title: flag(args, "title") });
  io.out(json ? JSON.stringify(review, null, 2) : `created review ${review.id} "${review.title}" (${from}..${to})`);
}

async function cmdList(store: Store, args: ParsedArgs, io: Io, json: boolean) {
  checkFlags(args, ["repo", "json", "all"]);
  const reviews = await refreshAll(store, hasFlag(args, "all"));
  const rows = [];
  for (const r of reviews) rows.push({ ...r, threadCounts: counts(await store.listThreads(r.id)) });
  if (json) return io.out(JSON.stringify(rows, null, 2));
  if (!rows.length) return io.out("no review");
  for (const r of rows) {
    const c = r.threadCounts;
    const flags = [r.state === "closed" ? "closed" : "", r.missingRef ? "missing ref" : ""].filter(Boolean).join(", ");
    io.out(
      `${r.id}  ${r.title}  ${r.from}..${r.to}  v${r.versions.length}  open ${c.open} / addressed ${c.addressed} / resolved ${c.resolved}${flags ? `  [${flags}]` : ""}`,
    );
  }
}

async function cmdShow(store: Store, args: ParsedArgs, io: Io, json: boolean) {
  checkFlags(args, ["repo", "json", "status"]);
  const statuses = (args.flags.get("status") ?? ["open", "addressed"]) as ThreadStatus[];
  for (const s of statuses) if (!STATUSES.includes(s)) throw new UsageError(`invalid status "${s}"`);
  const picked = await pickReview(store, args.positionals[1]);
  const review = picked.state === "open" ? (await refreshReview(store, picked.id)).review : picked;
  const all = await store.listThreads(review.id);
  const threads = all.filter((t) => statuses.includes(t.status));
  const locator = new Locator(store, review);
  const items = [];
  for (const t of threads) {
    const location = t.anchor && t.anchor.side === "new" ? await locator.locate(t.anchor, null) : null;
    items.push({ ...t, location, suggestion: applicableSuggestion(t) });
  }
  if (json) return io.out(JSON.stringify({ review, threadCounts: counts(all), threads: items }, null, 2));

  const v = latestVersion(review);
  const c = counts(all);
  io.out(`Review ${review.id} "${review.title}"  ${review.from}..${review.to}${review.missingRef ? "  [missing ref]" : ""}`);
  io.out(`Latest version v${v.n}: ${short(v.base)}..${short(v.head)}   threads: open ${c.open} / addressed ${c.addressed} / resolved ${c.resolved}`);
  io.out(`Repository: ${store.repo}`);
  if (!items.length) return io.out(`\nno thread with status ${statuses.join(" or ")}`);
  for (const t of items) {
    io.out(`\n── ${t.id}  [${t.severity}] ${t.status}  ${describeLocation(t, t.location)}`);
    if (t.anchor) {
      io.out(`  anchored on v${originVersion(t)}, ${t.anchor.side} side, ${t.anchor.path}:${t.anchor.startLine}-${t.anchor.endLine}:`);
      io.out(indent(t.anchor.lines.join("\n")));
    }
    for (const m of t.messages) {
      io.out(`  ${m.author} (${m.at}):`);
      io.out(indent(m.body.replace(/\n$/, ""), "    "));
    }
    if (t.suggestion !== null) {
      io.out("  applicable suggestion:");
      io.out(indent(t.suggestion));
    }
  }
}

async function cmdReply(store: Store, args: ParsedArgs, io: Io, json: boolean, address: boolean) {
  checkFlags(args, ["repo", "json", "as"]);
  const ref = args.positionals[1];
  if (!ref) throw new UsageError(`${address ? "address" : "reply"} requires a thread`);
  const who = author(args);
  const { reviewId, thread } = await store.findThread(ref);
  const body = await messageArg(args, 2, io, !address);
  let t = thread;
  if (address && !["open", "addressed"].includes(t.status)) {
    throw new ReviewError(`thread ${t.id} is ${t.status}; only open threads can be addressed`);
  }
  if (body !== null) t = await addMessage(store, reviewId, t.id, who, body);
  if (address) t = await setStatus(store, reviewId, t.id, "addressed", who);
  io.out(json ? JSON.stringify(t, null, 2) : `thread ${t.id}: ${t.status}, ${t.messages.length} message(s)`);
}

async function cmdStatus(store: Store, args: ParsedArgs, io: Io, json: boolean) {
  checkFlags(args, ["repo", "json", "as"]);
  const [, ref, status] = args.positionals;
  if (!ref || !status) throw new UsageError("status requires a thread and a status");
  if (!STATUSES.includes(status as ThreadStatus)) throw new UsageError(`invalid status "${status}"`);
  const { reviewId, thread } = await store.findThread(ref);
  const t = await setStatus(store, reviewId, thread.id, status as ThreadStatus, author(args));
  io.out(json ? JSON.stringify(t, null, 2) : `thread ${t.id}: ${t.status}`);
}

async function cmdApply(store: Store, args: ParsedArgs, io: Io, json: boolean) {
  checkFlags(args, ["repo", "json", "as"]);
  const ref = args.positionals[1];
  if (!ref) throw new UsageError("apply-suggestion requires a thread");
  const { reviewId, thread } = await store.findThread(ref);
  const review = await store.readReview(reviewId);
  const plan = await applySuggestion(store, review, thread, author(args));
  const summary = { thread: thread.id, path: plan.path, startLine: plan.startLine, endLine: plan.endLine, replacement: plan.replacement };
  io.out(
    json
      ? JSON.stringify(summary, null, 2)
      : `applied suggestion of ${thread.id} to ${path.join(store.repo, plan.path)}:${plan.startLine}-${plan.endLine}`,
  );
}

async function cmdState(store: Store, args: ParsedArgs, io: Io, json: boolean, state: Review["state"]) {
  checkFlags(args, ["repo", "json"]);
  const review = await pickReview(store, args.positionals[1]);
  const r = await setReviewState(store, review.id, state);
  io.out(json ? JSON.stringify(r, null, 2) : `review ${r.id} ${r.state}`);
}

async function cmdDelete(store: Store, args: ParsedArgs, io: Io, json: boolean) {
  checkFlags(args, ["repo", "json", "yes"]);
  const ref = args.positionals[1];
  if (!ref) throw new UsageError("delete requires a review id");
  const id = await store.resolveReviewId(ref);
  if (!hasFlag(args, "yes")) throw new UsageError(`refusing to delete review ${id} without --yes`);
  await store.deleteReview(id);
  io.out(json ? JSON.stringify({ deleted: id }) : `deleted review ${id}`);
}

export async function run(argv: string[], io: Io): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`lreview: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const command = args.positionals[0];
  if (!command || command === "help" || hasFlag(args, "help")) {
    io.out(USAGE);
    return command || hasFlag(args, "help") ? 0 : 2;
  }
  const json = hasFlag(args, "json");
  try {
    const store = await Store.open(path.resolve(io.cwd, flag(args, "repo") ?? "."));
    switch (command) {
      case "create":
        await cmdCreate(store, args, io, json);
        break;
      case "list":
        await cmdList(store, args, io, json);
        break;
      case "show":
        await cmdShow(store, args, io, json);
        break;
      case "reply":
        await cmdReply(store, args, io, json, false);
        break;
      case "address":
        await cmdReply(store, args, io, json, true);
        break;
      case "status":
        await cmdStatus(store, args, io, json);
        break;
      case "apply-suggestion":
        await cmdApply(store, args, io, json);
        break;
      case "close":
        await cmdState(store, args, io, json, "closed");
        break;
      case "reopen":
        await cmdState(store, args, io, json, "open");
        break;
      case "delete":
        await cmdDelete(store, args, io, json);
        break;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`lreview: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof ReviewError || err instanceof GitError) {
      io.err(`lreview: ${err.message}`);
      return 1;
    }
    io.err(`lreview: ${(err as Error).stack ?? err}`);
    return 1;
  }
}
