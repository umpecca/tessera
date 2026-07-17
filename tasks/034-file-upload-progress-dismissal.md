# Task 034 — File upload progress dismissal

Status: complete

Ensure the File Browser upload progress row does not remain visible after a
completed transfer, particularly as a persistent blue progress track in the
OLED theme.

## Behavior

- Keep the progress row visible while any file in the current upload batch is
  transferring.
- After a batch completes without errors, show its completion summary briefly
  and hide the complete row after two seconds.
- Keep a failed batch visible so its failure summary is not lost.
- Starting another upload cancels any pending dismissal timer and shows a fresh
  progress row.
- Do not let an older timer hide a newer upload's progress.

## Verification

- Confirm successful and skipped-only batches dismiss their progress row.
- Confirm failed batches remain visible.
- Confirm a new batch supersedes an older dismissal timer.
- Run `node --check web/app.js`, the frontend tests, and `git diff --check`.

## Implementation summary

- Added a per-pane upload batch identifier and dismissal timer.
- Successful and skipped-only batches now keep their summary for two seconds,
  then hide the complete transfer row.
- Failed batches remain visible, and beginning another batch cancels the older
  timer so it cannot hide current progress.
- Verified JavaScript syntax, all frontend Node tests, and `git diff --check`.
