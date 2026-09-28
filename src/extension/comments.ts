import * as path from "node:path";
import * as vscode from "vscode";
import {
  addMessage,
  applicableSuggestion,
  applySuggestion,
  createThread,
  deleteMessage,
  editMessage,
  Locator,
  NewAnchor,
  planSuggestion,
  Review,
  Severity,
  setSeverity,
  setStatus,
  Thread,
  ThreadStatus,
} from "../core";
import { authorLabel, errorMessage, formatDate, severityLabel, statusLabel } from "./labels";
import { ReviewManager } from "./manager";
import { fromUri } from "./uris";

const t = vscode.l10n.t;

interface ThreadKey {
  repo: string;
  review: string;
  thread: string;
}

class ReviewComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: string | vscode.MarkdownString;
  author: vscode.CommentAuthorInformation;
  label: string;
  contextValue: string;

  constructor(
    readonly key: ThreadKey,
    readonly messageId: string,
    readonly raw: string,
    author: Thread["messages"][number]["author"],
    at: string,
    edited: boolean,
    public parent?: vscode.CommentThread,
  ) {
    this.body = new vscode.MarkdownString(raw);
    this.author = { name: authorLabel(author) };
    this.label = formatDate(at) + (edited ? ` ${t("(edited)")}` : "");
    this.contextValue = author === "user" ? "own" : "other";
  }
}

interface Rendered {
  signature: string;
  threads: vscode.CommentThread[];
}

interface Target {
  repo: string;
  review: Review;
  /** Commit shown by the document, null for the working tree; undefined for pages without code. */
  sha?: string | null;
  path?: string;
  side?: "old" | "new";
  anchor?: (start: number, end: number, doc: vscode.TextDocument) => NewAnchor;
  only?: "general" | string;
}

async function pickSeverity(current?: Severity): Promise<Severity | undefined> {
  const items = (["blocking", "suggestion", "question"] as Severity[]).map((s) => ({
    label: severityLabel(s),
    description: s === current ? t("current") : undefined,
    severity: s,
  }));
  const qp = vscode.window.createQuickPick<(typeof items)[number]>();
  qp.items = items;
  qp.activeItems = [items[current ? items.findIndex((i) => i.severity === current) : 1]];
  qp.placeholder = t("Thread severity");
  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.severity);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

/** Renders stored threads in documents opened from reviews and turns Comments API actions into store updates. */
export class CommentsView implements vscode.Disposable {
  readonly controller = vscode.comments.createCommentController("local-review", "Local Review");
  private readonly rendered = new Map<string, Rendered>();
  private readonly keys = new WeakMap<vscode.CommentThread, ThreadKey>();
  private readonly disposables: vscode.Disposable[] = [this.controller];

