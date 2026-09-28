## Purpose

Lets the user create, browse and discuss local reviews inside VS Code, with native diff editors and comment threads, in a way close to a GitLab merge request.

## ADDED Requirements

### Requirement: Repository discovery
The extension SHALL list every git repository known to VS Code's built-in git support in the current workspace, including repositories nested in a workspace folder that is not itself a repository.

#### Scenario: Workspace containing several repositories
- **WHEN** the workspace folder `projects/` contains the repositories `api`, `web` and `worker`
- **THEN** the review panel shows one node per repository

### Requirement: Review panel
The extension SHALL provide a side panel showing, per repository, its open reviews; per review, its general threads, its changed files for the selected view and each file's anchored threads. Each file SHALL show its change type, its viewed state and its number of non-resolved threads. Each thread SHALL show its severity, status, first line of its first message and whether it is outdated. Closed reviews SHALL be hidden unless the user enables a "show closed" filter.

#### Scenario: Browsing a review
- **WHEN** the user expands a review with 4 changed files and 2 threads on `src/a.py`
- **THEN** the 4 files are listed and `src/a.py` shows a count of 2 and its two threads beneath it

#### Scenario: Closed reviews hidden
- **WHEN** a review is closed
- **THEN** it disappears from the panel until the "show closed" filter is enabled

### Requirement: Review creation
The extension SHALL offer a command to create a review: choose the repository, then `from` and `to` among local branches, remote branches, tags, recent commits or a free-typed ref, then a title. `from` SHALL default to the remote default branch (the target of `origin/HEAD`) and `to` to the currently checked-out branch; the title SHALL default to the `to` ref. Creation errors SHALL be shown to the user.

#### Scenario: Default range
- **WHEN** the user runs the creation command in a repository on branch `fix/PROJ-123/x` whose `origin/HEAD` points to `origin/develop`
- **THEN** the proposed defaults are `from = origin/develop`, `to = fix/PROJ-123/x`

### Requirement: View and version selection
Each review SHALL expose a selector for the view: full view of any version (latest by default), interdiff between two versions, or in-progress view. Changing the selection SHALL update the file list and the diffs opened afterwards. The panel SHALL indicate when a new version has been recorded since the user last selected a view.

#### Scenario: Reviewing only the fixes
- **WHEN** the user selects the interdiff from version 1 to version 2
- **THEN** the file list only contains files changed between the two heads

### Requirement: Diff editor with threads
Opening a file from the panel SHALL open a native VS Code diff editor for the selected view, with the review's threads displayed at their mapped lines. The right side of the in-progress view SHALL be the real working-tree file, editable in place. Outdated threads SHALL NOT be displayed inline and SHALL remain reachable from the panel, where they show their original snippet.

#### Scenario: Open a file
- **WHEN** the user clicks `src/a.py` in the full view of version 2
- **THEN** a diff editor opens between the base and head content of version 2 with its threads at their lines

#### Scenario: Outdated thread
- **WHEN** a thread is outdated in the displayed view
- **THEN** it is not shown in the diff editor and the panel shows it with an "outdated" marker and its original lines

### Requirement: Commenting
In a diff editor opened from a review, the user SHALL be able to start a thread on one line or a selected range of lines, on either side, choose its severity, and write a Markdown message. The user SHALL be able to reply, edit or delete their own messages, and change the thread status. General threads SHALL be created from the review node in the panel. All messages and status changes made through the extension SHALL have author `user`.

#### Scenario: Comment a range
- **WHEN** the user selects lines 10–14 on the right side and adds a comment with severity `blocking`
- **THEN** a thread anchored to those lines is created and displayed in the editor and the panel

#### Scenario: Resolve
- **WHEN** the user resolves an `addressed` thread
- **THEN** its status becomes `resolved` and the panel count for its file decreases

### Requirement: Applying a suggestion from the UI
A thread having an applicable suggestion SHALL show an "Apply suggestion" action that applies it according to the review model and reports refusal reasons to the user.

#### Scenario: Refused application
- **WHEN** the user applies a suggestion whose anchored lines changed
- **THEN** an error message explains the code changed since the comment and the file is untouched

### Requirement: Viewed checkbox
Each file in the panel SHALL have a checkbox to mark it viewed or not viewed.

#### Scenario: Mark viewed
- **WHEN** the user ticks the checkbox of `src/a.py`
- **THEN** the file is shown as viewed until its content changes in a later version

### Requirement: Open all files
A review SHALL offer an action opening all changed files of the selected view in a single multi-file diff editor.

#### Scenario: Open all
- **WHEN** the user triggers "open all" on a review with 4 changed files
- **THEN** one multi-file diff editor opens with the 4 files

### Requirement: Live refresh
The extension SHALL refresh the panel and the displayed threads when review files change on disk (for instance when Claude replies through the CLI) and when the resolved refs of a displayed review change, without requiring a reload of the window.

#### Scenario: Claude replies
- **WHEN** Claude adds a reply and marks a thread `addressed` through the CLI while the diff is open
- **THEN** the reply and the new status appear in the editor and in the panel within a few seconds

### Requirement: Review lifecycle actions
The panel SHALL offer close, reopen and delete actions on reviews; delete SHALL ask for confirmation.

#### Scenario: Delete confirmation
- **WHEN** the user triggers delete and cancels the confirmation
- **THEN** the review is kept
