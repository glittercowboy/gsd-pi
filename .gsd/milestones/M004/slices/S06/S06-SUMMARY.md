---
id: S06
parent: M004
milestone: M004
provides:
  - gsd_save_decision LLM tool: auto-assigns D-numbers, writes to DB, regenerates DECISIONS.md
  - gsd_update_requirement LLM tool: verifies existence, updates DB, regenerates REQUIREMENTS.md
  - gsd_save_summary LLM tool: writes artifact to DB and disk at computed path
  - /gsd inspect command: schema version, table row counts, 5 most-recent decisions/requirements
  - InspectData interface and formatInspectOutput function (both exported from commands.ts)
  - gsd-tools.test.ts: 35 assertions (ID sequencing, DB rows, markdown regen, error paths, unavailable fallback)
  - gsd-inspect.test.ts: 32 assertions (formatInspectOutput output shape across 5 scenarios)
requires:
  - slice: S03
    provides: context-store.ts query layer, dual-write infrastructure (re-import pattern), gsd-db.ts upsert wrappers
  - slice: S01
    provides: gsd-db.ts upsertDecision/upsertRequirement/insertArtifact, isDbAvailable(), _getAdapter()
  - slice: S02
    provides: db-writer.ts generateDecisionsMd/generateRequirementsMd/saveDecisionToDb/updateRequirementInDb/saveArtifactToDb/nextDecisionId
affects:
  - S07
key_files:
  - src/resources/extensions/gsd/index.ts
  - src/resources/extensions/gsd/commands.ts
  - src/resources/extensions/gsd/tests/gsd-tools.test.ts
  - src/resources/extensions/gsd/tests/gsd-inspect.test.ts
key_decisions:
  - D049 maintained — all 3 tool execute() bodies use await import("./gsd-db.js") and await import("./db-writer.js"); no static DB imports at module level
  - isDbAvailable() checked first in every tool; returns isError:true with details.error="db_unavailable" before any DB call
  - handleInspect uses _getAdapter() for raw SQL with null guard + try/catch + stderr signal on failure
patterns_established:
  - LLM tool execute() body pattern: isDbAvailable() guard → dynamic import gsd-db.js + db-writer.js → DB write → markdown regen → return result shape
  - DB-unavailable early return: { isError: true, details: { error: "db_unavailable", message: "..." } } — no DB call attempted
  - Inspect uses raw SQL via _getAdapter(), not the typed query wrappers — enables schema_version query that typed layer doesn't expose
  - formatInspectOutput is a pure function (no side effects) — testable without DB
observability_surfaces:
  - stderr: "gsd-db: <tool_name> tool failed: <message>" on execute() error for all 3 tools
  - stderr: "gsd-db: /gsd inspect failed: <message>" on inspect DB query failure
  - /gsd inspect: schema version, counts per table (decisions/requirements/artifacts), 5 most recent decisions (D-number + choice), 5 most recent requirements (R-number + status + description)
  - Tool return details: { operation, id } on decision save; { operation, id, status } on requirement update; { operation, path, type } on summary save
drill_down_paths:
  - .gsd/milestones/M004/slices/S06/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004/slices/S06/tasks/T02-SUMMARY.md
duration: ~30m (T01: ~20m, T02: ~10m)
verification_result: passed
completed_at: 2026-03-15
---

# S06: Structured LLM Tools + /gsd inspect

**Registered 3 DB-first LLM tools and `/gsd inspect` — closing the DB→markdown write direction and giving the agent a diagnostic surface for DB state.**

## What Happened

T01 ported the 3 tool registrations and `/gsd inspect` from the memory-db reference into the current codebase. All 3 `pi.registerTool` calls were inserted in `index.ts` after the `dynamicEdit` registration, following the D049 dynamic-import pattern established in S03. The `handleInspect` function, `InspectData` interface, and `formatInspectOutput` formatter were appended to `commands.ts`, with `inspect` added to the subcommands autocomplete array and a dispatch branch inserted before the bare `""` case.

T02 ported the two test files verbatim from the memory-db worktree. Import paths matched M004 layout exactly — zero adaptation required. Tests were run with the M004 standard runner (`resolve-ts.mjs --experimental-strip-types --test`), not the ts-node command in the task plan (ts-node is not installed; Node v25.5.0 has node:sqlite built-in without `--experimental-sqlite`).

