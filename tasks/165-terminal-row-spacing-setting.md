# Make terminal row spacing configurable

Status: complete

## Request

Expose terminal text row spacing as a setting and default to the tighter
appearance.

## Change

- Add Settings → Terminal → Row spacing with Tight and Comfortable options.
- Default new and existing users without a saved choice to Tight.
- Persist the choice per user and apply changes to open and new terminals.
- Tight uses full normal/bold font bounds without extra padding; Comfortable
  adds one pixel above and below. Round ascent and descent separately to
  preserve accented letters and descenders with fractional font metrics.
- Refit/redraw terminals through the existing geometry flow and keep Unicode
  box borders continuous.

## Validation

- Passed all 489 web tests, including spacing normalization, tighter font
  metrics, fractional ascender/descender bounds, live renderer changes, and
  everyday Settings placement.
- Passed Store and HTTP API tests plus vet, including migration of existing
  users to Tight, invalid-value fallback, persistence across database reopen,
  and settings API round trips.
- Rebuilt the web bundle and embedded Windows host successfully.
- Real-app Chromium checks verify Tight default selection, live metric and row
  count changes, Comfortable after reload, and switching back to Tight.
  At 14px JetBrains Mono, Tight uses 18px rows and Comfortable uses 20px rows.
- Passed 192 browser pixel cases across both settings, three fonts, four font
  sizes, four display scales, and both renderer modes. Accents and descenders
  fit, box borders stay continuous, faint junctions keep uniform opacity, and
  partial/full repaints match.
- Passed `git diff --check`. Browser scripts and results are saved in the
  ignored `.cache/review/terminal-spacing-165` directory.

Migration 043 adds the persisted setting. Run the rebuilt host so it can apply
the migration, then refresh the browser to load the updated terminal bundle.
