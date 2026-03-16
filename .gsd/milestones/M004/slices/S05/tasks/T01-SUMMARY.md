---
id: T01
parent: S05
milestone: M004
provides:
  - DB copy hook in copyPlanningArtifacts (auto-worktree.ts)
  - DB reconcile hook in mergeMilestoneToMain (auto-worktree.ts)
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
key_decisions:
  - Copy guard uses existsSync(srcDb) not isDbAvailable() — DB connection may not be open during worktree creation but file may exist
  - Reconcile placed between autoCommitDirtyState and process.chdir so worktreeCwd remains valid as absolute path
patterns_established:
  - Non-fatal try/catch wrapping for all DB hooks in worktree lifecycle
observability_surfaces:
  - Reconcile emits gsd-db: reconciled N decisions, M requirements, K artifacts (P conflicts) to stderr via existing gsd-db prefix
  - Copy failures are silent (non-fatal); absence of gsd.db in worktree after createAutoWorktree indicates copy skipped or failed
  - isDbAvailable() queryable at runtime to confirm DB open before reconcile path runs
duration: 10m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Wire DB copy/reconcile into auto-worktree.ts

**Added DB copy hook to `copyPlanningArtifacts` and reconcile hook to `mergeMilestoneToMain` in `auto-worktree.ts`; both non-fatal.**

## What Happened

Three edits to `auto-worktree.ts`:

1. Added static import of `copyWorktreeDb`, `reconcileWorktreeDb`, `isDbAvailable` from `./gsd-db.js` alongside the existing node:fs/path imports.

2. In `copyPlanningArtifacts`, after the existing top-level planning files loop, added a `gsd.db` copy block guarded by `existsSync(srcDb)`. The guard is file-presence only — `isDbAvailable()` would be wrong here because the DB connection may not be open at worktree creation time, but the file can still be copied.

3. In `mergeMilestoneToMain`, added the reconcile block between step 1 (`autoCommitDirtyState`) and step 3 (`process.chdir(originalBasePath_)`). The guard is `isDbAvailable()` because reconcile requires an open DB to merge rows. `worktreeCwd` is captured as `process.cwd()` at function entry and remains valid as an absolute path even after the chdir.

## Verification

- `npx tsc --noEmit` — clean, no output
- `npm test` — all existing tests pass; `pack-install.test.ts` fails but is pre-existing (requires `dist/` from a build, confirmed by stash test)
- `worktree-db.test.ts` — 36 passed, 0 failed (S01 unit tests for copyWorktreeDb/reconcileWorktreeDb stay green)

Slice-level verification status:
- `worktree-db.test.ts` ✅ 36/36
- `worktree-db-integration.test.ts` — not yet created (T02 work)
- `npx tsc --noEmit` ✅
- `npm test` ✅ (with pre-existing pack-install failure unchanged)

## Diagnostics

Reconcile path emits to stderr via existing `gsd-db:` prefix:
```
gsd-db: reconciled N decisions, M requirements, K artifacts (P conflicts)
```

Copy path is silent on success; no stderr on skip (existsSync guard skips cleanly).

To inspect post-merge DB state: open the main `gsd.db` via `getDb()` and query `SELECT * FROM decisions` or use `queryAllDecisions()` from context-store.

To verify copy ran: `existsSync(join(worktreePath, ".gsd", "gsd.db"))` after `createAutoWorktree`.

## Deviations

None. Plan was followed exactly.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — added import + copy hook in `copyPlanningArtifacts` + reconcile hook in `mergeMilestoneToMain`