The slice delivers the DB→markdown write direction that S03 left for later (R050's "structured tools write to DB first, then regenerate markdown"). Combined with S03's markdown→DB re-import in `handleAgentEnd`, the dual-write loop is now complete.

## Verification

- `npx tsc --noEmit` → zero errors
- `grep -c "gsd_save_decision|gsd_update_requirement|gsd_save_summary" index.ts` → 9 (3 per tool: name string, schema ref, function call site)
- `grep "inspect" commands.ts` → 5 matches (subcommands array, handler dispatch, error message, handleInspect function, formatInspectOutput function)
- `gsd-tools.test.ts`: **35 passed, 0 failed** — ID auto-assignment (D001→D002→D003 sequential), DB row verification, DECISIONS.md regeneration, REQUIREMENTS.md regeneration, error path for missing requirement (throws with ID in message), DB-unavailable fallback (nextDecisionId returns D001, no throw), saveArtifactToDb at slice/milestone/task path levels, tool result shape
- `gsd-inspect.test.ts`: **32 passed, 0 failed** — formatInspectOutput: full output, empty data, null schema version → "unknown", 5-entry lists, multiline text format (not JSON)
- `npm test` → all non-pre-existing tests pass; pack-install.test.ts failure (dist/ not found) is pre-existing and unrelated

## Requirements Advanced

- R055 (Structured LLM tools for decisions/requirements/summaries) — all 3 tools registered, tested, and functional
- R056 (/gsd inspect command) — wired in commands.ts with autocomplete, inspect output proven by 32 assertions
- R050 (Dual-write keeping markdown and DB in sync) — DB→markdown direction now complete; both directions wired

## Requirements Validated

- R055 — 35 assertions in gsd-tools.test.ts prove ID auto-assignment, DB row creation, markdown regeneration, error paths, and DB-unavailable fallback for all 3 tools
- R056 — 32 assertions in gsd-inspect.test.ts prove formatInspectOutput format across all 5 scenarios; handleInspect wired in handler dispatch with subcommand autocomplete
- R048 (Round-trip fidelity) — supporting evidence: gsd_save_decision and gsd_update_requirement use generateDecisionsMd/generateRequirementsMd as write path, same generators proven in S02 db-writer.test.ts 127 assertions
- R050 — both directions complete: markdown→DB (handleAgentEnd, S03) + DB→markdown (structured tools, S06)

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- **Test runner command**: Task plan specified ts-node-based invocation; correct command for M004 is `resolve-ts.mjs --experimental-strip-types --test`. Same test outcome, different runner. `--experimental-sqlite` flag omitted (Node v25.5.0 ships node:sqlite built-in).
- No other deviations — verbatim port as planned.

## Known Limitations

- `/gsd inspect` subcommand filtering (decisions / requirements / artifacts / all) from R056 notes is not implemented — the command shows all tables unconditionally. The memory-db reference did not implement per-table filtering either; the autocomplete entries route to a single handler.
- `gsd_save_summary` writes to DB and disk at the path computed from the artifact type/milestone/slice/task fields, but does not trigger a re-import of the full markdown hierarchy — it inserts a single artifact row. This is correct behavior but means a subsequent `/gsd inspect` shows the artifact count while `deriveState()` will pick up the DB row on next invocation.

## Follow-ups

- S07 integration verification should exercise the complete dual-write loop: LLM calls `gsd_save_decision` → row lands in DB → DECISIONS.md regenerated → `migrateFromMarkdown` re-import (handleAgentEnd) is idempotent against the just-generated file.
- The 5-entry limit in `/gsd inspect` recent lists is hardcoded. If projects grow large, a `--limit N` option would be useful. Deferred.

## Files Created/Modified

- `src/resources/extensions/gsd/index.ts` — Added `Type` import from `@sinclair/typebox`; inserted 3 `pi.registerTool` registrations (gsd_save_decision, gsd_update_requirement, gsd_save_summary) after dynamicEdit registration
- `src/resources/extensions/gsd/commands.ts` — Added `inspect` to subcommands autocomplete array; added `handleInspect` dispatch branch; updated unknown-subcommand error string; appended `InspectData` interface (exported), `formatInspectOutput` function (exported), `handleInspect` async function
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — new file, 326 lines, verbatim port from memory-db; 35 assertions
- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` — new file, 118 lines, verbatim port from memory-db; 32 assertions

## Forward Intelligence

### What the next slice should know
- The 3 structured tools use dynamic import (D049) — any integration test that calls them will need to `await` the execute() call and ensure the test process has node:sqlite available (it does on Node 22.5+; no flag needed on v25.5.0).
- `formatInspectOutput` is a pure function with no DB dependency — it can be called directly in tests without opening a DB connection. `handleInspect` is the side-effectful counterpart that opens the DB and feeds data to `formatInspectOutput`.
- The dual-write loop is now complete: markdown→DB (handleAgentEnd re-import, S03) + DB→markdown (structured tools, S06). S07 integration verification should exercise both directions in sequence to confirm they compose correctly.

### What's fragile
- `/gsd inspect` uses `_getAdapter()` (underscore prefix = internal/private convention) directly for raw SQL. If the DB adapter interface changes, inspect will break silently — it bypasses the typed query wrappers. Low risk for S07, but worth noting for any future refactor of gsd-db.ts internals.
- The `nextDecisionId()` function returns `'D001'` when the DB is unavailable (no throw). This means a repeated call with DB unavailable always returns `'D001'`, which would produce duplicate IDs if a caller doesn't check `isDbAvailable()` first. All 3 tools do check `isDbAvailable()` before calling db-writer functions, so this is safe in practice.

### Authoritative diagnostics
- `/gsd inspect` is the primary diagnostic surface for DB state after tool calls — run it to confirm counts incremented and recent entries appear.
- `gsd-tools.test.ts` "DB unavailable error paths" section is the authoritative spec for what each function does when DB is absent.
- `npm test` full suite baseline: all non-pre-existing tests pass. Pack-install.test.ts is a known pre-existing failure (needs built dist/).

### What assumptions changed
- T02 task plan assumed ts-node was available — it is not in this environment. The M004 standard runner (`resolve-ts.mjs --experimental-strip-types --test`) is the correct invocation for all test files in this worktree.
