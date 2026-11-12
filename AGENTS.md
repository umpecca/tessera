# Agent instructions for Tessera

## Required: task file before implementation

Every implementation work item must have a task file in the repository-root
`tasks/` directory **before changing code, tests, configuration, documentation or
generated assets**. This includes small fixes, refactors, performance work and
changes to these instructions. Read-only investigation and answering questions
do not require a task; create one before turning findings into changes.

This workflow is adapted from catchacodevibe's `develop-task` skill and is
self-contained. Do not depend on a sibling checkout or an installed skill.

### Starting work

1. If the user supplies a task ID, read that task. If it is missing, ask for
   clarification rather than silently creating a different task.
2. Otherwise, check whether an existing task already covers the requested work.
   Reuse it when appropriate; do not create duplicate tasks for follow-ups within
   the same scope.
3. For a new work item, create `tasks/NNN-short-kebab-case-title.md`. Inspect the
   existing numeric IDs and use the highest ID plus one, padded to at least three
   digits. Never overwrite, renumber or reuse an existing task ID, or fill old
   numbering gaps. Recheck availability immediately before creating the file.
4. Write the request, scope, acceptance criteria and intended verification before
   implementation. Keep the task lightweight and concrete; use the template below.
5. Before coding a newly drafted task, show the user its path and summarize its
   scope, then ask for confirmation. If the user has already explicitly approved
   that same concrete scope and directed implementation, record that approval in
   the task instead of asking again. Approval to investigate is not approval to
   implement; material scope changes need confirmation.
6. Mark the task in progress when implementation begins. Work only on the
   requested task; do not start unrelated open tasks unless the user asks. If
   asked to work through the backlog, use ascending task IDs and respect recorded
   blockers and approval requirements.

### During and after work

- Keep the task current with important decisions, scope changes and blockers.
- Match the surrounding code and architecture. Prefer direct control flow and
  concrete types; avoid speculative abstractions and unrelated refactoring.
- Add regression coverage for changed behavior and run relevant checks. For web
  modules, use `node --test` with the affected test files; for Go changes, run
  affected package tests. Broader validation can include `node --test web/*.test.mjs`,
  `go test ./...`, `go vet ./...` and `npm run build:web` when appropriate.
- Record the commands and outcomes in the task. Distinguish automated or mocked
  tests from live-server, browser and physical-device acceptance. Do not claim
  unperformed checks or measured performance improvements without evidence.
- Update relevant product documentation and `CHANGELOG.md` for user-visible
  changes. Instruction-only changes do not need a product changelog entry.
- Before finishing, update acceptance checkboxes and status, summarize the
  implementation, and list any pending verification. Mark a task complete only
  when its acceptance criteria are satisfied; label partial completion honestly.
- Preserve other people's changes. Do not commit, push, discard work or expand
  the task's scope without authorization.

## Lightweight task template

```markdown
# Task NNN: Short title

Status: proposed (YYYY-MM-DD).

## Request

What the user wants and why.

## Scope

- Concrete changes and important boundaries.
- Approval: pending, or the user's explicit approval of this scope.

## Acceptance criteria

- [ ] Observable result or regression to prevent.

## Verification

- Intended checks; replace or supplement with commands and actual results.

## Implementation notes

- Decisions, changed files, remaining work or manual acceptance still required.
```
