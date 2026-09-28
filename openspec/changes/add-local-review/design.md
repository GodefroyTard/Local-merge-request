## Context

Greenfield project (see proposal.md). Constraints that shape the approach:

- Two front-ends, the VS Code extension and the `lreview` CLI, write the same files concurrently (the user comments while Claude replies).
- Anchor mapping must give the same answer in both front-ends, otherwise Claude edits lines the user did not point at.
- Target machine: Linux, Node 22, VS Code 1.138, git on PATH. Single user, no server.
- Reviewed repos are ordinary git repos, sometimes with linked worktrees; a workspace folder may itself not be a repository and contain several of them.

## Goals / Non-Goals

**Goals:**
- One TypeScript core used by both the extension and the CLI, with no dependency on the `vscode` module.
- Zero runtime installation beyond the `.vsix`, one symlink and one skill directory.
- Robust concurrent access to the store without a daemon.

**Non-Goals:**
- Performance on huge diffs (thousands of files); the target is MR-sized ranges.
- Commenting binary files, submodules, or untracked files in the in-progress view.
- Localisation: UI strings are French, code, logs and errors are English, no i18n layer.

## Decisions

### D1 — Project layout and build
Single npm package, three entry points bundled by esbuild:
`src/core/` (model, store, git access, anchoring, suggestions), `src/extension/` (VS Code), `src/cli/` (`lreview`). Outputs `dist/extension.js` and `dist/cli.js` (with a node shebang). `skill/SKILL.md` holds the Claude skill. An `install.sh` script builds, packages the `.vsix` with `@vscode/vsce`, installs it with `code --install-extension`, links `~/.local/bin/lreview` to `dist/cli.js`, and symlinks `skill/` to `~/.claude/skills/local-review`.
*Alternative:* npm workspaces with separate packages — more ceremony for no gain at this size.

### D2 — Git access through the git CLI
The core runs `git` with `execFile` (no shell) and `-C <repo>`: `rev-parse` (refs, `--git-common-dir`, `--show-toplevel`), `merge-base`, `diff --name-status -M -z` (file lists with renames), `show <sha>:<path>` (contents), `ls-tree` (blob ids for viewed flags), `for-each-ref` / `log` (pickers). Never `fetch`, `commit`, `add`, `checkout`, `update-ref`. The extension additionally uses the built-in `vscode.git` extension API only to discover repositories and to be notified of repository state changes.
*Alternative:* `isomorphic-git` or `nodegit` — heavier, and the CLI needs git anyway.

### D3 — Store layout
```
<git-common-dir>/local-reviews/
  <reviewId>/
    review.json          # schemaVersion, id, title, from, to, state, createdAt,
                         # versions[{n, base, head, at}], missingRef, viewed{path: blobId}
    threads/<threadId>.json
                         # schemaVersion, id, severity, status, anchor|null,
                         # messages[{id, author, body, at, editedAt?}],
                         # events[{type:"status", from, to, author, at}]
    snapshots/<sha256>   # full working-tree file contents for working-tree anchors
```
Anchor: `{path, side: "old"|"new", startLine, endLine, lines[], origin: {kind:"version", n} | {kind:"worktree", snapshot, baseVersion}}`. Line numbers are 1-based and inclusive. Identifiers are 8 random base32 characters, globally unique enough for prefix matching.

### D4 — Concurrency: atomic writes + per-file lock
Every write is read-modify-write under a lock file `<file>.lock` created with `O_EXCL`, retried for up to 2 s, considered stale after 10 s. The file is written to `<file>.tmp-<pid>` then `rename`d. One file per thread (grill decision) keeps contention to the rare case of both sides touching the same thread. Version appending re-reads `review.json` under the lock, so two concurrent refreshes cannot append the same version twice.
*Alternative:* SQLite — would need a native module in the extension and is opaque to a quick `cat`.

### D5 — Anchor mapping with an in-process line diff
To map an anchor from content X (origin) to content Y (displayed), the core computes a line diff X→Y with the `diff` npm package (Myers, bundled) and builds a line map: unchanged lines map to their new number; if any anchored line falls in a removed or modified hunk, the anchor is outdated. Contents come from `git show` for commits and from disk or snapshots for the working tree, so version→version, version→worktree and snapshot→version all use the same code path.
File identity across the two contents follows renames detected by `git diff -M` between the origin commit and the target commit (for working tree targets: origin commit → HEAD of latest version, then same path in working tree).
The `old` side maps between base contents; in the in-progress view the old side is the latest head, so `old`-side threads are only shown in full and interdiff views.
*Alternative:* `git diff -U0` between blobs — would require writing snapshots as blobs (`hash-object -w`) that `git gc` may prune, and one process per mapping.

