---
name: local-merge-request
description: Process a local review (GitLab-style review threads stored in .git/local-reviews by the Local Merge Request VS Code extension) with the `lreview` CLI - fix blocking/suggestion threads, answer questions, mark threads addressed. Use when the user says "traite la review", "traite les commentaires", "process the review", "réponds à ma review", or mentions lreview / local review / local merge request comments.
---

# Process a local review

Review threads are written by the user in VS Code (Local Merge Request extension) and stored in the repository's
`.git/local-reviews/`. Never read or write those files directly: always go through `lreview`.

## 1. Find the review

Run from the repository the user is talking about (or pass `--repo <path>`):

```bash
lreview list                 # open reviews with thread counts
lreview show [review-id]     # non-resolved threads; review can be omitted when one open review targets HEAD
```

If `show` reports an ambiguity, pick the review matching the user's request or ask.

`show` prints, for each thread: id, severity, status, **current location in the working tree** (`path:start-end`) or
`OUTDATED`, the originally commented lines, all messages, and the applicable suggestion if any. Edit code at the
printed working-tree location, not at the original line numbers. Use `--json` when you need exact fields.

## 2. Handle every `open` thread, in one pass

| Severity | What to do |
|---|---|
| `blocking`, `suggestion` | Fix the code. If the thread has an applicable suggestion and it is right, run `lreview apply-suggestion <thread>` instead of editing by hand. Then `lreview address <thread> "<what you changed>"`. |
| `question` | Answer only: `lreview reply <thread> "<answer>"`. Leave the thread open; change code only if the question explicitly asks for it. |

- If you disagree, or need a decision from the user, reply with your argument (`lreview reply`) and leave the thread `open`.
- For an `OUTDATED` thread, read the original lines and messages, find where that code now lives, and handle it the same way; say so in your reply.
- Skip threads already `addressed` or `resolved` unless the user reopened them (they then show as `open`).
- Replies are Markdown; keep them short and concrete (what changed, where). Use `-` to pass a long message on stdin:
  `lreview reply <thread> - <<'EOF' ... EOF`.
- You can never resolve a thread: only the user does. Do not use `--as user`.

## 3. Constraints

- Do NOT commit, stage, stash, push or switch branches. Fixes stay uncommitted; the user reviews them in the
  extension's in-progress view and commits.
- Do NOT run token-consuming test suites (e.g. `poe evals`) without asking. Fast local unit tests are fine when relevant.
- Respect the repository's own instructions (CLAUDE.md / AGENTS.md).

## 4. Finish with a summary in the chat

One line per thread: id, severity, what you did (fixed / applied suggestion / answered / disagreed - waiting for you),
and files touched. End with `lreview show` counts if useful.
