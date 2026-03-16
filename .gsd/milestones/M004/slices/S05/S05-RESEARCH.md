# S05: Worktree DB Isolation — Research

**Date:** 2026-03-15
**Scope:** M004/S05

## Summary

S05 is wiring work. `copyWorktreeDb` and `reconcileWorktreeDb` are already implemented and tested in S01 (36 assertions in `worktree-db.test.ts`). The functions exist, the tests pass, and the signatures are stable. What S05 adds is two integration hooks:

1. **Copy hook**: When a new auto-worktree is created, copy `gsd.db` into the worktree's `.gsd/` directory so the worktree starts with a seeded DB.
2. **Reconcile hook**: When a worktree merges back, run `reconcileWorktreeDb` to fold any new rows from the worktree DB into the main DB before teardown.

This is light integration work. The only genuine question is *where* each hook lives given the current worktree architecture, and the answer is unambiguous after reading the code.

## Recommendation

Wire the copy hook inside `copyPlanningArtifacts()` in `auto-worktree.ts` — this function already copies all `.gsd/` planning artifacts to a fresh worktree, and `gsd.db` belongs in that same batch. Wire the reconcile hook in `mergeMilestoneToMain()` in `auto-worktree.ts`, just before the `removeWorktree` call (step 10 in the existing sequence). Both hooks: static imports at top of file, `isDbAvailable()` guard, non-fatal try/catch, no async.

For the manual `/worktree merge` path in `worktree-command.ts`, wire reconciliation before the `mergeWorktreeToMain()` squash call — the worktree DB should be reconciled while still in the worktree context, before the squash-merge overwrites the working tree.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/auto-worktree.ts` — **primary target**. Two wiring points:
  1. `copyPlanningArtifacts()` (line ~124): add `gsd.db` copy after the planning files loop. `gsd-db.ts`'s `copyWorktreeDb` handles missing-source and non-fatal errors internally — just call it.
  2. `mergeMilestoneToMain()` (line ~270): add reconcile call between step 1 (auto-commit) and step 3 (chdir to original base). The worktree DB is at `join(worktreeCwd, ".gsd", "gsd.db")`. The main DB path is `join(originalBasePath_, ".gsd", "gsd.db")`. Must happen while still in worktree cwd, before `process.chdir(originalBasePath_)`.

- `src/resources/extensions/gsd/worktree-command.ts` — **secondary target**. The manual `/worktree` merge path calls `mergeWorktreeToMain()` at line 676. Before that call, add reconcile logic: locate the worktree path (it's tracked in `originalCwd` before the `process.chdir(basePath)` at line 663), call `reconcileWorktreeDb(mainDbPath, worktreeDbPath)`, guard with `existsSync(worktreeDbPath)` and a try/catch.

- `src/resources/extensions/gsd/gsd-db.ts` — **no changes needed**. `copyWorktreeDb(srcDbPath, destDbPath)` and `reconcileWorktreeDb(mainDbPath, worktreeDbPath)` are already exported and tested.

- `src/resources/extensions/gsd/tests/worktree-db.test.ts` — **existing test file** (36 assertions). S05 wiring tests are integration-level and require real git worktrees, so they belong in `auto-worktree.test.ts` or a new `worktree-db-integration.test.ts`, not in the unit-level `worktree-db.test.ts`.

### Exact Wiring Points

**`copyPlanningArtifacts` in `auto-worktree.ts`** — add after the file loop (line ~145):

```typescript
import { copyWorktreeDb, isDbAvailable } from "./gsd-db.js";
// ...
// Copy gsd.db if DB is available
if (isDbAvailable()) {
  const srcDb = join(srcGsd, "gsd.db");
  const destDb = join(dstGsd, "gsd.db");
  try {
    copyWorktreeDb(srcDb, destDb); // non-fatal internally
  } catch { /* non-fatal */ }
}
```

**`mergeMilestoneToMain` in `auto-worktree.ts`** — add between step 1 (auto-commit) and step 3 (chdir), while still in `worktreeCwd`:

```typescript
import { reconcileWorktreeDb, isDbAvailable } from "./gsd-db.js";
// ...
// Reconcile worktree DB back into main DB before leaving worktree
if (isDbAvailable()) {
  try {
    const worktreeDbPath = join(worktreeCwd, ".gsd", "gsd.db");
    const mainDbPath = join(originalBasePath_, ".gsd", "gsd.db");
    reconcileWorktreeDb(mainDbPath, worktreeDbPath);
  } catch { /* non-fatal */ }
}
```

**`worktree-command.ts`** — before `mergeWorktreeToMain(basePath, name, commitMessage)`:
```typescript
// Reconcile worktree DB before merge
const wtPath = worktreePath(basePath, name); // already imported from worktree-manager
const wtDbPath = join(wtPath, ".gsd", "gsd.db");
const mainDbPath = join(basePath, ".gsd", "gsd.db");
if (existsSync(wtDbPath) && existsSync(mainDbPath)) {
  try {
    const { reconcileWorktreeDb } = await import("./gsd-db.js");
    reconcileWorktreeDb(mainDbPath, wtDbPath);
  } catch { /* non-fatal */ }
}
```

Note: `worktree-command.ts` is async (it's a command handler). Dynamic import is fine here and avoids adding a static import chain to the command layer. `worktreePath` is already imported from `worktree-manager`.

### Build Order

1. **Wire `copyPlanningArtifacts`** — trivial, 5 lines. Static import of `copyWorktreeDb` and `isDbAvailable` at the top of `auto-worktree.ts`.
2. **Wire `mergeMilestoneToMain`** — same static imports, add the reconcile block. `reconcileWorktreeDb` is already exported.
3. **Wire `worktree-command.ts`** — dynamic import (command layer pattern), add reconcile block before the squash-merge call.
4. **Write tests** — integration tests that call `createAutoWorktree` and verify `gsd.db` appears in the worktree; simulate `mergeMilestoneToMain` and verify reconciliation rows. These require a real git repo fixture — follow the pattern in `auto-worktree.test.ts`.

### Verification Approach

```bash
# Existing S01 worktree-db tests — must stay green
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db.test.ts

