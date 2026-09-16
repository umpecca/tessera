# Task 112: Terminal painting cap and cost measurements

Status: complete

Older Mac mode caps terminal painting at 30 FPS. Pending output is retained
until the next eligible animation frame. Input temporarily bypasses the cap
for prompt server echoes. Standard mode follows the display refresh rate.

Compatibility and Copy diagnostics include per-terminal frame counts and
average, peak, and cumulative CPU painting time since that terminal opened.
Counters retain only aggregates and omit terminal contents and titles.

Validation: scheduler cap/input/cost regression test, frontend suite, web build,
and Go web embedding tests.
