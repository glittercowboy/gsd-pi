---
estimated_steps: 4
estimated_files: 2
---

# T01: Port gsd-db.ts and add types

**Slice:** S01 — DB Foundation + Schema
**Milestone:** M004

## Description

Port the SQLite database abstraction layer from the memory-db worktree into the current codebase. This is the foundation for all DB-backed context injection — every subsequent slice depends on this file. The port is mechanical with one required adaptation: replacing `createRequire(import.meta.url)` with bare `require()` calls to work under pi's jiti CJS shim.

Also adds the `Decision` and `Requirement` TypeScript interfaces to `types.ts` — these are imported by gsd-db.ts and context-store.ts.

## Steps

1. Append `Decision` and `Requirement` interfaces to `src/resources/extensions/gsd/types.ts`. Copy from memory-db `types.ts` (the last ~40 lines starting from the "Database Types" comment). Place after the existing interfaces at the end of the file.

2. Port `gsd-db.ts` from `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/gsd-db.ts` to `src/resources/extensions/gsd/gsd-db.ts`. This is 750 lines covering:
   - `suppressSqliteWarning()` — must be called before `require('node:sqlite')`
   - Tiered provider chain: `node:sqlite` → `better-sqlite3` → null
   - `DbAdapter` interface normalizing API differences
   - `normalizeRow()` for null-prototype row objects
   - Schema init with decisions, requirements, artifacts tables + filtered views
   - CRUD wrappers: `insertDecision`, `insertRequirement`, `insertArtifact`, `upsertDecision`, `upsertRequirement`
   - `transaction()` wrapper
   - `copyWorktreeDb()` and `reconcileWorktreeDb()`
   - `openDatabase()`, `closeDatabase()`, `isDbAvailable()`, `getDbProvider()`

3. Adapt the require pattern: Replace lines 8 and 14:
   ```
   // REMOVE: import { createRequire } from 'node:module';
   // REMOVE: const _require = createRequire(import.meta.url);
   ```
   Then change all `_require(...)` calls to bare `require(...)`:
   - Line ~71: `const mod = require('node:sqlite');`
   - Line ~83: `const mod = require('better-sqlite3');`
   This matches the established pattern in `native-git-bridge.ts` (line 36).

4. Run `npx tsc --noEmit` to verify the file compiles cleanly with all type imports resolved.

## Must-Haves

- [ ] `Decision` and `Requirement` interfaces appended to types.ts
- [ ] gsd-db.ts ported with bare `require()` replacing `createRequire(import.meta.url)`
- [ ] All exports present: `openDatabase`, `closeDatabase`, `isDbAvailable`, `getDbProvider`, `initSchema`, `insertDecision`, `insertRequirement`, `insertArtifact`, `upsertDecision`, `upsertRequirement`, `transaction`, `copyWorktreeDb`, `reconcileWorktreeDb`
- [ ] `tsc --noEmit` passes

## Verification

- `npx tsc --noEmit` — zero errors
- `grep -c 'createRequire\|import\.meta\.url' src/resources/extensions/gsd/gsd-db.ts` returns 0
- `grep -c 'export function' src/resources/extensions/gsd/gsd-db.ts` shows all expected exports

## Inputs

- Source: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/gsd-db.ts` (750 lines)
- Source: `/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/types.ts` (last ~40 lines for Decision/Requirement interfaces)
- Reference: `src/resources/extensions/gsd/native-git-bridge.ts` (line 36 for bare `require()` pattern)

## Observability Impact

- `getDbProvider()` returns `'node:sqlite'`, `'better-sqlite3'`, or `null` — reveals which provider loaded
- `isDbAvailable()` returns boolean — whether a DB connection is active
- Provider chain logs to stderr on failure: `gsd-db: No SQLite provider available (tried node:sqlite, better-sqlite3)`
- Worktree operations log to stderr: copy failures, reconciliation counts, conflict details
- Schema version tracked in `schema_version` table — queryable via `_getAdapter()`

## Expected Output

- `src/resources/extensions/gsd/types.ts` — modified with `Decision` and `Requirement` interfaces appended
- `src/resources/extensions/gsd/gsd-db.ts` — new file, 750 lines, tiered SQLite provider chain with bare `require()` calls
