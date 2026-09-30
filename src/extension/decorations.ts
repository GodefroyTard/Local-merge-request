import * as vscode from "vscode";
import { ChangeStatus, FileChange } from "../core";
import { changeLabel } from "./labels";

/** Tree items use their own scheme so the decorations do not leak into the Explorer. */
const SCHEME = "lreview-item";

const COLORS: Record<ChangeStatus, string> = {
  A: "gitDecoration.addedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  C: "gitDecoration.addedResourceForeground",
  T: "gitDecoration.modifiedResourceForeground",
};

export function decorationUri(change: FileChange): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${change.path}`, query: change.status });
}

/** Colors changed files and shows their status letter, like the Source Control view. */
export class ChangeDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) return undefined;
    const status = uri.query as ChangeStatus;
    if (!(status in COLORS)) return undefined;
    return new vscode.FileDecoration(status, changeLabel(status), new vscode.ThemeColor(COLORS[status]));
  }
}
