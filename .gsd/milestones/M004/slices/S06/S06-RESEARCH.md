# S06: Structured LLM Tools + /gsd inspect — Research

**Date:** 2026-03-15

## Summary

S06 is straightforward port work. The memory-db reference contains working implementations of all three deliverables — tool registrations in `index.ts`, `handleInspect` + `formatInspectOutput` in `commands.ts`, and unit tests in `gsd-tools.test.ts` / `gsd-inspect.test.ts`. The current M004 codebase already has all the underlying infrastructure these depend on (`gsd-db.ts`, `db-writer.ts`, `context-store.ts`). There are no architectural unknowns.

The work is two files changed (`index.ts`, `commands.ts`) and two test files added (`gsd-tools.test.ts`, `gsd-inspect.test.ts`). The test files are direct copies from memory-db with no adaptation required (same pattern as S03's `prompt-db.test.ts` which also needed zero changes).

## Recommendation

Port memory-db's tool registrations and inspect handler directly into M004. Three changes:
1. Add `import { Type } from "@sinclair/typebox"` to `index.ts` and register 3 tools after the dynamic file tools
2. Add `handleInspect` + `formatInspectOutput` + `InspectData` to `commands.ts`, wire into the handler, add "inspect" to completions
3. Copy `gsd-tools.test.ts` and `gsd-inspect.test.ts` from memory-db

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/index.ts` — Register `gsd_save_decision`, `gsd_update_requirement`, `gsd_save_summary` tools after line 189 (after the dynamic edit tool). Add `import { Type } from "@sinclair/typebox"` — already used throughout the codebase (`get-secrets-from-user.ts`, `context7/index.ts`, `mac-tools/index.ts`) but not yet imported in the GSD `index.ts`. Tools use `dynamic import` for `gsd-db.js` and `db-writer.js` — consistent with existing D049 pattern.

- `src/resources/extensions/gsd/commands.ts` — Add `inspect` to `getArgumentCompletions` subcommands array (line 62–65), add dispatch branch in the `handler` (before the bare `""` case), add `InspectData` interface + `formatInspectOutput` function + `handleInspect` async function. The `handleInspect` function uses `dynamic import` for `gsd-db.js` and calls `_getAdapter()` to run raw SQL queries for counts and recent rows.

- `src/resources/extensions/gsd/db-writer.ts` — Already exports `saveDecisionToDb`, `updateRequirementInDb`, `saveArtifactToDb`, `nextDecisionId`. No changes needed.

- `src/resources/extensions/gsd/gsd-db.ts` — Already exports `isDbAvailable`, `_getAdapter`, `getRequirementById`, `getDecisionById`, `upsertRequirement`. No changes needed.

- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — New file. Port directly from memory-db. Tests `saveDecisionToDb` (D001 auto-assignment, sequential IDs, DB rows, DECISIONS.md written), `updateRequirementInDb` (field updates, original fields preserved, REQUIREMENTS.md written, throws on missing ID), `saveArtifactToDb` (DB row, disk write at correct path for milestone/slice/task levels), DB unavailable path. The test helper imports (`createTestContext`) and DB function imports match M004 exactly — no adaptation needed.

- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` — New file. Port directly from memory-db. Tests pure `formatInspectOutput` function: full output with schema version + counts + recent entries, empty data, null schema version, 5 recent entries, multiline output format. All imports (`createTestContext`, `formatInspectOutput`, `InspectData`) will be valid once `commands.ts` exports them.

### Build Order

**T01**: Add 3 tool registrations to `index.ts` + `handleInspect`/`formatInspectOutput`/`InspectData` to `commands.ts` + inspect wiring. Single task — the two file changes are coupled (both must compile together for `tsc` to pass).

**T02**: Port `gsd-tools.test.ts` and `gsd-inspect.test.ts` from memory-db. Verify tests pass. The tests are pure DB/function tests — no extension loading needed.

### Verification Approach

```bash
# Type check
npx tsc --noEmit

# Run new tests
node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-tools.test.ts
node --experimental-sqlite --import 'data:text/javascript,import{register}from"node:module";import{pathToFileURL}from"node:url";register("ts-node/esm",pathToFileURL("./"))' src/resources/extensions/gsd/tests/gsd-inspect.test.ts

# Or via the test runner
npm test -- --testPathPattern="gsd-tools|gsd-inspect"

# Full suite (no regressions)
npm test
```

**Observable behaviors to confirm:**
- `grep -c "gsd_save_decision\|gsd_update_requirement\|gsd_save_summary" src/resources/extensions/gsd/index.ts` returns ≥3
- `grep "inspect" src/resources/extensions/gsd/commands.ts` shows it in subcommands + handler + `handleInspect` definition
- `exports.InspectData` / `exports.formatInspectOutput` accessible from `commands.ts` for tests

## Constraints

- Tools must use `dynamic import` for `gsd-db.js` and `db-writer.js` inside `execute()` — the D049 pattern. Static imports would risk circular deps (index.ts → gsd-db → ...).
- `gsd_update_requirement` must call `getRequirementById` before updating to return the "not found" error — the underlying `updateRequirementInDb` already throws, but the tool layer should also check first for a clean error message (matching memory-db reference).
- `formatInspectOutput` and `InspectData` must be exported from `commands.ts` (not just module-private) — `gsd-inspect.test.ts` imports them directly.
- The existing unknown-subcommand error message in `commands.ts` handler must be updated to include `inspect`.

## Common Pitfalls

- **Missing `Type` import in `index.ts`** — the current M004 `index.ts` doesn't import `Type` from `@sinclair/typebox`. Must add it or tool registration will fail at compile time. The package is already a dependency (used by other extensions).
- **`_getAdapter()` null check in `handleInspect`** — adapter can be null even when `isDbAvailable()` is true briefly during teardown. The memory-db reference checks for null before use and returns early — copy that guard.
- **Test file import paths** — memory-db tests import from `'../gsd-db.ts'` etc. (no `.js` extension). M004 tests consistently use the same pattern. Verify with existing test files — `db-writer.test.ts` is a direct reference.
