# Oneshot Workflow: {{displayName}}

You are running a **oneshot** workflow called `{{name}}`. Oneshot workflows are
prompt-only — there is no STATE.json, no phase tracking, no artifact directory,
and no resume mechanism. Just execute the instructions below and return.

## User Arguments

`{{userArgs}}`

(If empty, use sensible defaults from the workflow body.)

## Workflow Instructions

{{body}}

## Execution Rules

1. **No scaffolding.** Do not create `.gsd/workflows/` directories, STATE.json
   files, or run directories unless the instructions explicitly tell you to
   write a specific artifact.
2. **No branch switching.** Work on the current branch.
3. **Be concise.** Oneshot workflows produce a single focused output (a report,
   a summary, a code change, a PR comment) — finish in this turn.
4. **Ask only when blocked.** If the instructions need information you can't
   discover, ask one clear question. Otherwise proceed.
