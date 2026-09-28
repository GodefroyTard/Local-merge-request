import * as vscode from "vscode";
import { Author, ChangeStatus, Severity, Thread, ThreadStatus } from "../core";

const t = vscode.l10n.t;

export function severityLabel(s: Severity): string {
  return { blocking: t("blocking"), suggestion: t("suggestion"), question: t("question") }[s];
}

export function statusLabel(s: ThreadStatus): string {
  return { open: t("open"), addressed: t("addressed"), resolved: t("resolved") }[s];
}

export function authorLabel(a: Author): string {
  return a === "user" ? t("You") : "Claude";
}

export function changeLabel(c: ChangeStatus): string {
  return {
    A: t("added"),
    M: t("modified"),
    D: t("deleted"),
    R: t("renamed"),
    C: t("copied"),
    T: t("type changed"),
  }[c];
}

export function threadIcon(thread: Thread): vscode.ThemeIcon {
  if (thread.status === "resolved") return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
  if (thread.status === "addressed") return new vscode.ThemeIcon("comment-draft", new vscode.ThemeColor("charts.blue"));
  const color = thread.severity === "blocking" ? "errorForeground" : thread.severity === "question" ? "charts.yellow" : "foreground";
  return new vscode.ThemeIcon("comment-unresolved", new vscode.ThemeColor(color));
}

export function firstLine(thread: Thread, max = 70): string {
  const text = (thread.messages[0]?.body ?? "").replace(/```[\s\S]*?```/g, "[code]").trim().split("\n")[0] ?? "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text || t("(empty)");
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(vscode.env.language, { dateStyle: "short", timeStyle: "short" });
}

export function errorMessage(err: unknown): string {
  return t("Local Merge Request: {0}", (err as Error).message);
}
