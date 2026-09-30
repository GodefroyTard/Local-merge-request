# Changelog

## Unreleased

- Changed files shown as a folder tree (toggle back to a flat list from the view title bar).
- File context menu: open diff, open the working file, copy path, copy relative path.

## 0.1.0

First release.

- Local merge requests over any commit range (`from`..`to`, diffed from their merge-base), with frozen versions.
- Views: full diff of any version, interdiff between versions, in-progress (latest version + uncommitted changes).
- Comment threads in native diff editors: multi-line ranges, severities (blocking / suggestion / question),
  statuses (open / addressed / resolved), general comments, outdated detection across versions.
- ```` ```suggestion ```` blocks applied to the working tree when the commented code is unchanged.
- Viewed-file checkboxes, "open all files" in the multi-diff editor, live refresh.
- `lreview` CLI and a Claude Code skill so Claude can read, answer and address threads.
- English and French UI.
