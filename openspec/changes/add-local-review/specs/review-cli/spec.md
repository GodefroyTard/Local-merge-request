## Purpose

Gives Claude (and scripts) a safe command-line access to local reviews — reading threads with their current code location, replying, marking threads addressed and applying suggestions — plus a Claude skill describing how to process a review.

## ADDED Requirements

### Requirement: Repository and review resolution
The `lreview` command SHALL operate on the repository containing the current directory, or on the one given by `--repo <path>`. Commands targeting a review SHALL accept its identifier or a unique identifier prefix. When the review is omitted, the command SHALL use the only open review whose `to` ref resolves to the current `HEAD`, and SHALL otherwise fail listing the candidate reviews.

#### Scenario: Implicit review
- **WHEN** Claude runs `lreview show` on branch `feat/x` and exactly one open review has `to = feat/x`
- **THEN** that review is shown

#### Scenario: Ambiguous review
- **WHEN** two open reviews target the current branch and no review is given
- **THEN** the command fails with a non-zero exit code and lists both reviews with their identifiers and titles

### Requirement: Output formats and exit codes
Every command SHALL print human-readable text by default and a stable JSON document with `--json`. Commands SHALL exit with code 0 on success and a non-zero code on any error, printing the error on stderr.

#### Scenario: JSON output
- **WHEN** `lreview list --json` is run
- **THEN** stdout contains only a JSON document listing the reviews

### Requirement: Creating and listing reviews
`lreview create --from <ref> --to <ref> [--title <text>]` SHALL create a review following the review model. `lreview list [--all]` SHALL list open reviews (all reviews with `--all`) with identifier, title, refs, number of versions, missing-ref flag and counts of threads per status. Listing SHALL refresh versions.

#### Scenario: List counts
- **WHEN** a review has 3 open, 1 addressed and 2 resolved threads
- **THEN** `lreview list` shows those three counts for it

### Requirement: Showing threads for processing
`lreview show [review] [--status <status>...]` SHALL print the review refs and latest version, then each matching thread (non-resolved by default) with its identifier, severity, status, messages, origin, anchored snippet, and its location mapped to the current working tree (file and lines) or an outdated marker. It SHALL also print the thread's applicable suggestion when there is one.

#### Scenario: Thread located in working tree
- **WHEN** a thread was anchored to lines 10–14 of `src/a.py` in version 1 and 2 lines were inserted above them since, committed or not
- **THEN** `lreview show` reports the thread at `src/a.py:12-16` in the working tree

#### Scenario: Outdated thread
- **WHEN** an anchored line has been modified in the working tree
- **THEN** `lreview show` marks the thread outdated and prints its original snippet

### Requirement: Replying and addressing as Claude
`lreview reply <thread> <message>` (message also readable from stdin) SHALL append a message; `lreview address <thread> [<message>]` SHALL optionally append a message and set the thread to `addressed`. Messages and status changes made through the CLI SHALL have author `claude` unless `--as user` is given. The CLI SHALL NOT offer a way to resolve a thread as `claude`.

#### Scenario: Address with a message
- **WHEN** Claude runs `lreview address t3 "Renamed as requested."`
- **THEN** thread t3 gets a `claude` message with that text and status `addressed`

#### Scenario: Resolution refused
- **WHEN** `lreview status t3 resolved` is run without `--as user`
- **THEN** the command fails and t3 is unchanged

### Requirement: Applying suggestions from the CLI
`lreview apply-suggestion <thread>` SHALL apply the thread's applicable suggestion following the review model and fail with the refusal reason otherwise.

#### Scenario: Apply from CLI
- **WHEN** Claude applies the suggestion of a thread whose anchored lines are unchanged
- **THEN** the working tree file is updated, nothing is staged, and the thread becomes `addressed`

### Requirement: Lifecycle from the CLI
`lreview close`, `lreview reopen` and `lreview delete --yes` SHALL close, reopen and delete a review; `delete` without `--yes` SHALL refuse.

#### Scenario: Delete without confirmation
- **WHEN** `lreview delete r1` is run without `--yes`
- **THEN** the command fails and the review is kept

### Requirement: Review-processing skill
A Claude skill SHALL instruct Claude, when asked to process a review, to: show the review's non-resolved threads; for each `open` thread, fix `blocking` and `suggestion` threads (applying the applicable suggestion when there is one), reply and mark them `addressed`; answer `question` threads with a reply only, leaving them `open`; when disagreeing or needing the user's input, reply with the argument and leave the thread `open`; ignore `addressed` threads unless the user reopened them. Claude SHALL NOT commit, stage, push or run token-consuming test suites while processing, and SHALL end with a summary per thread in the chat.

#### Scenario: Processing a review
- **WHEN** the user asks Claude to process a review with one blocking thread, one question and one resolved thread
- **THEN** Claude fixes the code for the blocking thread and marks it addressed, replies to the question and leaves it open, does not touch the resolved thread, commits nothing, and summarizes the outcome
