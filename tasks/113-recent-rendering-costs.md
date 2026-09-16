# Task 113: Recent rendering measurements

Status: complete

Add five-second rolling FPS, paint milliseconds per second, average frame
cost, and peak frame cost alongside lifetime counters. Retain at most 4096
recent samples per terminal. Idle periods age samples out without requiring
another paint. Compatibility refreshes its displayed measurements once per
second while Settings is visible; closing Settings cancels the timer.
Copy diagnostics includes both recent and lifetime values.

Validation: deterministic recent-sample expiry test, frontend tests, web build,
and Go web asset tests.
