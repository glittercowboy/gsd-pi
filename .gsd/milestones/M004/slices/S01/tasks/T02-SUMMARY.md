---
id: T02
parent: S01
milestone: M004
provides:
  - context-store.ts query layer with filtering and formatters
  - Complete test coverage for DB foundation (gsd-db, context-store, worktree-db)
key_files:
  - src/resources/extensions/gsd/context-store.ts
  - src/resources/extensions/gsd/tests/gsd-db.test.ts
  - src/resources/extensions/gsd/tests/context-store.test.ts
  - src/resources/extensions/gsd/tests/worktree-db.test.ts
key_decisions:
  - Switched gsd-db.ts from bare require() to createRequire(import.meta.url) for ESM compatibility in node test runner
patterns_established:
  - Tests require --experimental-sqlite flag for node:sqlite provider detection under Node 22
observability_surfaces:
  - queryDecisions/queryRequirements return [] on DB unavailable (no crash)
  - queryArtifact/queryProject return null on DB unavailable or missing path
  - getDbProvider() returns provider name; isDbAvailable() confirms connection
duration: 12m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Port context-store.ts and all test files

**Ported query layer and 3 test files; fixed gsd-db.ts ESM require() for test compatibility — 133 assertions all pass**

## What Happened

Copied `context-store.ts` (195 lines) and all three test files (`gsd-db.test.ts`, `context-store.test.ts`, `worktree-db.test.ts`) from the memory-db worktree. Files were direct copies — no modifications needed to the ported files themselves.

Tests initially failed because `gsd-db.ts` used bare `require()` calls (T01 decision: match native-git-bridge.ts pattern). Under Node's native ESM test runner (`--experimental-strip-types` with `import` statements), bare `require` is not defined. Fixed by adding `createRequire(import.meta.url)` to gsd-db.ts and replacing both bare `require('node:sqlite')` and `require('better-sqlite3')` calls with `_require()`. This matches the original memory-db source and works in both pi's jiti CJS runtime and node's native ESM.

Also added `--experimental-sqlite` to the test command — required for Node 22 to expose `node:sqlite`.

## Verification

- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-db.test.ts src/resources/extensions/gsd/tests/context-store.test.ts src/resources/extensions/gsd/tests/worktree-db.test.ts` — **3/3 files pass, 133 assertions (41 + 56 + 36)**
- `npm run test:unit` — **361/361 pass, zero regressions**
- `npx tsc --noEmit` — **clean, no errors**

### Slice-level verification status (T02 is final task in S01):

- ✅ gsd-db.test.ts: 41 assertions — provider detection, schema init, CRUD, views, WAL, transactions, fallback
- ✅ context-store.test.ts: 56 assertions — query filtering by milestone/scope/slice/status, formatters, timing (0.22ms for 100 rows), artifacts, fallback
- ✅ worktree-db.test.ts: 36 assertions — copy, reconcile, conflicts, DETACH cleanup
- ✅ All existing tests pass unchanged (361/361)
- ✅ `tsc --noEmit` clean

**All S01 slice verification checks pass.**

## Diagnostics

- `getDbProvider()` returns `'node:sqlite'` or `'better-sqlite3'` depending on environment
- `isDbAvailable()` returns boolean connection state
- Provider chain failures: `gsd-db: No SQLite provider available (tried node:sqlite, better-sqlite3)` to stderr
- Query functions degrade gracefully: return `[]` or `null`, never throw

## Deviations

- **gsd-db.ts require() fix**: T01 used bare `require()` matching the native-git-bridge.ts pattern. This doesn't work under node's native ESM test runner. Changed to `createRequire(import.meta.url)` matching the original memory-db source. This is functionally equivalent in pi's jiti runtime and correct in ESM.
- **Test command needs --experimental-sqlite**: Plan's verification command omitted this flag. Node 22 requires `--experimental-sqlite` to expose the `node:sqlite` module.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/context-store.ts` — new file, 195 lines, query layer with filtering and formatters
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — new file, 353 lines, DB layer tests
- `src/resources/extensions/gsd/tests/context-store.test.ts` — new file, 462 lines, query/formatter tests
- `src/resources/extensions/gsd/tests/worktree-db.test.ts` — new file, 442 lines, worktree copy/reconcile tests
- `src/resources/extensions/gsd/gsd-db.ts` — modified, switched from bare require() to createRequire for ESM compatibility
