# Task 101: Firefox clipboard bridge

Status: complete (implementation; Mozilla release signing remains external)

User authorized implementation of a Firefox 115-compatible clipboard extension
downloadable from the Tessera executable.

- Add an opt-in extension with exact-origin authorization, top-frame-only
  access, explicit clipboard actions, and separately enabled terminal writes.
- Integrate editor, terminal, and VNC clipboard commands and Settings status.
- Embed a development package and support packaging a Mozilla-signed XPI for
  normal distribution, with accurate installation and update instructions.
- Test authorization, clipboard failure handling, packaging, and asset serving.
- Mozilla signing and physical High Sierra verification require external access;
  do not describe unsigned artifacts as installable production extensions.

Verification:

- `npm run build:web` succeeded and generated the embedded development ZIP.
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`: 217 tests passed.
- `go test ./...` passed, including package integrity and HTTP asset tests.
- Built `.cache/clipboard-test/tessera-clipboard.exe` and served its embedded
  assets without `-web`.
- Loaded the unsigned package temporarily in an isolated Firefox 115.37.0 ESR
  Windows/headless profile. Confirmed bridge discovery and text write/read,
  denied unsolicited reads, denied terminal writes without consent, and
  disconnected after origin revocation.
- Tested an HTTP hostname with `isSecureContext === false` against the compiled
  binary. Text Editor context-menu Paste received external clipboard text;
  separately authorized terminal writes succeeded.
- Test-profile host permission/allowlist setup was automated, not a full test
  of Firefox's native permission prompt. Popup/background configuration and
  revocation boundaries are covered by unit tests.
- Visually inspected Settings in Firefox 115: status, unsigned labeling,
  instructions, and links fit the modal with no horizontal overflow.
- Restored the system text clipboard after live tests. No clipboard contents
  were logged. Physical High Sierra, native popup permission prompts, signed
  installation/restart, and a live VNC peer remain manual verification items.
- Normalized line endings in three existing source-extraction test harnesses
  so the full suite works with Windows CRLF checkouts.

Release handoff:

Submit the bundled development ZIP for Mozilla unlisted signing, then run
`npm run build:clipboard -- --signed /path/to/mozilla-signed.xpi` and rebuild.
No signed package or automatic extension-update feed is claimed in this build.