  constructor(private readonly manager: ReviewManager) {
    this.controller.options = { prompt: t("Comment"), placeHolder: t("Comment (Markdown; use a ```suggestion block to propose code)") };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        if (!this.isCommentable(doc)) return [];
        return [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)];
      },
    };
    this.disposables.push(
      manager.onDidChange(() => void this.renderAll()),
      vscode.workspace.onDidOpenTextDocument((doc) => void this.renderDoc(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc.uri)),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.renderDoc(doc)),
    );
  }

  dispose(): void {
    for (const r of this.rendered.values()) r.threads.forEach((ct) => ct.dispose());
    this.rendered.clear();
    this.disposables.forEach((d) => d.dispose());
  }

  private isCommentable(doc: vscode.TextDocument): boolean {
    const ref = fromUri(doc.uri);
    if (ref) return (ref.kind === "file" && !!ref.anchor && !!ref.sha) || ref.kind === "overview";
    return doc.uri.scheme === "file" && this.manager.worktreeDocs.has(doc.uri.fsPath);
  }

  private target(doc: vscode.TextDocument): Target | undefined {
    const ref = fromUri(doc.uri);
    if (ref) {
      const review = this.manager.review(ref.repo, ref.review);
      if (!review) return undefined;
      if (ref.kind === "overview") return { repo: ref.repo, review, only: "general" };
      if (ref.kind === "thread") return { repo: ref.repo, review, only: ref.thread };
      if (!ref.sha) return undefined;
      const side = ref.role === "right" ? "new" : ref.anchor?.side === "old" ? "old" : undefined;
      if (!side) return undefined;
      const anchorInfo = ref.anchor;
      return {
        repo: ref.repo,
        review,
        sha: ref.sha,
        path: ref.path,
        side,
        anchor: anchorInfo
          ? (start, end) => ({
              path: ref.path,
              side: anchorInfo.side,
              startLine: start,
              endLine: end,
              origin: { kind: "version", n: anchorInfo.version },
            })
          : undefined,
      };
    }
    const reg = doc.uri.scheme === "file" ? this.manager.worktreeDocs.get(doc.uri.fsPath) : undefined;
    const review = reg && this.manager.review(reg.repo, reg.review);
    if (!reg || !review) return undefined;
    const rel = path.relative(reg.repo, doc.uri.fsPath).split(path.sep).join("/");
    return {
      repo: reg.repo,
      review,
      sha: null,
      path: rel,
      side: "new",
      anchor: (start, end, d) => ({
        path: rel,
        side: "new",
        startLine: start,
        endLine: end,
        origin: { kind: "worktree", content: d.getText() },
      }),
    };
  }

  async renderAll(): Promise<void> {
    await Promise.all(vscode.workspace.textDocuments.map((d) => this.renderDoc(d)));
  }

  private clear(uri: vscode.Uri): void {
    const r = this.rendered.get(uri.toString());
    r?.threads.forEach((ct) => ct.dispose());
    this.rendered.delete(uri.toString());
  }

  async renderDoc(doc: vscode.TextDocument, force = false): Promise<void> {
    const target = this.target(doc);
    if (!target) {
      this.clear(doc.uri);
      return;
    }
    const placed: { thread: Thread; start: number; end: number }[] = [];
    const threads = this.manager.threads(target.repo, target.review.id);
    if (target.only === "general") {
      for (const th of threads) if (!th.anchor) placed.push({ thread: th, start: 1, end: 1 });
    } else if (target.only) {
      for (const th of threads) if (th.id === target.only) placed.push({ thread: th, start: 1, end: 1 });
    } else {
      const state = this.manager.repo(target.repo);
      if (!state) return;
      const locator = new Locator(state.store, target.review);
      for (const th of threads) {
        if (!th.anchor || th.anchor.side !== target.side) continue;
        try {
          const loc = await locator.locate(th.anchor, target.sha ?? null);
          if (!loc.outdated && loc.path === target.path) placed.push({ thread: th, start: loc.startLine, end: loc.endLine });
        } catch {
          // Unreadable origin (e.g. garbage-collected commit): the thread stays reachable from the panel.
        }
      }
    }

    const signature = JSON.stringify(
      placed.map((p) => [p.thread.id, p.thread.status, p.thread.severity, p.start, p.end, p.thread.messages.map((m) => [m.id, m.editedAt])]),
    );
    const key = doc.uri.toString();
    const previous = this.rendered.get(key);
    if (!force && previous?.signature === signature) return;
    this.clear(doc.uri);

    const created: vscode.CommentThread[] = [];
    for (const p of placed) {
      const last = Math.min(p.end, doc.lineCount) - 1;
      const range = new vscode.Range(p.start - 1, 0, Math.max(last, 0), doc.lineAt(Math.max(last, 0)).text.length);
      const tkey = { repo: target.repo, review: target.review.id, thread: p.thread.id };
      const comments = p.thread.messages.map((m) => new ReviewComment(tkey, m.id, m.body, m.author, m.at, !!m.editedAt));
      const ct = this.controller.createCommentThread(doc.uri, range, comments);
      comments.forEach((c) => (c.parent = ct));
      this.decorate(ct, p.thread);
      this.keys.set(ct, tkey);
      created.push(ct);
    }
    this.rendered.set(key, { signature, threads: created });
  }

  private decorate(ct: vscode.CommentThread, th: Thread): void {
    ct.label = `${severityLabel(th.severity)} · ${statusLabel(th.status)}`;
    ct.canReply = true;
    ct.contextValue = ["lreview", `status-${th.status}`, applicableSuggestion(th) !== null ? "has-suggestion" : ""].join(" ").trim();
    ct.state = th.status === "resolved" ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    ct.collapsibleState = th.status === "resolved" ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
  }

  private async afterChange(repo: string, uri?: vscode.Uri): Promise<void> {
    await this.manager.reload(repo, false);
    if (uri) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc) await this.renderDoc(doc, true);
    }
  }

  private store(repo: string) {
    const state = this.manager.repo(repo);
    if (!state) throw new Error(t("repository {0} is not loaded", repo));
    return state.store;
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(errorMessage(err));
    }
  }

  // ---- commands ------------------------------------------------------------

  createThread = (reply: vscode.CommentReply) =>
    this.guard(async () => {
      const ct = reply.thread;
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === ct.uri.toString()) ?? (await vscode.workspace.openTextDocument(ct.uri));
      const target = this.target(doc);
      if (!target) throw new Error(t("this document does not belong to a review"));
      const severity = await pickSeverity();
      if (!severity) return;
      let anchor: NewAnchor | undefined;
      if (target.only !== "general") {
        if (!target.anchor || !ct.range) throw new Error(t("this side of the diff cannot be commented"));
        anchor = target.anchor(ct.range.start.line + 1, ct.range.end.line + 1, doc);
      }
      await createThread(this.store(target.repo), target.review, { severity, body: reply.text, author: "user", anchor });
      ct.dispose();
      await this.afterChange(target.repo, doc.uri);
    });

  reply = (reply: vscode.CommentReply) =>
    this.guard(async () => {
      const key = this.keys.get(reply.thread);
      if (!key) return this.createThread(reply);
      await addMessage(this.store(key.repo), key.review, key.thread, "user", reply.text);
      await this.afterChange(key.repo, reply.thread.uri);
    });

  setStatus = (ct: vscode.CommentThread, status: ThreadStatus) =>
    this.guard(async () => {
      const key = this.keys.get(ct);
      if (!key) return;
      await setStatus(this.store(key.repo), key.review, key.thread, status, "user");
      await this.afterChange(key.repo, ct.uri);
    });

  changeSeverity = (ct: vscode.CommentThread) =>
    this.guard(async () => {
      const key = this.keys.get(ct);
      if (!key) return;
      const store = this.store(key.repo);
      const current = await store.readThread(key.review, key.thread);
      const severity = await pickSeverity(current.severity);
      if (!severity) return;
      await setSeverity(store, key.review, key.thread, severity);
      await this.afterChange(key.repo, ct.uri);
    });

  applySuggestion = (ct: vscode.CommentThread) =>
    this.guard(async () => {
      const key = this.keys.get(ct);
      if (!key) return;
      const store = this.store(key.repo);
      const review = await store.readReview(key.review);
      const thread = await store.readThread(key.review, key.thread);
      const onDisk = await planSuggestion(store, review, thread);
      const fileUri = vscode.Uri.file(path.join(store.repo, onDisk.path));
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fileUri.fsPath);
      if (!open) {
        await applySuggestion(store, review, thread, "user");
      } else {
        const plan = open.isDirty ? await planSuggestion(store, review, thread, open.getText()) : onDisk;
        const eol = open.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        const edit = new vscode.WorkspaceEdit();
        const range =
          plan.endLine < open.lineCount
            ? new vscode.Range(plan.startLine - 1, 0, plan.endLine, 0)
            : new vscode.Range(plan.startLine - 1, 0, plan.endLine - 1, open.lineAt(plan.endLine - 1).text.length);
        const text = plan.replacement.join(eol) + (plan.endLine < open.lineCount && plan.replacement.length ? eol : "");
        edit.replace(open.uri, range, text);
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error(t("the editor rejected the change"));
        if (thread.status === "open") await setStatus(store, key.review, key.thread, "addressed", "user");
      }
      void vscode.window.showInformationMessage(t("Suggestion applied to {0}:{1} (not committed).", onDisk.path, onDisk.startLine));
      await this.afterChange(key.repo, ct.uri);
    });

  editMessage = (comment: ReviewComment) => {
    const ct = comment.parent;
    if (!ct) return;
    ct.comments = ct.comments.map((c) => {
      if (c !== comment) return c;
      comment.mode = vscode.CommentMode.Editing;
      comment.body = comment.raw;
      return comment;
    });
  };

  saveMessage = (comment: ReviewComment) =>
    this.guard(async () => {
      const body = typeof comment.body === "string" ? comment.body : comment.body.value;
      await editMessage(this.store(comment.key.repo), comment.key.review, comment.key.thread, comment.messageId, "user", body);
      await this.afterChange(comment.key.repo, comment.parent?.uri);
    });

  cancelEdit = (comment: ReviewComment) =>
    this.guard(async () => {
      const uri = comment.parent?.uri;
      const doc = uri && vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc) await this.renderDoc(doc, true);
    });

  deleteMessage = (comment: ReviewComment) =>
    this.guard(async () => {
      const del = t("Delete");
      const ok = await vscode.window.showWarningMessage(t("Delete this message?"), { modal: true }, del);
      if (ok !== del) return;
      await deleteMessage(this.store(comment.key.repo), comment.key.review, comment.key.thread, comment.messageId, "user");
      await this.afterChange(comment.key.repo, comment.parent?.uri);
    });
}
