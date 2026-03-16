# S01: DB Foundation + Schema

**Goal:** SQLite DB opens with tiered provider chain, schema inits with decisions/requirements/artifacts tables plus filtered views, typed CRUD wrappers work, graceful fallback returns empty results when SQLite unavailable.
**Demo:** Unit tests prove provider detection, schema init, CRUD operations, filtered views, WAL mode, transactions, fallback behavior, query layer filtering/formatting, worktree DB copy/reconcile — all passing against real SQLite.

## Must-Haves

- Tiered provider chain: `node:sqlite` → `better-sqlite3` → null (R045)
- Schema creates decisions, requirements, artifacts tables plus filtered views
- Typed CRUD wrappers: insert/upsert/query for decisions, requirements, artifacts
- WAL mode enabled on file-backed databases
- Graceful fallback: all query/format functions return empty when DB unavailable (R046)
- `copyWorktreeDb` and `reconcileWorktreeDb` for worktree isolation (R053, R054)
- Query layer: `queryDecisions()`, `queryRequirements()`, `queryArtifact()`, `queryProject()` with filtering by milestone/scope/slice/status
- Prompt formatters: `formatDecisionsForPrompt()`, `formatRequirementsForPrompt()`
- `Decision` and `Requirement` interfaces exported from types.ts

## Proof Level

- This slice proves: contract
- Real runtime required: yes (SQLite must actually load and execute queries)
- Human/UAT required: no

## Verification

```bash
cd /Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/M004
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/gsd-db.test.ts \
  src/resources/extensions/gsd/tests/context-store.test.ts \
  src/resources/extensions/gsd/tests/worktree-db.test.ts

npx tsc --noEmit

npm run test:unit
```

- `gsd-db.test.ts`: ~30 assertions — provider detection, schema init, CRUD, views, WAL, transactions, fallback
- `context-store.test.ts`: ~35 assertions — query filtering by milestone/scope/slice/status, formatters, timing, artifacts, fallback
- `worktree-db.test.ts`: ~30 assertions — copy, reconcile, conflicts, DETACH cleanup
- All existing tests pass unchanged
- `tsc --noEmit` clean

## Observability / Diagnostics

- Runtime signals: `getDbProvider()` returns provider name or `'unavailable'`; `isDbAvailable()` boolean
- Inspection surfaces: `gsd.db` file in `.gsd/` directory; schema_version in metadata table
- Failure visibility: provider chain logs which provider loaded; fallback returns empty arrays (no crash)
- Redaction constraints: none (no secrets in DB)

## Integration Closure

- Upstream surfaces consumed: none (first slice)
- New wiring introduced in this slice: none — gsd-db.ts and context-store.ts are standalone modules, not wired into auto-mode yet
- What remains before the milestone is truly usable end-to-end: S02 (importers), S03 (prompt builder rewiring), S04 (measurement), S05 (worktree wiring), S06 (tools + inspect), S07 (integration verification)

## Tasks

- [x] **T01: Port gsd-db.ts and add types** `est:30m`
  - Why: The DB layer is the foundation — everything else depends on it. The `Decision` and `Requirement` interfaces must exist before any DB code can compile.
  - Files: `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/gsd-db.ts`
  - Do: Append `Decision` and `Requirement` interfaces to types.ts (copy from memory-db types.ts lines ~270–308). Port gsd-db.ts from memory-db worktree (750 lines). Adapt: replace `import { createRequire } from 'node:module'` and `const _require = createRequire(import.meta.url)` with bare `require()` calls — match `native-git-bridge.ts` pattern (line 36: `const mod = require("@gsd/native")`). Keep all CRUD wrappers, schema init, provider chain, WAL mode, `copyWorktreeDb`, `reconcileWorktreeDb`, `transaction()`, `normalizeRow()`.
  - Verify: `npx tsc --noEmit` — file compiles with no type errors
  - Done when: `gsd-db.ts` exists with tiered provider chain using bare `require()`, types.ts has both interfaces, TypeScript compiles clean

- [x] **T02: Port context-store.ts and all test files** `est:30m`
  - Why: The query layer depends on gsd-db.ts. Tests prove the entire DB foundation works end-to-end. Without tests, the slice has no proof.
  - Files: `src/resources/extensions/gsd/context-store.ts`, `src/resources/extensions/gsd/tests/gsd-db.test.ts`, `src/resources/extensions/gsd/tests/context-store.test.ts`, `src/resources/extensions/gsd/tests/worktree-db.test.ts`
  - Do: Port context-store.ts from memory-db (195 lines, no changes needed). Port all three test files from memory-db. Ensure test imports reference the correct relative paths. Run all three new test files. Run existing test suite to confirm zero regressions. Run `tsc --noEmit`.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-db.test.ts src/resources/extensions/gsd/tests/context-store.test.ts src/resources/extensions/gsd/tests/worktree-db.test.ts` — all pass. `npm run test:unit` — zero regressions. `npx tsc --noEmit` — clean.
  - Done when: All ~95 new assertions pass, all existing tests pass, TypeScript compiles clean

## Files Likely Touched

- `src/resources/extensions/gsd/types.ts` (modify — append interfaces)
- `src/resources/extensions/gsd/gsd-db.ts` (new)
- `src/resources/extensions/gsd/context-store.ts` (new)
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` (new)
- `src/resources/extensions/gsd/tests/context-store.test.ts` (new)
- `src/resources/extensions/gsd/tests/worktree-db.test.ts` (new)
