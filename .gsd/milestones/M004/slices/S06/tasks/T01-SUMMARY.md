---
id: T01
parent: S06
milestone: M004
provides:
  - 3 LLM tool registrations (gsd_save_decision, gsd_update_requirement, gsd_save_summary) in index.ts
  - /gsd inspect command wired in commands.ts with InspectData, formatInspectOutput, handleInspect
key_files:
  - src/resources/extensions/gsd/index.ts
  - src/resources/extensions/gsd/commands.ts
key_decisions:
  - Verbatim port from memory-db reference — no adaptation needed; dynamic-import pattern (D049) maintained in all 3 tool execute() bodies
patterns_established:
  - All LLM tool execute() bodies use await import("./gsd-db.js") and await import("./db-writer.js") — no static DB imports at module level
  - isDbAvailable() checked first in every tool; returns isError:true with db_unavailable error before any DB call
  - handleInspect uses _getAdapter() for raw SQL with null guard + try/catch + stderr signal on failure
observability_surfaces:
  - stderr: gsd-db: <tool_name> tool failed: <message> on execute error for all 3 tools
  - stderr: gsd-db: /gsd inspect failed: <message> on inspect DB query failure
  - /gsd inspect command: shows schema version, table counts (decisions/requirements/artifacts), 5 most recent of each
  - Tool return details object: { operation, id/path } on success for structured agent confirmation
duration: ~20m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Register 3 LLM tools in index.ts + wire /gsd inspect in commands.ts

**Ported 3 LLM tool registrations from memory-db into index.ts and wired /gsd inspect in commands.ts — tsc clean, all must-haves verified.**

## What Happened

Added `import { Type } from "@sinclair/typebox"` to index.ts (after the `createBashTool` import line). Inserted the 3 `pi.registerTool` blocks verbatim after `pi.registerTool(dynamicEdit as any)`: `gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary`. All 3 use the D049 dynamic-import pattern — `await import("./gsd-db.js")` and `await import("./db-writer.js")` inside `execute()`, never at module level.

In commands.ts: added `"inspect"` to the subcommands autocomplete array; inserted `if (trimmed === "inspect") { await handleInspect(ctx); return; }` before the bare `""` case in the handler; updated the unknown-subcommand error string to include `inspect`. Appended `InspectData` interface (exported), `formatInspectOutput` function (exported), and `handleInspect` async function verbatim from memory-db — placed before the Preferences Wizard section.

Also applied the pre-flight observability fixes: added `## Observability / Diagnostics` and diagnostic failure-path check to S06-PLAN.md, and `## Observability Impact` to T01-PLAN.md.

## Verification

```
npx tsc --noEmit
→ (no output — zero errors)

grep -c "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary" src/resources/extensions/gsd/index.ts
→ 9

grep -n "handleInspect\|InspectData\|formatInspectOutput" src/resources/extensions/gsd/commands.ts
→ line 272: await handleInspect(ctx);
→ line 410: export interface InspectData {
→ line 417: export function formatInspectOutput(data: InspectData): string {
→ line 445: async function handleInspect(ctx: ExtensionCommandContext): Promise<void> {
```

All must-haves confirmed. T02 (test files) is the remaining task in S06.

## Diagnostics

- `/gsd inspect` runs raw SQL: `SELECT MAX(version) FROM schema_version`, `SELECT count(*) FROM decisions/requirements/artifacts`, `SELECT id, decision, choice FROM decisions ORDER BY seq DESC LIMIT 5`, `SELECT id, status, description FROM requirements ORDER BY id DESC LIMIT 5`
- Failure path: stderr `gsd-db: /gsd inspect failed: <err>` → user sees `ctx.ui.notify("Failed to inspect GSD database...", "error")`
- DB unavailable path for tools: `isDbAvailable()` → false → `{ isError: true, details: { error: "db_unavailable" } }` returned immediately

## Deviations

None — verbatim port as planned.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/index.ts` — Added `Type` import; inserted 3 `pi.registerTool` registrations after `dynamicEdit` registration
- `src/resources/extensions/gsd/commands.ts` — Added `inspect` to subcommands; added `handleInspect` dispatch; updated error string; appended `InspectData`, `formatInspectOutput`, `handleInspect`
- `.gsd/milestones/M004/slices/S06/S06-PLAN.md` — Added `## Observability / Diagnostics` section; added diagnostic checks to Verification; marked T01 done
- `.gsd/milestones/M004/slices/S06/tasks/T01-PLAN.md` — Added `## Observability Impact` section
