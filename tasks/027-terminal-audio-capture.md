# Task 027 — Terminal linking and capture protocol

Status: complete

PTY sessions expose their root PID and the terminal manager resolves live panes
by workspace/pane ID. The audio manager validates linked terminals, supervises
the documented helper protocol, enforces a ten-second ready boundary, pipes PCM
through LAME, shares one pipeline, evicts slow listeners, and stops on Terminal
teardown. Missing helper/encoder dependencies fail softly.

Validation uses deterministic helper/encoder subprocesses for readiness timeout,
PCM forwarding, fan-out, and graceful/forced shutdown.
