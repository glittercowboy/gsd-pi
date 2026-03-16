# M004/S01 — DB Foundation + Schema — Research

**Date:** 2026-03-15
**Depth:** Light research — straightforward port of proven code from memory-db worktree into current architecture. Provider chain already validated on Node 22.20.0.

## Summary

S01 creates three new files (`gsd-db.ts`, `context-store.ts`) and adds two interfaces to `types.ts`. The memory-db worktree contains a complete, tested implementation (750 lines for gsd-db.ts, 195 lines for context-store.ts). The port is mechanical — the only adaptation needed is replacing `createRequire(import.meta.url)` with bare `require()` to match how extensions are loaded under pi's jiti CJS shim (see `native-git-bridge.ts` for the established pattern).

`node:sqlite` is confirmed available on this Node version. Colon-prefix named params (`:id`, `:scope`) work. Null-prototype rows are returned and must be normalized via spread — the `normalizeRow` function in gsd-db.ts handles this. All API surface needed (`exec`, `prepare`, `run`, `get`, `all`, `close`) is present on `DatabaseSync`.

## Recommendation

Port gsd-db.ts and context-store.ts from the memory-db worktree with minimal adaptation:

1. Replace `createRequire(import.meta.url)` with bare `require('node:sqlite')` / `require('better-sqlite3')` — matches `native-git-bridge.ts` pattern
2. Remove the `import { createRequire } from 'node:module'` import
3. Add `Decision` and `Requirement` interfaces to `types.ts` (copy from memory-db types.ts lines 300–330)
4. Port test files directly — they use the same `createTestContext()` helpers and `node --test` runner

No architectural decisions to make — D045 (tiered provider chain), D046 (sync createWorktree), D047 (adapt, don't merge) are already established.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/gsd-db.ts` — **NEW**. Port from `.gsd/worktrees/memory-db/src/resources/extensions/gsd/gsd-db.ts` (750 lines). SQLite abstraction layer with tiered provider chain, schema init, CRUD wrappers, worktree DB copy/reconcile. Adaptation: replace `createRequire(import.meta.url)` with bare `require()`.
- `src/resources/extensions/gsd/context-store.ts` — **NEW**. Port from `.gsd/worktrees/memory-db/src/resources/extensions/gsd/context-store.ts` (195 lines). Query layer with `queryDecisions()`, `queryRequirements()`, `queryArtifact()`, `queryProject()` plus prompt formatters. Port directly — no changes needed.
- `src/resources/extensions/gsd/types.ts` — **MODIFY**. Append `Decision` and `Requirement` interfaces at the end (30 lines from memory-db types.ts lines 300–330).
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — **NEW**. Port from memory-db (250 lines). Tests: provider detection, schema init, CRUD, views, WAL mode, transactions, fallback behavior.
- `src/resources/extensions/gsd/tests/context-store.test.ts` — **NEW**. Port from memory-db (310 lines). Tests: query filtering by milestone/scope/slice/status, formatters, sub-5ms timing, artifact queries, fallback.
- `src/resources/extensions/gsd/tests/worktree-db.test.ts` — **NEW**. Port from memory-db (290 lines). Tests: copyWorktreeDb, reconcileWorktreeDb with merge, conflict detection, DETACH cleanup.
- `src/resources/extensions/gsd/native-git-bridge.ts` — **REFERENCE ONLY**. Shows the established pattern for loading native modules under jiti: bare `require()` with try/catch, module-level `let loadAttempted = false` guard.

### Build Order

1. **Types first** — Add `Decision` and `Requirement` interfaces to `types.ts`. Zero-risk, unblocks everything.
2. **gsd-db.ts** — Port the DB layer. This is the foundation — context-store.ts and all tests depend on it. The single adaptation (require pattern) is the only risk.
3. **context-store.ts** — Port the query layer. Depends on gsd-db.ts exports. No changes from memory-db source.
4. **Tests** — Port all three test files. Run them to prove the provider chain loads, schema initializes, CRUD works, queries return correct filtered results, and worktree copy/reconcile works.

### Verification Approach

```bash
# Run all three test files
cd /Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/M004
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/gsd-db.test.ts \
  src/resources/extensions/gsd/tests/context-store.test.ts \
  src/resources/extensions/gsd/tests/worktree-db.test.ts

# TypeScript compile check
npx tsc --noEmit

# Run existing tests to verify zero regressions
npm run test:unit
```

Expected results:
- `gsd-db.test.ts`: ~30 assertions (provider detection, schema init, CRUD, views, WAL, transactions, fallback)
- `context-store.test.ts`: ~35 assertions (query filtering, formatters, timing, artifacts, fallback)
- `worktree-db.test.ts`: ~30 assertions (copy, reconcile, conflicts, cleanup)
- All existing tests pass unchanged
- `tsc --noEmit` clean

## Constraints

- `import.meta.url` does NOT work under pi's jiti CJS shim — must use bare `require()` for native module loading (proven by `native-git-bridge.ts` pattern)
- `node:sqlite` returns null-prototype rows (`Object.getPrototypeOf(row) === null`) — the `normalizeRow()` spread in DbAdapter handles this
- Named SQL params must use colon-prefix (`:id`, `:scope`) for `node:sqlite` compatibility — verified working on current Node version
- `suppressSqliteWarning()` must be called before `require('node:sqlite')` to avoid `ExperimentalWarning` noise in user-facing output
- `reconcileWorktreeDb` uses `ATTACH DATABASE '${path}'` — single-quote injection guard already in memory-db code (rejects paths containing `'`)
- `createWorktree` must remain synchronous per D046 — `copyWorktreeDb` uses `copyFileSync` which is fine

## Common Pitfalls

- **`stmt.run()` with named params must pass an object, not spread args** — `node:sqlite` and `better-sqlite3` differ here; the DbAdapter normalizes this by always passing through
- **`INSERT OR REPLACE` resets `seq` AUTOINCREMENT on decisions** — the reconcile function explicitly excludes `seq` column to let the main DB auto-assign, avoiding PK conflicts
- **`ATTACH` must happen outside a transaction** — the reconcile function's ATTACH/BEGIN/COMMIT/DETACH ordering is already correct in memory-db code
- **Format mismatch in requirement headers** — actual REQUIREMENTS.md uses `### R045 — Description` (em-dash) but `formatRequirementsForPrompt` outputs `### R001: Description` (colon). This is fine for S01 — the formatter is for prompt injection, not file regeneration. S02/S06 handle the regeneration format.
