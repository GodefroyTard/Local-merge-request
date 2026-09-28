## Purpose

Defines what a local review is — commit range, frozen versions, anchored discussion threads and their lifecycle — and how it is persisted, independently of the VS Code extension and the CLI that operate on it.

## ADDED Requirements

### Requirement: Review over a free commit range
A review SHALL belong to one git repository and be defined by a title and two refs, `from` and `to`, each being any expression `git rev-parse` accepts (branch, remote branch, tag, SHA). The diff of a version SHALL be computed from the merge-base of the resolved `from` and `to` commits to the resolved `to` commit. Creation SHALL fail with an explicit error when a ref does not resolve or when the range contains no file change.

#### Scenario: Create a review on a branch
- **WHEN** the user creates a review with `from = origin/develop` and `to = feat/x`
- **THEN** the review is stored with both refs as typed and a first version holding the SHA of `merge-base(origin/develop, feat/x)` and the SHA of `feat/x`

#### Scenario: Unresolvable ref
- **WHEN** a review is created with `to = does-not-exist`
- **THEN** creation fails, nothing is written, and the error names the ref that did not resolve

#### Scenario: Empty range
- **WHEN** `from` and `to` resolve to trees with no difference
- **THEN** creation fails with an error stating the range has no change

### Requirement: Frozen versions
A review SHALL keep an ordered list of versions, each recording the base SHA, the head SHA and the time it was recorded. Whenever the review is refreshed (opened in the extension, listed or shown by the CLI) and the resolved base or head differs from the latest version, a new version SHALL be appended. Existing versions SHALL never be modified.

#### Scenario: New commits on the reviewed branch
- **WHEN** a commit is added to `feat/x` after version 1 and the review is refreshed
- **THEN** version 2 is appended with the new head SHA and version 1 is unchanged

#### Scenario: No change
- **WHEN** the review is refreshed and both refs resolve to the SHAs of the latest version
- **THEN** no version is appended

#### Scenario: Ref deleted
- **WHEN** the `to` branch has been deleted and the review is refreshed
- **THEN** no version is appended, the review stays readable on its recorded versions, and it is flagged as having a missing ref

### Requirement: Diff views
For a review, the system SHALL provide three views: the **full view** (base..head of a chosen version, latest by default), the **interdiff view** (head of version k..head of a later version n) and the **in-progress view** (head of the latest version..current working tree, including uncommitted changes to tracked files).

#### Scenario: Interdiff after fixes
- **WHEN** the user selects the interdiff from version 1 to version 2
- **THEN** only the changes introduced between the two head commits are shown

#### Scenario: In-progress view shows uncommitted fixes
- **WHEN** a file of the range has been modified in the working tree without being committed
- **THEN** the in-progress view shows that modification and the full view does not

### Requirement: Threads
A review SHALL hold threads. A thread SHALL have an identifier, a severity among `blocking`, `suggestion` and `question`, a status, and an ordered list of messages. Each message SHALL carry a Markdown body, an author among `user` and `claude`, and a timestamp. A thread SHALL be either **anchored** (file path, side `old` or `new`, a start and end line, the snapshot of the anchored lines, and the origin it was created on: a version number or the working tree) or **general** (no anchor).

#### Scenario: Multi-line anchored thread
- **WHEN** the user comments lines 10 to 14 on the new side of `src/a.py` in version 2
- **THEN** the thread stores the path, side `new`, lines 10–14, the text of those five lines and origin version 2

#### Scenario: General thread
- **WHEN** the user adds a review-level comment
- **THEN** a thread without anchor is created and listed at the review level

### Requirement: Thread statuses and permissions
A thread SHALL have a status among `open`, `addressed` and `resolved`, and SHALL start `open`. Author `claude` SHALL be able to move a thread from `open` to `addressed`, and SHALL NOT be able to set `resolved` nor reopen a thread. Author `user` SHALL be able to set any status, including reopening an `addressed` or `resolved` thread to `open`. Every status change SHALL be recorded in the thread with its author and time.

#### Scenario: Claude addresses a thread
- **WHEN** Claude marks an open thread as addressed
- **THEN** its status becomes `addressed` and the change is recorded with author `claude`

