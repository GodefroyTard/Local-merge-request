import * as path from "node:path";
import * as vscode from "vscode";
import {
  createReview,
  currentBranch,
  defaultTarget,
  FileChange,
  latestVersion,
  listRefs,
  recentCommits,
  Review,
  setReviewState,
  setViewed,
  View,
  viewSides,
} from "../core";
import { CommentsView } from "./comments";
import { ContentProvider } from "./content";
import { getGitApi, GitRepository } from "./gitApi";
import { installCli, installSkill, refreshInstalledCli } from "./install";
import { errorMessage, formatDate } from "./labels";
import { ReviewManager, viewLabel } from "./manager";
import { Node, ReviewTree } from "./tree";
import { SCHEME, toUri } from "./uris";

type ReviewNode = Extract<Node, { type: "review" }>;

const t = vscode.l10n.t;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new ReviewManager(context.workspaceState);
  const tree = new ReviewTree(manager);
  const comments = new CommentsView(manager);
  const treeView = vscode.window.createTreeView("lreview.reviews", { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(
    treeView,
    comments,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ContentProvider(manager)),
  );
  void vscode.commands.executeCommand("setContext", "lreview.showClosed", false);

  const guard =
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (err) {
        void vscode.window.showErrorMessage(errorMessage(err));
      }
    };

  const reviewOf = (node: { repo: string; review: string }): Review => {
    const review = manager.review(node.repo, node.review);
    if (!review) throw new Error(t("review not found"));
    return review;
  };

  // ---- diffs -----------------------------------------------------------------

  const diffUris = (repo: string, review: Review, view: View, change: FileChange) => {
    const { left, right } = viewSides(review, view);
    const leftUri = toUri({
      kind: "file",
      repo,
      review: review.id,
      sha: change.status === "A" ? "" : left,
      path: change.oldPath,
      role: "left",
      anchor: view.kind === "full" && change.status !== "A" ? { side: "old", version: view.version } : undefined,
    });
    let rightUri: vscode.Uri;
    if (change.status === "D") {
      rightUri = toUri({ kind: "file", repo, review: review.id, sha: "", path: change.path, role: "right" });
    } else if (right) {
      const version = view.kind === "full" ? view.version : view.kind === "interdiff" ? view.to : latestVersion(review).n;
      rightUri = toUri({ kind: "file", repo, review: review.id, sha: right, path: change.path, role: "right", anchor: { side: "new", version } });
    } else {
      rightUri = vscode.Uri.file(path.join(repo, change.path));
      manager.worktreeDocs.set(rightUri.fsPath, { repo, review: review.id });
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === rightUri.fsPath);
      if (open) void comments.renderDoc(open, true);
    }
    return { leftUri, rightUri };
  };

  const openDiff = async (repo: string, review: Review, change: FileChange, line?: number) => {
    const view = manager.view(review);
    const { leftUri, rightUri } = diffUris(repo, review, view, change);
    const title = `${path.basename(change.path)} (${viewLabel(review, view)})`;
    const options: vscode.TextDocumentShowOptions = { preview: true };
    if (line) options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
    await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, options);
    await manager.markSeen(review);
  };

  // ---- pickers -----------------------------------------------------------------

  interface RefItem extends vscode.QuickPickItem {
    ref: string;
  }

  const pickRef = async (repo: string, title: string, fallback: string): Promise<string | undefined> => {
    const [refs, commits] = await Promise.all([listRefs(repo), recentCommits(repo, 40)]);
    const icon = { branch: "$(git-branch)", remote: "$(cloud)", tag: "$(tag)" };
    const base: RefItem[] = [
      { label: `$(star-full) ${fallback}`, description: t("default"), ref: fallback },
      ...refs.filter((r) => r.name !== fallback).map((r) => ({ label: `${icon[r.kind]} ${r.name}`, ref: r.name })),
      ...commits.map((c) => ({ label: `$(git-commit) ${c.sha.slice(0, 8)}`, description: c.subject, ref: c.sha })),
    ];
    const qp = vscode.window.createQuickPick<RefItem>();
    qp.title = title;
    qp.placeholder = t("Branch, tag, commit or any ref (e.g. HEAD~3)");
    qp.matchOnDescription = true;
    qp.items = base;
    qp.onDidChangeValue((value) => {
      const typed = value.trim();
      qp.items = typed ? [{ label: `$(edit) ${t("Use \"{0}\"", typed)}`, ref: typed, alwaysShow: true }, ...base] : base;
    });
    return new Promise((resolve) => {
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]?.ref ?? (qp.value.trim() || undefined));
        qp.hide();
      });
      qp.onDidHide(() => {
        resolve(undefined);
        qp.dispose();
      });
      qp.show();
    });
  };

  const pickRepo = async (): Promise<string | undefined> => {
    const repos = manager.repositories;
    if (repos.length === 0) throw new Error(t("no git repository in the workspace"));
    if (repos.length === 1) return repos[0].root;
    const picked = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: path.basename(r.root), description: r.root, root: r.root })),
      { placeHolder: t("Repository") },
    );
    return picked?.root;
  };

  const pickVersion = async (review: Review, placeHolder: string, exclude?: number): Promise<number | undefined> => {
    const items = [...review.versions]
      .reverse()
      .filter((v) => v.n !== exclude)
      .map((v) => ({ label: `v${v.n}`, description: `${v.head.slice(0, 8)} · ${formatDate(v.at)}`, n: v.n }));
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.n;
  };

  // ---- commands ------------------------------------------------------------------

  const register = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("lreview.refresh", guard(() => manager.reloadAll(true)));
  register(
    "lreview.showClosed",
    guard(async () => {
      manager.showClosed = true;
      await vscode.commands.executeCommand("setContext", "lreview.showClosed", true);
      tree.refresh();
    }),
  );
  register(
    "lreview.hideClosed",
    guard(async () => {
      manager.showClosed = false;
      await vscode.commands.executeCommand("setContext", "lreview.showClosed", false);
      tree.refresh();
    }),
  );

  register(
    "lreview.createReview",
    guard(async (node?: { repo: string }) => {
      const repo = node?.repo ?? (await pickRepo());
      if (!repo) return;
      const from = await pickRef(repo, t("Review base (from)"), (await defaultTarget(repo)) ?? "HEAD~1");
      if (!from) return;
      const to = await pickRef(repo, t("Ref to review (to)"), (await currentBranch(repo)) ?? "HEAD");
      if (!to) return;
      const title = await vscode.window.showInputBox({ title: t("Review title"), value: to });
      if (title === undefined) return;
      const review = await createReview(manager.repo(repo)!.store, { from, to, title });
      await manager.reload(repo, false);
      const created: ReviewNode = { type: "review", repo, review: review.id };
      await treeView.reveal(created, { expand: true, select: true }).then(undefined, () => undefined);
    }),
  );

  register(
    "lreview.selectView",
    guard(async (node: ReviewNode) => {
      const review = reviewOf(node);
      const latest = latestVersion(review).n;
      type Item = vscode.QuickPickItem & { view?: View | null; custom?: true };
      const items: Item[] = [{ label: `$(git-pull-request) ${t("Full — latest version (v{0})", latest)}`, view: null }];
      for (const v of [...review.versions].reverse().slice(1)) {
        items.push({ label: `$(history) ${t("Full — v{0}", v.n)}`, view: { kind: "full", version: v.n } });
      }
      for (const v of [...review.versions].reverse().slice(1)) {
        items.push({ label: `$(diff) ${t("Since v{0} (v{0} → v{1})", v.n, latest)}`, view: { kind: "interdiff", from: v.n, to: latest } });
      }
      if (review.versions.length > 2) items.push({ label: `$(diff-multiple) ${t("Between two versions…")}`, custom: true });
      items.push({ label: `$(edit) ${t("In progress (v{0} + local changes)", latest)}`, view: { kind: "worktree" } });
      const picked = await vscode.window.showQuickPick(items, { placeHolder: t("Current view: {0}", viewLabel(review, manager.view(review))) });
      if (!picked) return;
      let view = picked.view ?? null;
      if (picked.custom) {
        const from = await pickVersion(review, t("From version"));
        if (!from) return;
        const to = await pickVersion(review, t("To version"), from);
        if (!to) return;
        view = { kind: "interdiff", from: Math.min(from, to), to: Math.max(from, to) };
      }
      await manager.setView(review, view);
    }),
  );

  register(
    "lreview.openFile",
    guard(async (node: Extract<Node, { type: "file" }>) => {
      await openDiff(node.repo, reviewOf(node), node.change);
    }),
  );

  register(
    "lreview.openThread",
    guard(async (node: Extract<Node, { type: "thread" }>) => {
      const review = reviewOf(node);
      const { placed } = node;
      if (placed.location) {
        const data = await manager.viewData(node.repo, review);
        const onOld = placed.thread.anchor?.side === "old";
        const change =
          data.files.find((f) => (onOld ? f.oldPath : f.path) === placed.location!.path) ??
          ({ status: "M", path: placed.location.path, oldPath: placed.location.path } as FileChange);
        await openDiff(node.repo, review, change, onOld ? undefined : placed.location.startLine);
        return;
      }
      const uri =
        placed.path === null
          ? toUri({ kind: "overview", repo: node.repo, review: review.id })
          : toUri({ kind: "thread", repo: node.repo, review: review.id, thread: placed.thread.id });
      await vscode.window.showTextDocument(uri, { preview: true });
    }),
  );

  register(
    "lreview.openOverview",
    guard(async (node: ReviewNode) => {
      await vscode.window.showTextDocument(toUri({ kind: "overview", repo: node.repo, review: node.review }), { preview: true });
    }),
  );

  register(
    "lreview.openAll",
    guard(async (node: ReviewNode) => {
      const review = reviewOf(node);
      const view = manager.view(review);
      const data = await manager.viewData(node.repo, review);
      if (!data.files.length) throw new Error(t("no changed file in this view"));
      const resources = data.files.map((change) => {
        const { leftUri, rightUri } = diffUris(node.repo, review, view, change);
        return [vscode.Uri.file(path.join(node.repo, change.path)), leftUri, rightUri];
      });
      await vscode.commands.executeCommand("vscode.changes", `${review.title} (${viewLabel(review, view)})`, resources);
      await manager.markSeen(review);
      tree.refresh();
    }),
  );

  const setState = (state: Review["state"]) =>
    guard(async (node: ReviewNode) => {
      await setReviewState(manager.repo(node.repo)!.store, node.review, state);
      await manager.reload(node.repo, state === "open");
    });
  register("lreview.closeReview", setState("closed"));
  register("lreview.reopenReview", setState("open"));

  register(
    "lreview.deleteReview",
    guard(async (node: ReviewNode) => {
      const review = reviewOf(node);
      const del = t("Delete");
      const ok = await vscode.window.showWarningMessage(
        t("Delete the review \"{0}\" and all its comments?", review.title),
        { modal: true },
        del,
      );
      if (ok !== del) return;
      await manager.repo(node.repo)!.store.deleteReview(review.id);
      await manager.reload(node.repo, false);
    }),
  );

  register("lreview.installCli", guard(() => installCli(context)));
  register("lreview.installSkill", guard(() => installSkill(context)));
  void refreshInstalledCli(context);

  // ---- comment commands ---------------------------------------------------------

  register("lreview.createThread", comments.createThread);
  register("lreview.reply", comments.reply);
  register("lreview.resolveThread", (ct: vscode.CommentThread) => comments.setStatus(ct, "resolved"));
  register("lreview.reopenThread", (ct: vscode.CommentThread) => comments.setStatus(ct, "open"));
  register("lreview.markAddressed", (ct: vscode.CommentThread) => comments.setStatus(ct, "addressed"));
  register("lreview.changeSeverity", comments.changeSeverity);
  register("lreview.applySuggestion", comments.applySuggestion);
  register("lreview.editMessage", comments.editMessage);
  register("lreview.saveMessage", comments.saveMessage);
  register("lreview.cancelEdit", comments.cancelEdit);
  register("lreview.deleteMessage", comments.deleteMessage);

  // ---- viewed checkboxes ---------------------------------------------------------

  context.subscriptions.push(
    treeView.onDidChangeCheckboxState(
      guard(async (e: vscode.TreeCheckboxChangeEvent<Node>) => {
        for (const [node, state] of e.items) {
          if (node.type !== "file") continue;
          const review = reviewOf(node);
          const data = await manager.viewData(node.repo, review);
          if (!data.right) continue;
          await setViewed(manager.repo(node.repo)!.store, review.id, data.right, node.change.path, state === vscode.TreeItemCheckboxState.Checked);
        }
        const repos = new Set([...e.items].map(([n]) => n.repo));
        for (const repo of repos) await manager.reload(repo, false);
      }),
    ),
    vscode.workspace.onDidSaveTextDocument(() => {
      if (manager.repositories.some((r) => r.reviews.some((rv) => manager.view(rv).kind === "worktree"))) manager.invalidate();
    }),
  );

  // ---- repositories ---------------------------------------------------------------

  const git = await getGitApi();
  if (!git) {
    void vscode.window.showWarningMessage(t("Local Merge Request: the built-in Git extension is disabled."));
    return;
  }
  const watchRepo = (repo: GitRepository) => {
    void manager.addRepository(repo.rootUri.fsPath).then(() => {
      const root = manager.repositories.find((r) => path.resolve(r.root) === path.resolve(repo.rootUri.fsPath))?.root ?? repo.rootUri.fsPath;
      context.subscriptions.push(repo.state.onDidChange(() => manager.schedule(root, true, 500)));
    });
  };
  git.repositories.forEach(watchRepo);
  context.subscriptions.push(
    git.onDidOpenRepository(watchRepo),
    git.onDidCloseRepository((repo) => manager.removeRepository(repo.rootUri.fsPath)),
    { dispose: () => manager.dispose() },
  );
}

export function deactivate(): void {}
