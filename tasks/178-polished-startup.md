# Polished startup

Status: complete

## Request

Avoid the default-theme and transient-dialog flash before the saved session loads.

## Behavior

- Apply a validated theme cached per user before the stylesheet and first paint.
- Restore settings and the session behind a visibility gate that preserves layout.
- Reveal the restored visible terminals after their initial snapshot paint, with
  a bounded wait so a slow terminal does not block the whole workspace.
- Defer optional startup prompts until restoration completes.
- Offer a delayed, quiet loading message and a reload action on failure or timeout.
- Support user selection, direct session links, unavailable storage and no JavaScript.

## Validation

Check slow and failed requests, cache isolation, authoritative settings, blocked
storage, first-time users, terminal restoration, keyboard focus and direct links.

## Implementation and results

- Added a small classic startup script before CSS, embedded in both server and
  desktop builds. Validated theme caches are scoped per user; direct routes take
  precedence over the remembered user. Fresh settings replace stale cache values.
- The initial visibility gate preserves layout for terminal fits and snapshot
  painting. Visible terminals and background-image decoding have a shared
  three-second readiness budget. Minimized/covered panes do not delay reveal.
- Reveal restores keyboard focus, then checks optional clipboard/iPad prompts.
  With no cached theme, a neutral background replaces the default-theme flash.
- Loading feedback appears only after 600 ms; failed session loads or startup
  stalled for 15 seconds expose a reload link. Disabled JavaScript gets a visible
  explanation. Unavailable storage or an unavailable early script cannot stop an
  otherwise successful app from revealing its workspace.
- Nine startup regressions cover cache ownership/validation, denied storage,
  timeout recovery, reveal order, user selection, snapshots, and bounded waits.
- Real Edge checks under the existing CSP cover delayed settings with no wrong
  theme or modal frames, persisted terminal output and focus, failed-load reload,
  direct links, denied storage, disabled JavaScript and stale-cache correction.
  Harness/screenshots are in `.cache/review/startup-178`.
- All 585 JavaScript/core tests, Go tests, Go vet, syntax and diff checks pass.