### D6 — Why working-tree snapshots are stored in the review
A working-tree anchor needs the exact file content it was placed on. Storing it as a git blob would be pruned by `gc` when unreferenced; storing it in `snapshots/` (content-addressed by sha256) keeps it as long as the review exists.

### D7 — Diff views as URIs
The extension registers a `TextDocumentContentProvider` for the scheme `lreview` with URIs `lreview:/<path>?repo=…&sha=…` returning `git show` content (empty for added/deleted sides). Full view: `base`/`head` of the chosen version; interdiff: `head_k`/`head_n`; in-progress: `head_latest` vs the real `file:` URI, so the right side is editable. Diffs open with `vscode.diff`; "open all" uses the `vscode.changes` command with the same URI pairs.

### D8 — Comments through the Comments API
One `CommentController`. The `commentingRangeProvider` allows commenting on any line of documents opened from a review (both `lreview:` sides and working-tree files when opened in the in-progress view, tracked through the set of open diff pairs). Thread creation: the user types the first comment, then a quick pick asks the severity (default `suggestion`). Status actions (addressed / resolve / reopen) and "Apply suggestion" are contributed to `comments/commentThread/title` with `when` clauses on a `contextValue` encoding status and suggestion availability. Thread label shows `[severity] status`. Messages are rendered as `MarkdownString`; author names are "Moi" and "Claude".
Threads are rebuilt from the store for each open document on every refresh (disposed and recreated when the mapping changed) — simpler than diffing thread objects.

### D9 — Refresh triggers
- Store changes: Node `fs.watch(dir, {recursive: true})` on each repo's `local-reviews/` directory (VS Code's file watcher may exclude `.git`), debounced 200 ms.
- Ref changes: `vscode.git` repository `state.onDidChange` → re-resolve refs of displayed reviews and append versions when needed.
- CLI: refreshes on `list` and `show`.

### D10 — Viewed flags
Stored as `path → blobId` of the file on the head side when ticked; a file shows as viewed in a view only if its current head-side blob equals the stored one. In the in-progress view the checkbox is hidden.

### D11 — Suggestion application
Parsed with a regex on fenced blocks whose info string is exactly `suggestion`. Application: map the anchor to the current working tree (D5); refuse if outdated or if the mapped lines differ from `anchor.lines`; otherwise replace those lines in the file preserving its line endings, write it, and set the thread `addressed` with a status event (author of the caller). In the extension the file is edited through a `WorkspaceEdit` when it is open, so unsaved buffers are not overwritten; the CLI writes the file directly and refuses if the target line check fails.

### D12 — CLI parsing
Hand-written argument parsing on `process.argv` (a dozen subcommands, few flags); no runtime dependency.
*Alternative:* `commander` — acceptable but unnecessary.

### D13 — Tests
Core and CLI: `vitest` against temporary git repositories created in the test (commits, branches, worktrees, uncommitted edits), covering version recording, mapping, outdated detection, renames, snapshots, suggestion application, permission rules and concurrent writes. Extension: a manual acceptance checklist in `README.md`; no automated UI tests.

## Risks / Trade-offs

- [Comments API: the severity cannot be chosen inside the comment widget] → quick pick after the first submit, changeable later from the thread title menu.
- [Comment threads may not render inside the multi-diff editor] → "open all" is a reading aid; commenting remains available in per-file diffs.
- [In-process diff and git's diff can disagree on ambiguous hunks] → only affects where a mapped thread lands or whether it is outdated, never the displayed diff; outdated is the safe fallback.
- [Lost update when the user and Claude modify the same thread simultaneously] → per-file lock with re-read before write (D4).
- [Editing the right side of the in-progress view while a thread is displayed] → threads are remapped on save, not on every keystroke.
- [`fs.watch` recursive misses events on some filesystems] → the panel also has a manual refresh button.
- [A deleted `to` ref] → review stays readable on frozen SHAs; commits may eventually be garbage-collected if unreachable, in which case affected files show an error instead of content.

## Migration Plan

New tool, nothing to migrate. Install with `./install.sh`; uninstall with `code --uninstall-extension`, removing the `lreview` link and the skill symlink. Review data in `.git/local-reviews/` is left untouched by uninstalling and can be removed by hand.
