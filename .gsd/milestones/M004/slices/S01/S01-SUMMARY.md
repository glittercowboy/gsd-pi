---
id: S01
parent: M004
milestone: M004
provides:
  - gsd-db.ts — SQLite abstraction with tiered provider chain (node:sqlite → better-sqlite3 → null), schema init, typed CRUD wrappers, WAL mode, transaction support, worktree DB copy/reconcile
  - context-store.ts — query layer with filtering (milestone/scope/slice/status) and prompt formatters
  - Decision and Requirement TypeScript interfaces in types.ts
  - 133 assertions across 3 test files proving DB layer, query layer, and worktree operations
requires:
  - slice: none
    provides: first slice — no upstream dependencies
affects:
  - S02 (importers consume openDatabase, insert wrappers, transaction)
  - S03 (prompt builders consume queryDecisions, queryRequirements, formatters, isDbAvailable)
  - S05 (worktree wiring consumes copyWorktreeDb, reconcileWorktreeDb, openDatabase)
  - S06 (inspect/tools consume upsertDecision, upsertRequirement, insertArtifact, query layer)
key_files:
  - src/resources/extensions/gsd/gsd-db.ts
  - src/resources/extensions/gsd/context-store.ts
  - src/resources/extensions/gsd/types.ts
  - src/resources/extensions/gsd/tests/gsd-db.test.ts
  - src/resources/extensions/gsd/tests/context-store.test.ts
  - src/resources/extensions/gsd/tests/worktree-db.test.ts
key_decisions:
  - D048 — createRequire(import.meta.url) for module loading instead of bare require(), ensuring ESM compatibility in node test runner while working in pi's jiti CJS runtime
  - initSchema kept internal (called by openDatabase), not exported — matches source behavior
patterns_established:
  - createRequire(import.meta.url) for native module loading in ESM-compatible contexts
  - eslint-disable-next-line @typescript-eslint/no-require-imports before each dynamic require
  - --experimental-sqlite flag required for node:sqlite under Node 22 test runner
  - DbAdapter normalizes null-prototype rows from node:sqlite via spread
  - All query/format functions guard with isDbAvailable() and return empty results on unavailable DB
observability_surfaces:
  - getDbProvider() returns 'node:sqlite' | 'better-sqlite3' | null
  - isDbAvailable() boolean for connection status
  - Provider chain failures logged to stderr with attempted providers listed
  - Worktree operations log copy errors, reconciliation counts, and conflict details to stderr
drill_down_paths:
  - .gsd/milestones/M004/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004/slices/S01/tasks/T02-SUMMARY.md
duration: 17m
verification_result: passed
completed_at: 2026-03-15
---

# S01: DB Foundation + Schema

**SQLite DB foundation with tiered provider chain, typed CRUD wrappers, query layer with filtering/formatters, worktree DB copy/reconcile — 133 assertions proving all contracts**

## What Happened

Ported the SQLite abstraction layer from the memory-db reference worktree into the current M004 worktree, adapting it to the current architecture.

**T01 (5m):** Appended `Decision` and `Requirement` interfaces to `types.ts` (27 lines). Ported `gsd-db.ts` (~550 lines) with the full tiered provider chain (`node:sqlite` → `better-sqlite3` → null), schema initialization (decisions, requirements, artifacts tables + filtered views), typed insert/upsert/query wrappers, WAL mode, transaction support, and worktree DB operations (`copyWorktreeDb`, `reconcileWorktreeDb`). Initially used bare `require()` matching the native-git-bridge.ts pattern.

**T02 (12m):** Ported `context-store.ts` (195 lines) — the query layer with `queryDecisions()`, `queryRequirements()`, `queryArtifact()`, `queryProject()` plus `formatDecisionsForPrompt()` and `formatRequirementsForPrompt()`. Ported all three test files as direct copies from memory-db. Tests exposed that bare `require()` fails under node's native ESM test runner — fixed by switching `gsd-db.ts` to `createRequire(import.meta.url)`, which works in both pi's jiti CJS runtime and native ESM. Added `--experimental-sqlite` flag to test command (required for Node 22).

## Verification

- **gsd-db.test.ts**: 41 assertions — provider detection, schema init, CRUD for all 3 tables, filtered views, WAL mode, transactions, fallback behavior when DB unavailable
- **context-store.test.ts**: 56 assertions — query filtering by milestone/scope/slice/status, prompt formatters, performance timing (0.22ms for 100 rows), artifact queries, project queries, graceful fallback
- **worktree-db.test.ts**: 36 assertions — DB file copy, reconciliation via ATTACH DATABASE, conflict detection (modified in both main and worktree), DETACH cleanup, multi-table reconciliation
- **Total: 133 new assertions, all passing**
- **Existing tests**: 361/361 pass, zero regressions
- **TypeScript**: `npx tsc --noEmit` clean, no errors
- **Test command**: `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-db.test.ts src/resources/extensions/gsd/tests/context-store.test.ts src/resources/extensions/gsd/tests/worktree-db.test.ts`

