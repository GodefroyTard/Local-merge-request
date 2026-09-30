import * as path from "node:path";
import * as vscode from "vscode";
import { FileChange, isViewed, latestVersion, Review } from "../core";
import { buildFileTree, Entry } from "./fileTree";
import { changeLabel, firstLine, formatDate, severityLabel, statusLabel, threadIcon } from "./labels";
import { PlacedThread, ReviewManager, viewLabel } from "./manager";

export type Node =
  | { type: "repo"; repo: string }
  | { type: "review"; repo: string; review: string }
  | { type: "viewSelector"; repo: string; review: string }
  | { type: "general"; repo: string; review: string; threads: PlacedThread[] }
  | FolderNode
  | FileNode
  | { type: "outside"; repo: string; review: string; threads: PlacedThread[] }
  | { type: "thread"; repo: string; review: string; placed: PlacedThread };

export type FileNode = { type: "file"; repo: string; review: string; change: FileChange; threads: PlacedThread[]; viewed: boolean; checkable: boolean };
export type FolderNode = { type: "folder"; repo: string; review: string; path: string; label: string; children: (FolderNode | FileNode)[] };

const t = vscode.l10n.t;

const unresolved = (threads: PlacedThread[]) => threads.filter((t) => t.thread.status !== "resolved").length;

