import { FSWatcher, promises as fs, watch } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  FileChange,
  getVersion,
  latestVersion,
  LineStats,
  Location,
  Locator,
  refreshReview,
  Review,
  Store,
  Thread,
  View,
  viewFiles,
  viewSides,
  viewStats,
} from "../core";

export interface RepoState {
  root: string;
  store: Store;
  reviews: Review[];
  threads: Map<string, Thread[]>;
}

export interface PlacedThread {
  thread: Thread;
  /** Where the thread is displayed inline in this view, or null (general, outdated, old side outside the full view). */
  location: Extract<Location, { outdated: false }> | null;
  outdated: boolean;
  /** File path the thread is listed under, null for general threads. */
  path: string | null;
}

export interface ViewData {
  view: View;
  left: string;
  right: string | null;
  files: FileChange[];
  stats: Map<string, LineStats>;
  threads: PlacedThread[];
}

const VIEWS_KEY = "lreview.views";
const SEEN_KEY = "lreview.seenVersions";
const TREE_LAYOUT_KEY = "lreview.treeLayout";

export function viewLabel(review: Review, view: View): string {
  const latest = latestVersion(review).n;
  switch (view.kind) {
    case "full":
      return view.version === latest ? vscode.l10n.t("full v{0}", latest) : vscode.l10n.t("full v{0} (older)", view.version);
    case "interdiff":
      return vscode.l10n.t("v{0} → v{1}", view.from, view.to);
    case "worktree":
      return vscode.l10n.t("in progress (v{0} + local changes)", latest);
  }
}

/** Loads reviews of every repository of the workspace and keeps them in sync with the store and git. */
export class ReviewManager implements vscode.Disposable {
  private readonly repos = new Map<string, RepoState>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly reloads = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly signatures = new Map<string, string>();
  private viewCache = new Map<string, Promise<ViewData>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  /** Working-tree files opened from an in-progress view: fsPath -> review. */
  readonly worktreeDocs = new Map<string, { repo: string; review: string }>();
  showClosed = false;

  constructor(private readonly memento: vscode.Memento) {}

  dispose(): void {
    this.watchers.forEach((w) => w.close());
    this.watchers.clear();
    this.timers.forEach((t) => clearTimeout(t));
    this.changed.dispose();
  }