## Requirements Advanced

- R045 — Fully proven: tiered provider chain loads, schema inits with all 3 tables + views, CRUD wrappers work, WAL mode enabled, DbAdapter normalizes null-prototype rows. 41 DB-layer assertions + 56 query-layer assertions.
- R046 — DB layer portion proven: all query functions return empty arrays/null when DB unavailable, no crash. Prompt builder fallback (S03 supporting slice) not yet wired.
- R053 — Function implemented and tested: `copyWorktreeDb` copies DB file, skips WAL/SHM. 36 worktree assertions. Wiring into `createWorktree` deferred to S05.
- R054 — Function implemented and tested: `reconcileWorktreeDb` uses ATTACH DATABASE with INSERT OR REPLACE in transaction, conflict detection by content comparison. Wiring deferred to S05.

## Requirements Validated

- R045 — SQLite DB layer with tiered provider chain: 133 assertions prove provider detection, schema init, CRUD, views, WAL, transactions, query filtering, formatters, worktree operations, and graceful fallback. Full contract verified.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- **T01 require() pattern reversed in T02**: T01 used bare `require()` matching native-git-bridge.ts. T02 discovered this fails under node's ESM test runner. Switched to `createRequire(import.meta.url)` matching original memory-db source. Works in both runtimes.
- **Test command needs --experimental-sqlite**: Plan's verification command omitted this flag. Node 22 requires `--experimental-sqlite` to expose `node:sqlite`.

## Known Limitations

- `initSchema` is not exported — called internally by `openDatabase()`. This matches the source behavior but means callers cannot re-initialize schema on an already-open database without closing and reopening.
- The provider chain tries `node:sqlite` first, which requires `--experimental-sqlite` flag under Node 22. Without the flag, it falls through to `better-sqlite3` or null.
- No modules are wired into auto-mode yet. `gsd-db.ts` and `context-store.ts` are standalone modules at this point.

## Follow-ups

- none — all S01 scope is delivered. Downstream wiring is planned in S02–S06.

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — appended Decision and Requirement interfaces (27 lines)
- `src/resources/extensions/gsd/gsd-db.ts` — new file, ~550 lines, tiered SQLite provider chain with CRUD wrappers
- `src/resources/extensions/gsd/context-store.ts` — new file, 195 lines, query layer with filtering and formatters
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — new file, 353 lines, 41 DB layer assertions
- `src/resources/extensions/gsd/tests/context-store.test.ts` — new file, 462 lines, 56 query/formatter assertions
- `src/resources/extensions/gsd/tests/worktree-db.test.ts` — new file, 442 lines, 36 worktree operation assertions

## Forward Intelligence

### What the next slice should know
- `openDatabase(path)` returns `boolean` (success/fail). Call it before any DB operation. `closeDatabase()` must be called for cleanup.
- `isDbAvailable()` is the universal guard — every query/format function checks it internally, but prompt builder code should also check it to decide between DB-query and filesystem-loading paths.
- All CRUD functions are synchronous (SQLite is sync). No async/await needed.
- `transaction(fn)` wraps multiple operations in BEGIN/COMMIT with automatic ROLLBACK on error.
- `queryDecisions({milestone?, scope?, status?})` and `queryRequirements({milestone?, slice?, status?})` return typed arrays. `formatDecisionsForPrompt()` and `formatRequirementsForPrompt()` produce markdown strings ready for prompt injection.

### What's fragile
- `createRequire(import.meta.url)` — works in both jiti CJS and native ESM, but if pi's module system changes, the dynamic require chain for `node:sqlite` and `better-sqlite3` could break. The test suite will catch this immediately (provider detection tests).
- `node:sqlite` null-prototype rows — the DbAdapter's `normalizeRow()` (spread into plain object) is the fix. If `node:sqlite` API changes row behavior, the normalization may need updating.

### Authoritative diagnostics
- `getDbProvider()` — returns which provider actually loaded. If it returns null, the entire DB layer is in fallback mode.
- Test file `gsd-db.test.ts` — the provider detection and schema init tests are the fastest way to verify the foundation works on any environment.

### What assumptions changed
- **Original**: bare `require()` (matching native-git-bridge.ts pattern) would work everywhere. **Actual**: fails under node's native ESM test runner. `createRequire(import.meta.url)` is the correct pattern.
- **Original**: test command didn't need `--experimental-sqlite`. **Actual**: Node 22 requires this flag for `node:sqlite` module access.
