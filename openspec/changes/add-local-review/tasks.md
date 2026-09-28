## 1. Project setup

- [x] 1.1 Create `package.json` (engines node 22, vscode ^1.90), `tsconfig.json`, `.gitignore` (`node_modules`, `dist`, `*.vsix`) and esbuild scripts producing `dist/extension.js` and `dist/cli.js`; verify `npm run build` emits both files
- [x] 1.2 Add `vitest` and a test helper that creates temporary git repositories (commits, branches, linked worktree, uncommitted edits); verify a smoke test using the helper passes

## 2. Core: git access and store

- [x] 2.1 Implement the git wrapper (execFile, `-C`, rev-parse, merge-base, `diff --name-status -M -z`, `show`, `ls-tree`, common-dir) with typed errors; verify tests on a temp repo, including a linked worktree resolving to the same common dir
- [x] 2.2 Implement locked atomic JSON read-modify-write (O_EXCL lock, stale timeout, tmp + rename); verify a test running concurrent writers on one file loses no update
- [x] 2.3 Implement the store layout (review.json, threads/, snapshots/) with schema version and random ids with prefix lookup; verify create/read/list/delete tests and that `git status` stays clean

## 3. Core: reviews and versions

- [x] 3.1 Implement review creation (ref resolution, merge-base, empty-range and bad-ref errors); verify tests for each creation scenario of the review-model spec
- [x] 3.2 Implement refresh (append version when base or head changes, missing-ref flag, no duplicate under concurrency); verify tests for new commits, no change, deleted ref
- [x] 3.3 Implement the three views (full, interdiff, in-progress) returning changed files with rename info and content accessors; verify tests including an uncommitted change visible only in in-progress
- [x] 3.4 Implement close / reopen / delete and viewed flags keyed by blob id; verify tests that closing keeps data and that a changed file becomes not viewed

## 4. Core: threads, anchoring, suggestions

- [x] 4.1 Implement thread creation (anchored with snapshot of lines, general, working-tree origin with sha256 snapshot), messages, edit/delete own messages; verify tests
- [x] 4.2 Implement status transitions and permissions (`claude` limited to open → addressed) with status events; verify tests for allowed and rejected transitions
- [x] 4.3 Implement line-map anchor mapping between two contents (shift, outdated on modification/deletion, old and new sides, renames); verify tests for shifted lines, changed line, deleted range, renamed file, snapshot → later version
- [x] 4.4 Implement suggestion parsing and application to the working tree (mapping, identical-lines check, line endings, status → addressed, no staging); verify tests for success, changed code, general thread, old side, multiple blocks

## 5. CLI `lreview`

- [x] 5.1 Implement argument parsing, repo resolution (`--repo`, cwd), review resolution (id, prefix, implicit by HEAD, ambiguity error), `--json` and exit codes; verify CLI tests on temp repos
- [x] 5.2 Implement `create`, `list [--all]`, `close`, `reopen`, `delete --yes`; verify CLI tests matching the review-cli scenarios
- [x] 5.3 Implement `show` with working-tree locations, outdated markers and applicable suggestions; verify CLI tests for located and outdated threads
- [x] 5.4 Implement `reply` (arg or stdin), `address`, `status` (with `--as user`, refusing `resolved` as claude) and `apply-suggestion`; verify CLI tests for each command

## 6. VS Code extension

- [ ] 6.1 Activation, repository discovery via the `vscode.git` API, and the `lreview:` content provider; verify manually that all repositories of a multi-repository workspace appear and that a `lreview:` URI shows a file at a given SHA
- [ ] 6.2 Review panel tree (repos › reviews › general threads, files with change type / count / checkbox › threads, outdated markers, show-closed filter, manual refresh); verify manually on a review with several files and threads
- [ ] 6.3 Create-review command with ref quick picks and defaults (`origin/HEAD` target, current branch); verify manually the defaults and the error display for a bad ref
- [ ] 6.4 View/version selector and "new version available" indicator; verify manually full, interdiff and in-progress file lists
- [ ] 6.5 Open per-file diffs and "open all" (`vscode.changes`), in-progress right side as the real file; verify manually
- [ ] 6.6 Comment controller: commenting ranges, thread creation with severity quick pick, reply/edit/delete, status actions, general threads from the panel, rendering mapped threads and hiding outdated ones; verify manually each review-extension commenting scenario
- [ ] 6.7 "Apply suggestion" action through `WorkspaceEdit`, with refusal messages; verify manually success and refusal
- [ ] 6.8 Live refresh (recursive `fs.watch` on stores, git state changes, remap on save); verify manually that a `lreview address` from a terminal shows up without reload
- [ ] 6.9 Close / reopen / delete actions with confirmation; verify manually

## 7. Skill, packaging and docs

- [x] 7.1 Write `skill/SKILL.md` (process-a-review procedure from the review-cli spec: no commit, no costly tests, summary per thread); verify its content against the spec scenario
- [x] 7.2 Write `install.sh` (build, vsce package, `code --install-extension`, `~/.local/bin/lreview` link, skill symlink) and uninstall notes; verify by running it and checking `lreview --help` and the extension in VS Code
- [ ] 7.3 Write `README.md` with usage and the manual acceptance checklist; verify the checklist end to end on one of the three repos (create review, comment, `lreview show`/`address` from Claude, resolve, new version, outdated thread, apply suggestion)
