## Why

Reviewing a branch today requires pushing it and opening a GitLab MR. Work produced locally (by the user or by Claude) stays unreviewable until it leaves the machine, and review feedback for Claude has to be retyped in the chat. We want GitLab-style review threads inside VS Code, on local commits only, stored in a format Claude can read, answer and act on.

## What Changes

- New standalone project `local-review/` (own git repository), written in TypeScript, with a core library shared by a VS Code extension and a CLI.
- A **local review** covers a free commit range `A..B`, where `A` and `B` are refs (branch, tag or SHA). Each time `B` resolves to a new SHA, a new frozen **version** is recorded, so the user can view the full diff, the diff since a previous version, or the **in-progress view** (`B` + uncommitted working tree).
- **Threads** anchored to a file, side and line range of a version (or of the working tree), plus general threads not anchored to any line. Each thread has a severity (`blocking`, `suggestion`, `question`), Markdown messages authored by `user` or `claude`, and a status `open` → `addressed` → `resolved`.
- Anchors are carried across versions through git diffs; a thread whose lines were modified or deleted becomes **outdated** and keeps its original snippet.
- ```` ```suggestion ```` blocks in a message can be applied to the working tree, only if the anchored lines are unchanged. Nothing is ever committed by the tool.
- Storage under `<git-common-dir>/local-reviews/`: one directory per review, one JSON file per thread. Never tracked, never pushed, shared by all worktrees of a repo.
- VS Code extension: side panel (repo › review › files › threads), per-file native diff with comment threads, version selector, "viewed" checkboxes, "open all" in the multi-diff editor, live refresh when files change on disk.
- CLI `lreview` (create, list, show, reply, address, apply-suggestion, close…) and a global Claude skill to process a review: all open threads in one pass, no commit, no costly test runs.

## Capabilities

### New Capabilities
- `review-model`: reviews, versions, threads, statuses, severities, authorship, lifecycle, on-disk storage format and anchoring rules (version mapping, outdated, working-tree anchors, suggestion application).
- `review-extension`: VS Code user interface for creating, browsing and commenting reviews.
- `review-cli`: the `lreview` command line and the Claude skill that processes a review.

### Modified Capabilities

None.

## Impact

- New code only; reviewed repositories are never modified except by explicit suggestion application.
- Writes files under `.git/local-reviews/` of reviewed repos (outside the working tree).
- Local installation: a `.vsix` installed with `code --install-extension`, a `~/.local/bin/lreview` link, a skill in `~/.claude/skills/`.
- Dependencies: Node 22, VS Code ≥ 1.90 API, `git` on PATH.
- Out of scope: any remote (GitLab) synchronisation, automatic review closing.