#### Scenario: Claude cannot resolve
- **WHEN** a status change to `resolved` is requested with author `claude`
- **THEN** the request is rejected and the thread is unchanged

#### Scenario: User reopens
- **WHEN** the user reopens an `addressed` thread
- **THEN** its status becomes `open`

### Requirement: Anchor mapping across versions
When displaying a thread in a version or view other than its origin, the system SHALL relocate its anchor by following line changes in the git diff between the origin content and the displayed content. If any anchored line was modified or deleted, the thread SHALL be marked **outdated** for that view and keep its original snippet; otherwise it SHALL be displayed at the relocated lines.

#### Scenario: Lines shifted
- **WHEN** 3 lines are inserted above an anchored range in a later version
- **THEN** the thread is shown 3 lines lower and is not outdated

#### Scenario: Anchored line changed
- **WHEN** one of the anchored lines is modified in a later version
- **THEN** the thread is outdated in that version and still shows the original lines

### Requirement: Working-tree anchors
A thread created on the in-progress view SHALL have origin `working tree` and SHALL store a snapshot of the whole file content at creation time inside the review, so that its anchor can be mapped to any later version or to the current working tree even if that content is never committed.

#### Scenario: Comment on uncommitted fix, then commit
- **WHEN** the user comments an uncommitted change and the file is later committed, creating version 3
- **THEN** the thread is displayed at the corresponding lines of version 3 if those lines are unchanged, outdated otherwise

### Requirement: Applicable suggestions
A message MAY contain one ```` ```suggestion ```` fenced block holding replacement text for the anchored lines of its thread. The applicable suggestion of a thread SHALL be the one of its most recent message containing exactly one such block. Applying it SHALL replace the anchored lines in the working tree file, after relocating the anchor to the current working tree, only if those lines are identical to the anchored snapshot; otherwise it SHALL be refused with an explicit error and the file left untouched. A successful application SHALL set the thread to `addressed` and SHALL NOT stage or commit anything. Suggestions on general threads or on `old`-side anchors SHALL be refused.

#### Scenario: Apply on unchanged code
- **WHEN** a suggestion is applied and the anchored lines are unchanged in the working tree
- **THEN** the lines are replaced, the thread becomes `addressed`, and `git status` shows the file as modified but not staged

#### Scenario: Code changed since the comment
- **WHEN** a suggestion is applied and one anchored line differs in the working tree
- **THEN** the application is refused with an error stating the code changed, and the file is untouched

### Requirement: Viewed files
A review SHALL record, per file, whether the user marked it as viewed, together with the content identity of the file at that moment. A file SHALL appear as not viewed in a version where its content differs from the recorded one.

#### Scenario: File changes after being viewed
- **WHEN** a viewed file is modified in version 2
- **THEN** it appears as not viewed in version 2

### Requirement: Review lifecycle
A review SHALL be `open` or `closed`. Closing and reopening SHALL keep all data. Deleting a review SHALL remove its directory and SHALL require an explicit confirmation. No review SHALL be closed or deleted automatically.

#### Scenario: Close keeps data
- **WHEN** the user closes a review then reopens it
- **THEN** all versions, threads and viewed flags are intact

### Requirement: Local-only storage
Reviews SHALL be stored under `<git common dir>/local-reviews/`, one directory per review containing a review file, one file per thread and the working-tree snapshots, all as UTF-8 JSON (snapshots excepted) with a schema version field. The storage SHALL therefore be shared by all worktrees of a repository, never appear in `git status`, and never be pushed. Every write SHALL be atomic so that a concurrent reader never sees a partial file.

#### Scenario: Worktrees share reviews
- **WHEN** a review is created from the main checkout of a repository
- **THEN** it is visible from any linked worktree of that repository

#### Scenario: Nothing to commit
- **WHEN** reviews and threads have been created
- **THEN** `git status` of the reviewed repository reports no new or modified file

### Requirement: No git mutation
The system SHALL NOT commit, stage, stash, check out, fetch, or create, move or delete any ref in a reviewed repository. Its only write to the working tree SHALL be suggestion application.

#### Scenario: Refresh does not fetch
- **WHEN** a review is refreshed
- **THEN** refs are resolved from the local repository state only and no network access occurs