export class ReviewTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly manager: ReviewManager) {
    manager.onDidChange(() => this.changed.fire(undefined));
  }

  getParent(node: Node): Node | undefined {
    if (node.type === "repo") return undefined;
    if (node.type === "review") return { type: "repo", repo: node.repo };
    return { type: "review", repo: node.repo, review: node.review };
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const m = this.manager;
    if (!node) {
      const repos = m.repositories;
      return repos.map((r) => ({ type: "repo", repo: r.root }));
    }
    switch (node.type) {
      case "repo":
        return (m.repo(node.repo)?.reviews ?? [])
          .filter((r) => m.showClosed || r.state === "open")
          .map((r) => ({ type: "review", repo: node.repo, review: r.id }));
      case "review":
        return this.reviewChildren(node.repo, node.review);
      case "folder":
        return node.children;
      case "general":
      case "file":
      case "outside":
        return node.threads.map((placed) => ({ type: "thread", repo: node.repo, review: node.review, placed }));
      default:
        return [];
    }
  }

  private async reviewChildren(repo: string, id: string): Promise<Node[]> {
    const review = this.manager.review(repo, id);
    if (!review) return [];
    const state = this.manager.repo(repo)!;
    const data = await this.manager.viewData(repo, review);
    const nodes: Node[] = [{ type: "viewSelector", repo, review: id }];
    const general = data.threads.filter((t) => t.path === null);
    nodes.push({ type: "general", repo, review: id, threads: general });

    const files: FileNode[] = [];
    const listed = new Set<PlacedThread>();
    for (const change of data.files) {
      const threads = data.threads.filter((t) => {
        if (t.path === null) return false;
        const onOld = t.thread.anchor?.side === "old";
        return onOld ? t.path === change.oldPath : t.path === change.path;
      });
      threads.forEach((t) => listed.add(t));
      const checkable = data.right !== null && change.status !== "D";
      const viewed = checkable && (await isViewed(state.store, review, data.right!, change.path));
      files.push({ type: "file", repo, review: id, change, threads, viewed, checkable });
    }
    if (this.manager.treeLayout) {
      const toNode = (e: Entry<FileNode>): FolderNode | FileNode =>
        e.kind === "leaf" ? e.item : { type: "folder", repo, review: id, path: e.path, label: e.label, children: e.children.map(toNode) };
      nodes.push(...buildFileTree(files, (f) => f.change.path).map(toNode));
    } else {
      nodes.push(...files);
    }
    const outside = data.threads.filter((t) => t.path !== null && !listed.has(t));
    if (outside.length) nodes.push({ type: "outside", repo, review: id, threads: outside });
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const m = this.manager;
    switch (node.type) {
      case "repo": {
        const item = new vscode.TreeItem(path.basename(node.repo), vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon("repo");
        item.tooltip = node.repo;
        item.contextValue = "repo";
        return item;
      }
      case "review": {
        const review = m.review(node.repo, node.review)!;
        const item = new vscode.TreeItem(review.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `review:${node.repo}:${review.id}`;
        const counts = m.threads(node.repo, review.id);
        const open = counts.filter((t) => t.status === "open").length;
        const parts = [`${review.from}..${review.to}`, viewLabel(review, m.view(review))];
        if (open) parts.push(t("{0} open", open));
        if (m.hasUnseenVersion(review)) parts.unshift(t("● new version v{0}", latestVersion(review).n));
        if (review.missingRef) parts.push(t("missing ref"));
        if (review.state === "closed") parts.push(t("closed"));
        item.description = parts.join(" · ");
        item.tooltip = reviewTooltip(review);
        item.iconPath = new vscode.ThemeIcon(review.state === "closed" ? "git-pull-request-closed" : "git-pull-request");
        item.contextValue = review.state === "closed" ? "review-closed" : "review-open";
        return item;
      }
      case "viewSelector": {
        const review = m.review(node.repo, node.review)!;
        const item = new vscode.TreeItem(t("View: {0}", viewLabel(review, m.view(review))));
        item.iconPath = new vscode.ThemeIcon("versions");
        item.description = t("change…");
        item.command = { command: "lreview.selectView", title: t("Change view"), arguments: [{ type: "review", repo: node.repo, review: node.review }] };
        return item;
      }
      case "general": {
        const n = unresolved(node.threads);
        const item = new vscode.TreeItem(
          t("General comments"),
          node.threads.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.threads.length ? t("{0} unresolved", n) : t("open to comment");
        item.iconPath = new vscode.ThemeIcon("comment-discussion");
        item.command = { command: "lreview.openOverview", title: t("Open"), arguments: [{ type: "review", repo: node.repo, review: node.review }] };
        return item;
      }
      case "folder": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `folder:${node.repo}:${node.review}:${node.path}`;
        item.resourceUri = vscode.Uri.file(path.join(node.repo, node.path));
        item.iconPath = vscode.ThemeIcon.Folder;
        item.tooltip = node.path;
        item.contextValue = "folder";
        return item;
      }
      case "file": {
        const { change } = node;
        const n = unresolved(node.threads);
        const item = new vscode.TreeItem(
          path.basename(change.path),
          node.threads.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `file:${node.repo}:${node.review}:${change.path}`;
        item.resourceUri = vscode.Uri.file(path.join(node.repo, change.path));
        const dir = path.dirname(change.path);
        const showDir = !m.treeLayout && dir !== ".";
        const rename = change.status === "R" ? `← ${change.oldPath} · ` : "";
        item.description = `${rename}${showDir ? dir + " · " : ""}${changeLabel(change.status)}${n ? ` · 💬 ${n}` : ""}`;
        item.tooltip = `${change.path} (${changeLabel(change.status)})`;
        if (node.checkable) {
          item.checkboxState = node.viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        }
        item.contextValue = change.status === "D" ? "file-deleted" : "file";
        item.command = { command: "lreview.openFile", title: t("Open diff"), arguments: [node] };
        return item;
      }
      case "outside": {
        const item = new vscode.TreeItem(t("Files outside this view"), vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon("eye-closed");
        item.description = t("{0} thread(s)", node.threads.length);
        return item;
      }
      case "thread": {
        const { thread, outdated, location } = node.placed;
        const item = new vscode.TreeItem(firstLine(thread));
        item.id = `thread:${node.repo}:${node.review}:${thread.id}:${location?.path ?? ""}`;
        const parts = [severityLabel(thread.severity), statusLabel(thread.status)];
        if (outdated) parts.push(t("outdated"));
        else if (thread.anchor && !location) parts.push(t("old side"));
        if (location) parts.push(`L${location.startLine}${location.endLine !== location.startLine ? `-${location.endLine}` : ""}`);
        if (thread.messages.length > 1) parts.push(t("{0} messages", thread.messages.length));
        item.description = parts.join(" · ");
        item.iconPath = threadIcon(thread);
        item.tooltip = new vscode.MarkdownString(thread.messages.map((msg) => `**${msg.author}** : ${msg.body}`).join("\n\n---\n\n"));
        item.contextValue = `thread status-${thread.status}`;
        item.command = { command: "lreview.openThread", title: t("Show"), arguments: [node] };
        return item;
      }
    }
  }
}

function reviewTooltip(review: Review): vscode.MarkdownString {
  const lines = [`**${review.title}**`, "", `\`${review.from}\`..\`${review.to}\` · id \`${review.id}\``, ""];
  for (const v of review.versions) lines.push(`- v${v.n} : \`${v.base.slice(0, 8)}..${v.head.slice(0, 8)}\` (${formatDate(v.at)})`);
  return new vscode.MarkdownString(lines.join("\n"));
}
