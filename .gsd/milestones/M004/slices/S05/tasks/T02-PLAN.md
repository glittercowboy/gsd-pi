---
estimated_steps: 7
estimated_files: 2
---

# T02: Wire reconcile into worktree-command.ts + write integration tests

**Slice:** S05 — Worktree DB Isolation
**Milestone:** M004

## Description

Two pieces of work:

1. **Wire reconcile into `handleMerge`** in `worktree-command.ts` — before the deterministic `mergeWorktreeToMain(basePath, name, commitMessage)` call, reconcile the worktree's `gsd.db` into the main `gsd.db` via dynamic import. This covers the manual `/worktree merge` path.

2. **Write `worktree-db-integration.test.ts`** with 4 integration test cases using real git repo fixtures. The tests prove the wiring added in T01 and T02 works end-to-end.

## Steps

1. In `handleMerge` in `worktree-command.ts`, find the deterministic merge path (the `try { mergeWorktreeToMain(basePath, name, commitMessage); ...` block around line 675). Immediately before `mergeWorktreeToMain(...)`, insert:
   ```typescript
   // Reconcile worktree DB into main DB before squash merge
   const wtDbPath = join(worktreePath(basePath, name), ".gsd", "gsd.db");
   const mainDbPath = join(basePath, ".gsd", "gsd.db");
   if (existsSync(wtDbPath) && existsSync(mainDbPath)) {
     try {
       const { reconcileWorktreeDb } = await import("./gsd-db.js");
       reconcileWorktreeDb(mainDbPath, wtDbPath);
     } catch { /* non-fatal */ }
   }
   ```
   `worktreePath` is already imported from `worktree-manager`. `existsSync` and `join` already imported. Dynamic import is the right pattern here — `worktree-command.ts` is an async command handler.

2. Create `src/resources/extensions/gsd/tests/worktree-db-integration.test.ts`. Use the same scaffold as `auto-worktree.test.ts`: `createTestContext()`, a `createTempRepo()` helper with git init + initial commit, `savedCwd` saved and restored in finally, temp dir cleanup. Import `createAutoWorktree` from `../auto-worktree.ts`, `copyWorktreeDb`, `reconcileWorktreeDb`, `openDatabase`, `closeDatabase`, `upsertDecision`, `isDbAvailable` from `../gsd-db.ts`.

3. **Test case 1 — copy on worktree creation:**
   - Create temp repo, seed `.gsd/gsd.db` by calling `openDatabase(join(tempDir, ".gsd", "gsd.db"))` then `closeDatabase()`
   - Call `createAutoWorktree(tempDir, "M004")` (need to chdir back after)
   - Assert `existsSync(join(worktreePath(tempDir, "M004"), ".gsd", "gsd.db"))` is true
   - Clean up: chdir back to savedCwd, remove temp dir

4. **Test case 2 — copy skip when no source DB:**
   - Create temp repo with no `gsd.db`
   - Call `createAutoWorktree(tempDir, "M004")`
   - Assert `existsSync(join(worktreePath(tempDir, "M004"), ".gsd", "gsd.db"))` is false (no DB in worktree)
   - Assert no error thrown

5. **Test case 3 — reconcile inserts worktree rows into main:**
   - Create two temp DB files (src and dst) using `openDatabase`/`closeDatabase`
   - Insert a test decision row into the worktree DB via `openDatabase(worktreeDbPath)` + `upsertDecision(...)` + `closeDatabase()`
   - Call `reconcileWorktreeDb(mainDbPath, worktreeDbPath)` directly (unit-level — no git repo needed for this assertion)
   - Open main DB, query decisions, assert the inserted row is present
   - Close and clean up

6. **Test case 4 — reconcile is non-fatal when worktree DB absent:**
   - Call `reconcileWorktreeDb("/nonexistent/path/gsd.db", "/also/nonexistent/gsd.db")` — must not throw (function handles missing file internally)
   - Assert true (no exception = pass)

7. Run the integration tests:
   ```bash
   node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test \
     src/resources/extensions/gsd/tests/worktree-db-integration.test.ts
   ```
   All 4 test cases must pass. Then run `npx tsc --noEmit` and `npm test`.

## Must-Haves

- [ ] `handleMerge` reconciles worktree DB before `mergeWorktreeToMain` using dynamic import + file-presence guard
- [ ] `worktree-db-integration.test.ts` created with ≥4 assertions covering copy, copy-skip, reconcile, and reconcile-skip
- [ ] All integration tests pass
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` zero regressions

## Verification

```bash
# Integration tests
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db-integration.test.ts

# Existing worktree-db unit tests
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db.test.ts

npx tsc --noEmit
npm test
```

## Observability Impact

- Signals added/changed: copy and reconcile failures in `auto-worktree.ts` are swallowed (non-fatal by design). Reconcile failures in `worktree-command.ts` are also swallowed. No new log lines added — consistent with existing non-fatal pattern in `copyPlanningArtifacts`.
- How a future agent inspects this: query the main DB's `decisions` table after a merge to verify reconciliation worked. `isDbAvailable()` + `queryDecisions()` from `context-store.ts`.
- Failure state exposed: silent. If reconciliation fails, the main DB simply won't have the worktree's rows — discoverable via `/gsd inspect` (S06).

## Inputs

- `src/resources/extensions/gsd/worktree-command.ts` — target for reconcile hook; `handleMerge` function; `worktreePath` already imported; `existsSync` and `join` already imported; function is async so dynamic import works
- `src/resources/extensions/gsd/gsd-db.ts` — `reconcileWorktreeDb(mainDbPath, worktreeDbPath)`, `copyWorktreeDb(srcDbPath, destDbPath)`, `openDatabase(path)`, `closeDatabase()`, `upsertDecision(...)`, `isDbAvailable()` — all synchronous
- `src/resources/extensions/gsd/auto-worktree.ts` — `createAutoWorktree` for integration test case 1
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — reference for test scaffold pattern (createTempRepo, savedCwd, cleanup pattern)
- `src/resources/extensions/gsd/tests/test-helpers.ts` — `createTestContext()` for assertEq/assertTrue/report

## Expected Output

- `src/resources/extensions/gsd/worktree-command.ts` — modified: reconcile block before `mergeWorktreeToMain` call in `handleMerge`
- `src/resources/extensions/gsd/tests/worktree-db-integration.test.ts` — new file with ≥4 integration assertions
