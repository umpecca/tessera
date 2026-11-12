# Task 253: Require task files before implementation

Status: complete (2026-11-11).

## Request

Adapt the task-first workflow from
`../catchacodevibe/.agents/skills/develop-task/SKILL.md` into a root `AGENTS.md`
so agents create or select a task file before starting a work item.

## Scope

- Make the instructions self-contained; no sibling checkout or installed skill
  should be required in future sessions.
- Preserve Tessera's numbered `tasks/NNN-description.md` naming and lightweight
  Markdown task documents.
- Require a task before implementation, including documentation-only changes,
  and confirmation before coding a newly drafted task.
- Record scope, acceptance criteria, verification and honest completion status.
- Keep the RDP backlog fix paused; no application changes belong to this task.
- Approval: the user explicitly requested creating this repository's `AGENTS.md`
  from the sibling repository's task-first skill.

## Acceptance criteria

- [x] Root `AGENTS.md` explicitly requires creating or selecting a task before
  implementation and describes numbering, approval and completion updates.
- [x] Instructions preserve existing task IDs, user work and task boundaries.
- [x] Instructions include a lightweight task template and verification guidance.
- [x] This task records what changed and how it was checked.

## Verification

- Reviewed `AGENTS.md` against the source skill and existing task files. It uses
  Tessera's current naming, not the generic `T_NNN.md` planning-skill convention.
- `git diff --no-index --check /dev/null AGENTS.md` and the equivalent command
  for this task produced no whitespace diagnostics. `--no-index` checks these
  newly created, untracked files; exit status 1 indicates that the files differ
  from `/dev/null`, not a whitespace failure.
- Application tests were not run: only instructions and this task record changed.

## Implementation notes

- Added root `AGENTS.md` with mandatory task selection/creation before changes,
  unique sequential IDs, pre-coding approval, scope boundaries, status updates,
  a task template and evidence-based verification guidance.
- Created this task before writing `AGENTS.md` to follow the new workflow itself.
- No application code, generated assets or product changelog changed. The RDP
  backlog fix remains paused and will need its own task before implementation.
