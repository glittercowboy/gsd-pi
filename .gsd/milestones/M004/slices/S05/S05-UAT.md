# S05: Worktree DB Isolation — UAT

**Milestone:** M004
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S05 is integration-level with real git repo fixtures. The integration test suite (`worktree-db-integration.test.ts`) is the primary proof artifact — it exercises the actual hooks with real git repos, real DB files, and real row propagation. Human observation of a live auto-mode run is not required because the observable behaviors are precisely captured by the test cases.

## Preconditions

- Working directory: `.gsd/worktrees/M004`
- Node 22+ with `--experimental-sqlite` available
- Git installed and configured (used by `createAutoWorktree` fixture)
- `gsd-db.ts`, `auto-worktree.ts`, `worktree-command.ts` all present and TypeScript-clean

## Smoke Test

Run the integration test suite and confirm all 10 assertions pass:

```bash
node --experimental-sqlite \
  --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db-integration.test.ts
```

**Expected:** `Results: 10 passed, 0 failed`

## Test Cases

### 1. DB copy on worktree creation

1. Create a temp git repo with `.gsd/` and a seeded `gsd.db`
2. Call `createAutoWorktree` (the auto-mode worktree creation entry point)
3. Check `existsSync(join(worktreePath, ".gsd", "gsd.db"))`
4. **Expected:** returns `true` — DB file was copied from source into the new worktree's `.gsd/` directory

### 2. Copy skip when source has no DB

1. Create a temp git repo with `.gsd/` but **no** `gsd.db`
2. Call `createAutoWorktree`
3. Confirm no throw is raised
4. Check `existsSync(join(worktreePath, ".gsd", "gsd.db"))`
5. **Expected:** no throw, returns `false` — copy silently skipped because existsSync guard was false

### 3. Reconcile merges worktree rows into main DB

1. Create two temp SQLite DBs: one as "worktree DB", one as "main DB"
2. Open worktree DB, call `upsertDecision` to insert a decision row (e.g. `D001`)
3. Call `reconcileWorktreeDb(mainDbPath, worktreeDbPath)`
4. Open main DB, call `getActiveDecisions()` or equivalent query
5. **Expected:** the decision row inserted in the worktree DB is now present in the main DB. Reconcile result: `{ decisions: 1, requirements: 0, artifacts: 0, conflicts: [] }`

### 4. Reconcile is non-fatal on nonexistent paths

1. Call `reconcileWorktreeDb("/nonexistent/main.db", "/nonexistent/worktree.db")`
2. **Expected:** no throw — function returns without error. (Internal implementation catches and returns zero-shape.)

### 5. Reconcile returns structured zero-shape when worktree DB is absent

1. Create a real main DB at a valid path
2. Call `reconcileWorktreeDb(mainDbPath, "/nonexistent/worktree.db")`
3. Inspect the return value
4. **Expected:** `{ decisions: 0, requirements: 0, artifacts: 0, conflicts: [] }` — all fields present with zero values, not `undefined`, not a throw

### 6. TypeScript compiles clean after wiring

1. Run `npx tsc --noEmit` from the worktree root
2. **Expected:** no output (zero errors, zero warnings)

### 7. S01 worktree-db unit tests stay green

1. Run:
   ```bash
   node --experimental-sqlite \
     --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test \
     src/resources/extensions/gsd/tests/worktree-db.test.ts
   ```
2. **Expected:** `Results: 36 passed, 0 failed`

## Edge Cases

### Copy when gsd.db exists at source but worktree .gsd/ dir doesn't exist yet

1. Call `copyPlanningArtifacts` with a source that has `gsd.db` but a dest where `.gsd/` hasn't been created
2. **Expected:** `copyPlanningArtifacts` creates the `.gsd/` dir as part of its normal planning file copy loop before reaching the DB copy block, so the copy succeeds. No special handling needed.

### Reconcile when both main and worktree modified the same decision

1. Open both main DB and worktree DB
2. Insert the same decision ID in both with different content
3. Call `reconcileWorktreeDb`
4. **Expected:** reconcile result includes `conflicts: [{ table: "decisions", id: "D001", field: "content" }]` — conflict detected and reported, no throw, row in main DB reflects worktree's version (INSERT OR REPLACE semantics)

### handleMerge reconcile when only one DB exists

1. Set up a manual worktree scenario where the worktree has no `gsd.db` (fresh project, migration never ran)
2. Run `handleMerge` (manual `/worktree merge` path)
3. **Expected:** file-presence guard (`existsSync(wtDbPath) && existsSync(mainDbPath)`) evaluates to false, reconcile block is skipped entirely, merge completes normally

## Failure Signals

- Any `reconcileWorktreeDb` throw in test case 4 or 5 — indicates non-fatal contract broken
- `decisions: undefined` or missing fields in test case 5 return value — structured zero-shape contract broken
- `existsSync(join(worktreePath, ".gsd", "gsd.db"))` returns false in test case 1 — copy hook not firing or copy failed
- `npx tsc --noEmit` produces output — new type error introduced
- `worktree-db.test.ts` regression — S01 unit contracts broken by S05 changes

## Requirements Proved By This UAT

- R053 — Worktree DB copy on creation: test cases 1 and 2 prove the copy hook fires on `createAutoWorktree` and skips cleanly when no source DB exists
- R054 — Worktree DB merge reconciliation: test cases 3, 4, and 5 prove the reconcile hook merges rows from worktree into main, and that absent/nonexistent DBs produce non-fatal structured results

## Not Proven By This UAT

- Full auto-mode lifecycle (create → execute → merge) with DB copy and reconcile observed end-to-end — deferred to S07
- Conflict detection in realistic concurrent-write scenario (both main and worktree wrote different content to same row) — test case under "Edge Cases" above but not in the automated integration suite
- Token savings impact of worktree DB isolation — S07
- `handleMerge` manual merge path tested via unit/integration tests in this slice; live `/worktree merge` command execution not tested manually

## Notes for Tester

The pre-existing `pack-install.test.ts` failure (`dist/` not built in worktree) will appear in `npm test` output — this is expected and unrelated to S05. All other tests should pass. The `gsd-db:` stderr prefix is the observable diagnostic signal for reconcile operations — pipe `2>&1 | grep "gsd-db:"` to see reconcile activity in any test run.
