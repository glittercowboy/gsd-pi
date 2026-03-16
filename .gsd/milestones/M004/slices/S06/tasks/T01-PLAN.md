---
estimated_steps: 6
estimated_files: 2
---

# T01: Register 3 LLM tools in index.ts + wire /gsd inspect in commands.ts

**Slice:** S06 — Structured LLM Tools + /gsd inspect
**Milestone:** M004

## Description

Port the 3 structured LLM tool registrations from the memory-db reference into `index.ts`, and add the full `/gsd inspect` implementation to `commands.ts`. These two files must compile together — both changes land in this task.

The tool registrations use the D049 dynamic-import pattern already established in S03: `await import("./gsd-db.js")` and `await import("./db-writer.js")` inside each `execute()` function. The memory-db source is a verbatim port — no adaptation needed. `Type` from `@sinclair/typebox` is the only missing import in `index.ts`.

The inspect handler uses `_getAdapter()` to run raw SQL for counts and recent entries, wrapped in a `try/catch` with a null guard.

## Steps

1. Add `import { Type } from "@sinclair/typebox"` as line 27 in `index.ts` (after the existing `createBashTool` import line)
2. After `pi.registerTool(dynamicEdit as any)` (line 189), insert the `gsd_save_decision` registration block from memory-db verbatim
3. After `gsd_save_decision`, insert `gsd_update_requirement` registration block verbatim
4. After `gsd_update_requirement`, insert `gsd_save_summary` registration block verbatim
5. In `commands.ts` `getArgumentCompletions`, add `"inspect"` to the subcommands array (after `"steer"`)
6. In `commands.ts` `handler`, add `if (trimmed === "inspect") { await handleInspect(ctx); return; }` before the `if (trimmed === "")` branch
7. Update the unknown-subcommand `ctx.ui.notify` error string to include `inspect`
8. Append `InspectData` interface, `formatInspectOutput` function (exported), and `handleInspect` async function from memory-db verbatim — placed before the `handlePrefsWizard` section at the bottom of `commands.ts`
9. Run `npx tsc --noEmit` and verify zero errors

## Must-Haves

- [ ] `import { Type } from "@sinclair/typebox"` added to `index.ts`
- [ ] All 3 tool registrations present: `gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary`
- [ ] Each tool's `execute()` uses `await import("./gsd-db.js")` — no static DB imports
- [ ] `gsd_update_requirement` checks `getRequirementById` before updating and returns `isError: true` with "not found" if missing
- [ ] All 3 tools return `isError: true` when `isDbAvailable()` returns false
- [ ] `inspect` added to `commands.ts` subcommands array
- [ ] `handleInspect` dispatch branch added before the `""` case in handler
- [ ] `InspectData` interface and `formatInspectOutput` exported from `commands.ts`
- [ ] `npx tsc --noEmit` clean

## Verification

```bash
npx tsc --noEmit
grep -c "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary" src/resources/extensions/gsd/index.ts
# Must return ≥ 3

grep "inspect" src/resources/extensions/gsd/commands.ts
# Must show: subcommands array entry, handler dispatch, handleInspect definition, formatInspectOutput, InspectData
```

## Inputs

- `src/resources/extensions/gsd/index.ts` — add after line 189 (after dynamicEdit registerTool)
- `src/resources/extensions/gsd/commands.ts` — add inspect to subcommands + handler + append inspect functions
- `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/index.ts` — source for tool registration blocks (lines 190–420)
- `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/commands.ts` — source for InspectData, formatInspectOutput, handleInspect (lines 312–394)

## Expected Output

- `src/resources/extensions/gsd/index.ts` — 3 additional `pi.registerTool` blocks after line 189; `Type` import added
- `src/resources/extensions/gsd/commands.ts` — `inspect` in subcommands; `handleInspect` dispatch; `InspectData`, `formatInspectOutput`, `handleInspect` implementations appended

## Observability Impact

- **New stderr signals**: Each tool writes `gsd-db: <tool_name> tool failed: <message>` to stderr on execute error. `/gsd inspect` writes `gsd-db: /gsd inspect failed: <message>` on DB query failure. These are grepable from process logs.
- **DB unavailability path**: `isDbAvailable()` returns false → all 3 tools return `{ isError: true, details: { error: "db_unavailable" } }` without touching the DB. This is the expected pre-init path.
- **Inspect as diagnostic command**: After any DB write, `/gsd inspect` immediately verifies counts and surfaces recent entries. A future agent can run it to confirm tool calls landed.
- **Tool return shape**: All success returns include a `details` object (`{ operation, id/path }`) alongside the text content — parseable by a supervising agent for structured confirmation.
