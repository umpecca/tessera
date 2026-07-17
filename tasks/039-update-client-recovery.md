# Task 039 — Reliable client recovery after self-update

Status: complete

Fix the browser-side self-update flow when the server successfully replaces and
restarts itself but the loaded client remains stuck on the update modal and the
global reconnect modal stays suppressed.

## Diagnosis

- The update client accepts any successful `/api/health` response after the
  update POST, including a response from the old process before shutdown.
- A premature success schedules a reload and returns while
  `serverUpdateRestarting` is still true. If that reload stalls, the regular
  connection monitor remains disabled indefinitely.
- The update POST response can also be lost as shutdown begins even though the
  replacement was installed successfully.

## Behavior

- Accept restart recovery only when health reports the expected release
  version, ignoring leading `v` differences.
- Cache-bust restart health probes and tolerate a lost update POST response by
  continuing to look for the expected version.
- Re-enable the normal connection monitor before reloading the SPA.
- If the server does not return, leave the update status actionable and force
  the global reconnect modal to appear.
- If the server returns with the wrong version, report that mismatch instead
  of claiming success.
- Flush the server's restarting response before signalling process shutdown.

## Verification

- Unit-test expected-version matching and normalization.
- Test the old-process response, expected new version, lost POST response, and
  restart timeout paths.
- Run frontend tests, syntax checks, and repository Go tests.

## Implementation summary

- Made restart health polling cache-busted and version-aware so a healthy
  response from the old process cannot trigger a premature reload.
- Continued recovery when the update POST acknowledgement is lost during
  shutdown, using the expected release version as the success signal.
- Cleared update suppression before reloading and added an actionable restored
  fallback if navigation stalls.
- Forced the global connection check after a restart timeout and report a
  reachable wrong-version server as a version mismatch.
- Flushed the server's restart acknowledgement before signalling shutdown.
- Added the update-version helper to the embedded release assets and covered
  version normalization and old/new process matching with frontend tests.
- Passed the JavaScript syntax check, 15 frontend tests, and all Go tests.
- Verified against a live stopped server that the Connection Lost alert appears
  with Refresh Page and Reconnect after two failed probes.
