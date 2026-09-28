import * as vscode from "vscode";
import { showFile } from "../core";
import { authorLabel, formatDate, severityLabel, statusLabel } from "./labels";
import { ReviewManager, viewLabel } from "./manager";
import { fromUri, SCHEME } from "./uris";

const t = vscode.l10n.t;

/** Serves `lreview:` documents: files at a commit, review overviews and thread pages. */
export class ContentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly manager: ReviewManager) {
    manager.onDidChange(() => {
      for (const doc of vscode.workspace.textDocuments) {
        const ref = fromUri(doc.uri);
        if (ref && ref.kind !== "file") this.changed.fire(doc.uri);
      }
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = fromUri(uri);
    if (!ref || uri.scheme !== SCHEME) return "";
    if (ref.kind === "file") return ref.sha ? ((await showFile(ref.repo, ref.sha, ref.path)) ?? "") : "";

    const review = this.manager.review(ref.repo, ref.review);
    if (!review) return t("Review not found (deleted?).") + "\n";

    if (ref.kind === "overview") {
      const state = review.state === "open" ? t("open review") : t("closed review");
      const lines = [
        `# ${review.title}`,
        "",
        `${review.from}..${review.to} · ${state} · ${t("view {0}", viewLabel(review, this.manager.view(review)))}`,
        "",
        `## ${t("Versions")}`,
        "",
        ...review.versions.map((v) => `- v${v.n}: ${v.base.slice(0, 8)}..${v.head.slice(0, 8)} (${formatDate(v.at)})`),
        "",
        `## ${t("General comments")}`,
        "",
        t("Click in the gutter of any line of this document to add a general comment to the review."),
        "",
      ];
      return lines.join("\n");
    }

    const thread = this.manager.threads(ref.repo, ref.review).find((x) => x.id === ref.thread);
    if (!thread) return t("Thread not found (deleted?).") + "\n";
    const a = thread.anchor;
    const lines = [`# ${t("Thread {0}", thread.id)} — ${severityLabel(thread.severity)} · ${statusLabel(thread.status)}`, ""];
    if (a) {
      const origin = a.origin.kind === "version" ? `v${a.origin.n}` : t("v{0} + local changes", a.origin.baseVersion);
      const side = a.side === "new" ? t("new side") : t("old side");
      lines.push(`${a.path}:${a.startLine}-${a.endLine} · ${side} · ${t("commented on {0}", origin)}`, "");
      lines.push(t("Originally commented code:"), "", "```", ...a.lines, "```", "");
    }
    lines.push(t("{0} message(s), first by {1}.", thread.messages.length, authorLabel(thread.messages[0]?.author ?? "user")), "");
    return lines.join("\n");
  }
}
