# Local Merge Request

GitLab-style merge request reviews in VS Code, on **local commits you have not pushed**.
Comment any commit range in native diff editors, track versions as the branch moves, and let
**Claude Code** read and answer your comments through a small CLI.

Nothing leaves your machine: reviews are stored inside the repository's `.git` directory, never committed, never pushed.

## Features

- **Any range**: review `from`..`to`, where both are any git ref (branch, remote branch, tag, SHA, `HEAD~3`…).
  The diff starts at the merge-base, like a merge request.
- **Versions**: each time `to` (or `from`) moves, a frozen version is recorded. A marker tells you when a new
  version is waiting.
- **Views**: full diff of any version, *since vN* (interdiff), between any two versions, and **in progress**
  (latest version + uncommitted changes, with the right side editable).
- **Comment threads** in the native diff editor: single lines or ranges, either side, Markdown,
  severity (*blocking*, *suggestion*, *question*), status (*open* → *addressed* → *resolved*), replies,
  edit/delete your messages, general comments on the review.
- **Outdated detection**: threads follow their lines across versions and uncommitted edits; when the commented
  lines change, the thread becomes *outdated* and keeps the original snippet.
- **Suggestions**: a ` ```suggestion ` block proposes replacement code, applied to the working tree in one click when
  the commented lines are unchanged. Nothing is staged or committed.
- **Viewed files** checkboxes (reset when the file changes in a later version), per-file thread counts,
  *open all files* in the multi-diff editor, live refresh when threads change on disk.
- **File tree or flat list** of changed files, with a context menu to open the diff, open the working file, or copy
  the absolute or relative path.
- **Claude Code integration**: the `lreview` CLI and a Claude Code skill let Claude list your threads, fix the code,
  reply and mark threads addressed. Only you can resolve a thread.
- English and French user interface.

## Getting started

1. Open a folder containing one or more git repositories.
2. In the **Source Control** side bar, find the **Local Merge Requests** view and click **+**.
3. Pick the base (`from`, defaults to the target of `origin/HEAD`), the ref to review (`to`, defaults to the current
   branch) and a title.
4. Expand the review, open a file, click **+** in the gutter and comment. Choose a severity after clicking **Comment**.

Use the view line under the review (or the *versions* icon) to switch between versions and the in-progress view.

## Working with Claude Code

Run once, from the view's `…` menu or the Command Palette:

- **Local Merge Request: Install the lreview Command-Line Tool** – installs `lreview` (default `~/.local/bin`).
  It runs with `node` when available, otherwise with VS Code's own runtime, and is kept up to date with the extension.
- **Local Merge Request: Install the Claude Code Skill** – installs the skill in `~/.claude/skills/local-merge-request`.

Then, in a repository with open threads, ask Claude Code to *process the review*. Claude reads the threads with their
current location, fixes blocking and suggestion threads (or applies your suggestions), answers questions, replies when
it disagrees, and marks what it fixed as *addressed*. It does not commit. Review its changes in the **in progress** view,
then resolve or reopen each thread.

### CLI

```text
lreview list [--all]                                  open reviews and thread counts
lreview show [review] [--status <status>]...          threads with their working-tree location
lreview create --from <ref> --to <ref> [--title <t>]
lreview reply <thread> [message|-]                     "-" reads stdin
lreview address <thread> [message|-]                   reply, then mark addressed
lreview status <thread> <open|addressed|resolved> [--as user]
lreview apply-suggestion <thread>
lreview close|reopen [review]
lreview delete <review> --yes
```

Global options: `--repo <path>`, `--json`. Ids accept a unique prefix. The CLI acts as `claude` unless `--as user`
is given, and `claude` can only move a thread from *open* to *addressed*.

## Storage

`<git common dir>/local-reviews/<review>/`: `review.json`, one `threads/<thread>.json` per thread, and `snapshots/`
for comments made on uncommitted content. It is outside the working tree, shared by all worktrees of the repository,
and written atomically under a lock so the extension and the CLI can work at the same time.

## Requirements and limitations

- `git` on the `PATH`, VS Code 1.90 or later, the built-in Git extension enabled.
- Binary files, submodules and untracked files are not commented.
- Comment threads may not render inside the multi-diff editor ("open all files"): comment in single-file diffs.
- Tested on Linux. macOS should work; Windows is untested.

## Development

```bash
npm install
npm test          # vitest against temporary git repositories
npm run typecheck
npm run package   # local-merge-request.vsix
./install.sh      # development install (extension + CLI and skill symlinked to this checkout)
```

`src/core` holds the model, storage, anchoring and suggestions (no `vscode` dependency), `src/cli` the CLI,
`src/extension` the VS Code extension. Specifications live in `openspec/`.

## License

[MIT](LICENSE)