# New S05 integration test (to be created)
node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/worktree-db-integration.test.ts

# TypeScript clean
npx tsc --noEmit

# Existing full suite — zero regressions
npm test
```

Observable behaviors to verify:
- After `createAutoWorktree(basePath, mid)`: `existsSync(join(worktreePath, ".gsd", "gsd.db"))` is true when main has a `gsd.db`
- After `mergeMilestoneToMain(...)`: rows inserted in worktree DB appear in main DB
- When `gsd.db` does not exist in source: `copyPlanningArtifacts` skips silently, no error
- When DB is unavailable: copy and reconcile hooks skip entirely (guarded by `isDbAvailable()`)

## Constraints

- `copyPlanningArtifacts` is synchronous. `copyWorktreeDb` uses `copyFileSync` — sync, compatible.
- `reconcileWorktreeDb` uses ATTACH DATABASE with synchronous SQLite ops — sync, compatible with `mergeMilestoneToMain`'s sync execution model.
- Static imports in `auto-worktree.ts` are fine — it doesn't import from `auto.ts` so no circular dependency.
- `worktree-command.ts` is async; dynamic import is the appropriate pattern for the command layer (consistent with how `auto.ts` imports DB modules).
- The reconcile call in `mergeMilestoneToMain` must happen *before* `process.chdir(originalBasePath_)` — `worktreeCwd` must still be valid when constructing the worktree DB path.

## Common Pitfalls

- **Reconcile timing in `mergeMilestoneToMain`**: the call must happen while still in worktree context (before step 3 chdir). After `process.chdir(originalBasePath_)`, `worktreeCwd` is stale as a relative reference but remains valid as an absolute path — use it directly.
- **`isDbAvailable()` semantics**: this checks whether the *current process's* DB connection is open, not whether a `gsd.db` file exists. In the copy hook, the source DB file may exist even if the connection is closed. For `copyPlanningArtifacts`, use `existsSync(srcDb)` as the primary guard (since DB may not be open during worktree creation). For reconciliation, `isDbAvailable()` is the right guard since we're merging into the already-open main DB.
- **WAL files**: `copyWorktreeDb` already skips `.wal` and `.shm` files — no need to handle them separately. The function copies only the main `.db` file.
- **Test fixture complexity**: integration tests require real git repos. Follow the `auto-worktree.test.ts` pattern (tmpdir + `git init` + files + commits). Don't try to mock `createWorktree` — test against a real git repo.