  get repositories(): RepoState[] {
    return [...this.repos.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  repo(root: string): RepoState | undefined {
    return this.repos.get(root);
  }

  review(root: string, id: string): Review | undefined {
    return this.repos.get(root)?.reviews.find((r) => r.id === id);
  }

  threads(root: string, id: string): Thread[] {
    return this.repos.get(root)?.threads.get(id) ?? [];
  }

  async addRepository(fsPath: string): Promise<void> {
    let store: Store;
    try {
      store = await Store.open(fsPath);
    } catch {
      return;
    }
    if (this.repos.has(store.repo)) return;
    this.repos.set(store.repo, { root: store.repo, store, reviews: [], threads: new Map() });
    await fs.mkdir(store.root, { recursive: true });
    try {
      const watcher = watch(store.root, { recursive: true }, () => this.schedule(store.repo, false, 200));
      this.watchers.set(store.repo, watcher);
    } catch (err) {
      console.error(`local-review: cannot watch ${store.root}`, err);
    }
    await this.reload(store.repo, true);
  }

  removeRepository(fsPath: string): void {
    for (const root of [...this.repos.keys()]) {
      if (path.resolve(root) === path.resolve(fsPath)) {
        this.watchers.get(root)?.close();
        this.watchers.delete(root);
        this.repos.delete(root);
        this.signatures.delete(root);
      }
    }
    this.invalidate();
  }

  /** Debounced reload; `versions` also re-resolves refs (git state changed). */
  schedule(root: string, versions: boolean, delay: number): void {
    const key = `${root}|${versions}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.reload(root, versions);
      }, delay),
    );
  }

  async reloadAll(versions: boolean): Promise<void> {
    await Promise.all([...this.repos.keys()].map((r) => this.reload(r, versions)));
  }

  reload(root: string, versions: boolean): Promise<void> {
    const previous = this.reloads.get(root) ?? Promise.resolve();
    const next = previous.then(() => this.doReload(root, versions)).catch((err) => console.error("local-review: reload failed", err));
    this.reloads.set(root, next);
    return next;
  }

  private async doReload(root: string, versions: boolean): Promise<void> {
    const state = this.repos.get(root);
    if (!state) return;
    let reviews = await state.store.listReviews();
    if (versions) {
      reviews = await Promise.all(
        reviews.map(async (r) => (r.state === "open" ? (await refreshReview(state.store, r.id)).review : r)),
      );
    }
    const threads = new Map<string, Thread[]>();
    for (const r of reviews) threads.set(r.id, await state.store.listThreads(r.id));
    const signature = JSON.stringify([reviews, [...threads]]);
    if (signature === this.signatures.get(root)) return;
    this.signatures.set(root, signature);
    state.reviews = reviews;
    state.threads = threads;
    this.invalidate();
  }

  /** Drops cached view data and notifies listeners. */
  invalidate(): void {
    this.viewCache = new Map();
    this.changed.fire();
  }

  // ---- per-review UI state -------------------------------------------------

  /** Selected view; null means "latest full version". */
  private storedView(id: string): View | null {
    return this.memento.get<Record<string, View>>(VIEWS_KEY, {})[id] ?? null;
  }

  view(review: Review): View {
    const stored = this.storedView(review.id);
    if (!stored) return { kind: "full", version: latestVersion(review).n };
    try {
      if (stored.kind === "full") getVersion(review, stored.version);
      if (stored.kind === "interdiff") {
        getVersion(review, stored.from);
        getVersion(review, stored.to);
      }
      return stored;
    } catch {
      return { kind: "full", version: latestVersion(review).n };
    }
  }

  async setView(review: Review, view: View | null): Promise<void> {
    const views = { ...this.memento.get<Record<string, View>>(VIEWS_KEY, {}) };
    if (view) views[review.id] = view;
    else delete views[review.id];
    await this.memento.update(VIEWS_KEY, views);
    await this.markSeen(review);
    this.invalidate();
  }

  hasUnseenVersion(review: Review): boolean {
    const seen = this.memento.get<Record<string, number>>(SEEN_KEY, {})[review.id] ?? 1;
    return latestVersion(review).n > seen;
  }

  async markSeen(review: Review): Promise<void> {
    const seen = { ...this.memento.get<Record<string, number>>(SEEN_KEY, {}) };
    if (seen[review.id] === latestVersion(review).n) return;
    seen[review.id] = latestVersion(review).n;
    await this.memento.update(SEEN_KEY, seen);
  }

  get treeLayout(): boolean {
    return this.memento.get<boolean>(TREE_LAYOUT_KEY, true);
  }

  async setTreeLayout(tree: boolean): Promise<void> {
    await this.memento.update(TREE_LAYOUT_KEY, tree);
    this.changed.fire();
  }

  // ---- view data -----------------------------------------------------------

  viewData(root: string, review: Review): Promise<ViewData> {
    const view = this.view(review);
    const key = `${root}|${review.id}|${JSON.stringify(view)}`;
    let data = this.viewCache.get(key);
    if (!data) {
      data = this.computeViewData(root, review, view);
      // The working tree changes without notifying the store: do not cache it.
      if (view.kind !== "worktree") this.viewCache.set(key, data);
      data.catch(() => this.viewCache.delete(key));
    }
    return data;
  }

  private async computeViewData(root: string, review: Review, view: View): Promise<ViewData> {
    const state = this.repos.get(root)!;
    const { left, right } = viewSides(review, view);
    const [files, stats] = await Promise.all([viewFiles(state.store, review, view), viewStats(state.store, review, view)]);
    const locator = new Locator(state.store, review);
    const threads: PlacedThread[] = [];
    for (const thread of this.threads(root, review.id)) {
      const anchor = thread.anchor;
      if (!anchor) {
        threads.push({ thread, location: null, outdated: false, path: null });
        continue;
      }
      if (anchor.side === "old" && view.kind !== "full") {
        threads.push({ thread, location: null, outdated: false, path: anchor.path });
        continue;
      }
      let loc: Location;
      try {
        loc = await locator.locate(anchor, anchor.side === "new" ? right : left);
      } catch {
        loc = { outdated: true, path: anchor.path };
      }
      threads.push(
        loc.outdated
          ? { thread, location: null, outdated: true, path: anchor.path }
          : { thread, location: loc, outdated: false, path: loc.path },
      );
    }
    return { view, left, right, files, stats, threads };
  }
}
