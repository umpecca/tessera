# Retire Text Editor and Worksheet panes

Status: implemented and verified (Mac browser/native verification pending)

Remove both pane types, their creation actions, editor UI, CodeMirror and syntax
dependencies, worksheet command runs, raw file-content endpoints, and editor-only
settings. Keep terminals, Browser/VNC panes, the terminal directory picker, and
terminal file transfers.

Convert saved/imported/legacy editor panes (including unspecified legacy kinds)
to terminals, retaining IDs, titles, directories, geometry, focus/layout membership,
and archived buffer/tab/path/mode fields. Never execute saved text as commands.
Rotate revisions for affected workspaces only. Retain historical database columns
and command history; ordinary frontend saves must preserve archived documents.

Verify migration/import/save preservation and retired routes/actions, run Go/JS
suites and web build, then smoke-test current browser behavior.

Implemented:
- Removed both pane renderers and creation actions, editor menus/tabs/modes,
  CodeMirror and language packages/bundle, and editor wheel-scroll settings.
- Removed worksheet run manager/shell runner, command APIs and transcript write
  functions, and raw file read/write API. Retained terminal directory selection
  and ticket-based transfers. Directory listing now offers directories only.
- Migration 046 converts existing editor/worksheet/unspecified panes to terminals;
  imports receive the same normalization. Retained legacy document columns and
  command history. Browser saves preserve opaque buffer/tab/path/mode fields.
- Updated current docs, native quit wording, release build inputs and tests.

Verification:
- Full Go suite and go vet pass. All 551 JavaScript tests pass.
- Web bundles rebuild; shared terminal core reproducibility passes with protocol
  2 and core hash unchanged from task 172.
- Migration tests verify archived documents, pane IDs, geometry, active pane,
  layout, revision isolation/stale-save rejection, imports and later layout saves.
- Retired API routes return 404; terminal directory picker remains directory-only.
- Chrome 154, Edge 154 and Firefox 153 real app smoke passes: retired creation
  actions absent, archived documents survive browser saves, terminal helper and
  batch/original/ZIP transfers, hidden requests and socket handoff still work.
- Safari/macOS native preview cannot be tested on this Windows host.

Existing task 171/172 changes remain intact. No commit, push or release performed.
