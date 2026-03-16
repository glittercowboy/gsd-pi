# S06: Structured LLM Tools + /gsd inspect

**Goal:** Register 3 structured LLM tools (`gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary`) and wire `/gsd inspect` — completing the DB-first write path and closing the R055/R056 requirements.

**Demo:** LLM can call `gsd_save_decision` and get back an auto-assigned D-number with DECISIONS.md regenerated on disk. `/gsd inspect` displays schema version, table counts, and recent entries.

## Must-Haves

- `gsd_save_decision` tool registered: auto-assigns ID, writes to DB, regenerates DECISIONS.md
- `gsd_update_requirement` tool registered: verifies existence, updates DB, regenerates REQUIREMENTS.md
- `gsd_save_summary` tool registered: writes artifact to DB and disk at computed path
- All 3 tools return `isError: true` when DB unavailable
- `/gsd inspect` command: shows schema version, row counts, recent decisions/requirements
- `inspect` in subcommands autocomplete array
- `formatInspectOutput` and `InspectData` exported from `commands.ts`
- `npx tsc --noEmit` clean
- `gsd-tools.test.ts` passes (DB write + DECISIONS.md/REQUIREMENTS.md round-trip, all 3 tools, DB-unavailable path)
- `gsd-inspect.test.ts` passes (formatInspectOutput output format, all 5 scenarios)

## Proof Level

- This slice proves: contract (DB-first tool writes, inspect formatting)
- Real runtime required: yes (tests run against real SQLite DB)
- Human/UAT required: no

## Verification

```bash
# Type check
npx tsc --noEmit

# Tool tests (DB writes, markdown regeneration, error paths)
node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-tools.test.ts

# Inspect formatting tests (pure function)
node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-inspect.test.ts

# Smoke checks
grep -c "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary" src/resources/extensions/gsd/index.ts
grep "inspect" src/resources/extensions/gsd/commands.ts

# Diagnostic: verify DB-unavailable error path returns isError:true (tested in gsd-tools.test.ts "db_unavailable" assertions)
# Diagnostic: verify /gsd inspect stderr output when DB absent (tested in gsd-inspect.test.ts)

# Full suite (no regressions)
npm test
```

## Integration Closure

- Upstream surfaces consumed: `gsd-db.ts` (isDbAvailable, _getAdapter, getRequirementById, upsertRequirement), `db-writer.ts` (saveDecisionToDb, updateRequirementInDb, saveArtifactToDb, nextDecisionId), `context-store.ts` (query layer)
- New wiring introduced: 3 `pi.registerTool` calls after line 189 in `index.ts`; `handleInspect` + `formatInspectOutput` + `InspectData` in `commands.ts` with handler dispatch + autocomplete entry
- What remains before milestone is usable end-to-end: S07 integration verification

## Observability / Diagnostics

- **Runtime signals**: All 3 LLM tools write to `stderr` on failure (`gsd-db: gsd_save_decision tool failed: ...`, etc.) with structured `details` payload in the tool return object. The `isError: true` flag surfaces to the LLM immediately.
- **DB unavailability**: Each tool returns `{ isError: true, details: { error: "db_unavailable" } }` when `isDbAvailable()` is false — LLM receives actionable message.
- **Inspect surface**: `/gsd inspect` runs raw SQL against the live DB to show schema version, row counts for all 3 tables, and the 5 most recent decisions/requirements. Use this to verify DB writes landed.
- **Failure visibility**: `/gsd inspect` writes to `stderr` on failure with `gsd-db: /gsd inspect failed: <message>` then shows user-facing error via `ctx.ui.notify(..., "error")`. Check stderr when inspect returns an error notification.
- **Diagnostic command**: After any DB write, run `/gsd inspect` to confirm counts incremented and entries appear in recent lists.
- **Redaction**: No secrets or credentials flow through these tools. DB path is filesystem-local only.

## Tasks

- [x] **T01: Register 3 LLM tools in index.ts + wire /gsd inspect in commands.ts** `est:30m`
  - Why: Core deliverable — both changes must compile together, registering tools is useless without the matching inspect command for DB visibility.
  - Files: `src/resources/extensions/gsd/index.ts`, `src/resources/extensions/gsd/commands.ts`
  - Do:
    1. Add `import { Type } from "@sinclair/typebox"` to `index.ts` (line 27, after existing imports)
    2. After `pi.registerTool(dynamicEdit as any)` (line 189), add the 3 tool registrations from memory-db verbatim: `gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary`. All use dynamic `import("./gsd-db.js")` and `import("./db-writer.js")` inside `execute()`.
    3. In `commands.ts` subcommands array (line 62–65), add `"inspect"` to the list.
    4. In `commands.ts` `handler`, add a dispatch branch for `trimmed === "inspect"` before the bare `""` case: `await handleInspect(ctx); return;`
    5. Update the unknown-subcommand error message to include `inspect`.
    6. Add `InspectData` interface, `formatInspectOutput` function, and `handleInspect` async function from memory-db verbatim — placed near bottom of file before the Preferences Wizard section. `formatInspectOutput` and `InspectData` must be exported.
  - Verify: `npx tsc --noEmit` returns zero errors; `grep -c "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary" src/resources/extensions/gsd/index.ts` ≥ 3; `grep "inspect" src/resources/extensions/gsd/commands.ts` shows it in subcommands + handler + `handleInspect` + `formatInspectOutput`
  - Done when: tsc clean, all 3 tools present, `/gsd inspect` handler wired

- [x] **T02: Add gsd-tools.test.ts and gsd-inspect.test.ts** `est:20m`
  - Why: Proves DB-first write contract for all 3 tools (ID assignment, markdown regeneration, DB rows, error paths) and validates formatInspectOutput output format.
  - Files: `src/resources/extensions/gsd/tests/gsd-tools.test.ts`, `src/resources/extensions/gsd/tests/gsd-inspect.test.ts`
  - Do:
    1. Copy `gsd-tools.test.ts` from memory-db worktree verbatim: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-tools.test.ts`
    2. Copy `gsd-inspect.test.ts` from memory-db worktree verbatim: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-inspect.test.ts`
    3. No adaptation needed — import paths use `'../gsd-db.ts'`, `'../db-writer.ts'`, `'../commands.ts'`, `'./test-helpers.ts'` which all match M004 layout exactly.
    4. Run both test files and verify all assertions pass.
  - Verify:
    ```bash
    node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-tools.test.ts
    node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-inspect.test.ts
    npm test
    ```
  - Done when: Both test files pass with zero assertion failures; `npm test` passes with no regressions

## Files Likely Touched

- `src/resources/extensions/gsd/index.ts`
- `src/resources/extensions/gsd/commands.ts`
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` (new)
- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` (new)
