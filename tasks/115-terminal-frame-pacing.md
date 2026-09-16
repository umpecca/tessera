# Task 115: Stabilize capped terminal frame pacing

Status: complete

Use shared animation-frame timestamps and anchored deadlines for the 30 FPS
cap. Allow 1 ms of timing jitter, rebase after idle and interactive painting,
and reset deadlines on visibility recovery. Preserve pending output.

Validate 30, 60, and 120 Hz with jitter, idle recovery, and input bypass.

Verification: 239 frontend tests passed; web build, Go web asset tests, and
diff checks passed. Local Codex browser scrolling benchmark at 1× reported
30.0 FPS in Older Mac mode (previously approximately 15 FPS), 8.56 ms average
paint cost, and 256.9 ms painting/s. Test server and workload stopped afterward.
