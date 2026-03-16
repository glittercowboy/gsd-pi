---
estimated_steps: 5
estimated_files: 4
---

# T02: Port context-store.ts and all test files

**Slice:** S01 — DB Foundation + Schema
**Milestone:** M004

## Description

Port the query/formatting layer (`context-store.ts`) and all three test files from the memory-db worktree. The query layer provides `queryDecisions()`, `queryRequirements()`, `queryArtifact()`, `queryProject()` with filtering by milestone/scope/slice/status, plus `formatDecisionsForPrompt()` and `formatRequirementsForPrompt()`. The test files prove the entire DB foundation works: provider chain, schema, CRUD, views, queries, formatters, worktree copy/reconcile.

## Steps

1. Port `context-store.ts` from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/context-store.ts` to `src/resources/extensions/gsd/context-store.ts` (195 lines). No changes needed — it imports from `./gsd-db.js` and `./types.js` which are now in place from T01.

2. Port `gsd-db.test.ts` from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-db.test.ts` to `src/resources/extensions/gsd/tests/gsd-db.test.ts` (353 lines). Verify imports reference the correct relative paths (`../gsd-db.js`, `./test-helpers.ts`).

3. Port `context-store.test.ts` from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/context-store.test.ts` to `src/resources/extensions/gsd/tests/context-store.test.ts` (462 lines). Verify imports.

4. Port `worktree-db.test.ts` from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/worktree-db.test.ts` to `src/resources/extensions/gsd/tests/worktree-db.test.ts` (442 lines). Verify imports.

5. Run all verification commands:
   - New tests: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-db.test.ts src/resources/extensions/gsd/tests/context-store.test.ts src/resources/extensions/gsd/tests/worktree-db.test.ts`
   - Existing tests: `npm run test:unit`
   - Type check: `npx tsc --noEmit`
   - Fix any import path issues or test failures before marking done.

## Must-Haves

- [ ] context-store.ts ported with all exports: `queryDecisions`, `queryRequirements`, `queryArtifact`, `queryProject`, `formatDecisionsForPrompt`, `formatRequirementsForPrompt`
- [ ] gsd-db.test.ts passes (~30 assertions: provider detection, schema init, CRUD, views, WAL, transactions, fallback)
- [ ] context-store.test.ts passes (~35 assertions: query filtering, formatters, timing, artifacts, fallback)
- [ ] worktree-db.test.ts passes (~30 assertions: copy, reconcile, conflicts, cleanup)
- [ ] All existing tests pass unchanged (zero regressions)
- [ ] `tsc --noEmit` clean

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-db.test.ts src/resources/extensions/gsd/tests/context-store.test.ts src/resources/extensions/gsd/tests/worktree-db.test.ts` — all ~95 assertions pass
- `npm run test:unit` — all existing tests pass, zero regressions
- `npx tsc --noEmit` — clean

## Inputs

- `src/resources/extensions/gsd/gsd-db.ts` — T01 output, provides all DB layer exports
- `src/resources/extensions/gsd/types.ts` — T01 output, provides Decision and Requirement interfaces
- Source: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/context-store.ts` (195 lines)
- Source: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/gsd-db.test.ts` (353 lines)
- Source: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/context-store.test.ts` (462 lines)
- Source: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/worktree-db.test.ts` (442 lines)

## Observability Impact

- **context-store queries** — `queryDecisions()`, `queryRequirements()` silently return `[]` when DB unavailable; no crash, no log
- **artifact queries** — `queryArtifact()`, `queryProject()` return `null` when DB unavailable or path not found
- **Test validation** — 133 assertions across 3 test files verify provider chain, CRUD, views, queries, formatters, worktree copy/reconcile
- **Inspection** — `getDbProvider()` returns `'node:sqlite'` or `'better-sqlite3'`; `isDbAvailable()` confirms connection state

## Expected Output

- `src/resources/extensions/gsd/context-store.ts` — new file, 195 lines, query layer with filtering and formatters
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — new file, ~353 lines
- `src/resources/extensions/gsd/tests/context-store.test.ts` — new file, ~462 lines
- `src/resources/extensions/gsd/tests/worktree-db.test.ts` — new file, ~442 lines
