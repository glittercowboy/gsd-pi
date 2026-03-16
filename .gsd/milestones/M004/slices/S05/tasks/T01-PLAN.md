---
estimated_steps: 5
estimated_files: 1
---

# T01: Wire DB copy/reconcile into auto-worktree.ts

**Slice:** S05 — Worktree DB Isolation
**Milestone:** M004

## Description

Add static imports of `copyWorktreeDb`, `reconcileWorktreeDb`, and `isDbAvailable` from `gsd-db.ts` into `auto-worktree.ts`, then wire two hooks:

1. **Copy hook** in `copyPlanningArtifacts`: copy `gsd.db` from the source project's `.gsd/` into the new worktree's `.gsd/` when the source file exists. This ensures new worktrees start with the current project DB.

2. **Reconcile hook** in `mergeMilestoneToMain`: before `process.chdir(originalBasePath_)` (step 3), reconcile the worktree DB back into the main DB. This must happen while `worktreeCwd` is still valid as the absolute worktree path.

Both hooks are non-fatal — wrapped in try/catch with no re-throw.

## Steps

1. Add to the import block at top of `auto-worktree.ts`:
   ```typescript
   import { copyWorktreeDb, reconcileWorktreeDb, isDbAvailable } from "./gsd-db.js";
   ```

2. In `copyPlanningArtifacts` (after the `for (const file of [...])` loop that copies top-level planning files, around line 145), add:
   ```typescript
   // Copy gsd.db if present in source
   const srcDb = join(srcGsd, "gsd.db");
   const destDb = join(dstGsd, "gsd.db");
   if (existsSync(srcDb)) {
     try {
       copyWorktreeDb(srcDb, destDb);
     } catch { /* non-fatal */ }
   }
   ```
   Guard is `existsSync(srcDb)` — **not** `isDbAvailable()` — because the DB connection may not be open during worktree creation, but the file may still exist.

3. In `mergeMilestoneToMain`, add between step 1 (auto-commit, line ~279) and step 3 (process.chdir, line ~287):
   ```typescript
   // Reconcile worktree DB into main DB before leaving worktree context
   if (isDbAvailable()) {
     try {
       const worktreeDbPath = join(worktreeCwd, ".gsd", "gsd.db");
       const mainDbPath = join(originalBasePath_, ".gsd", "gsd.db");
       reconcileWorktreeDb(mainDbPath, worktreeDbPath);
     } catch { /* non-fatal */ }
   }
   ```
   This block must appear before `process.chdir(originalBasePath_)`. `worktreeCwd` is captured at the top of `mergeMilestoneToMain` as `process.cwd()` and remains valid as an absolute path even after chdir.

4. Run `npx tsc --noEmit` — must be clean.

5. Run `npm test` — all existing tests must pass, zero regressions.

## Must-Haves

- [ ] Static import of `copyWorktreeDb`, `reconcileWorktreeDb`, `isDbAvailable` from `./gsd-db.js` added to `auto-worktree.ts`
- [ ] `copyPlanningArtifacts` copies `gsd.db` when `existsSync(srcDb)` — guarded by file presence, not `isDbAvailable()`
- [ ] `mergeMilestoneToMain` reconciles worktree DB into main DB before `process.chdir(originalBasePath_)`
- [ ] Both hooks are wrapped in non-fatal try/catch
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` zero regressions

## Verification

```bash
npx tsc --noEmit
npm test
```

## Inputs

- `src/resources/extensions/gsd/auto-worktree.ts` — target file; `copyPlanningArtifacts` is at ~line 124, `mergeMilestoneToMain` at ~line 270
- `src/resources/extensions/gsd/gsd-db.ts` — exports `copyWorktreeDb(srcDbPath, destDbPath)`, `reconcileWorktreeDb(mainDbPath, worktreeDbPath)`, `isDbAvailable()` — all synchronous, no async needed

## Expected Output

- `src/resources/extensions/gsd/auto-worktree.ts` — modified: new static import line, copy block in `copyPlanningArtifacts`, reconcile block in `mergeMilestoneToMain`
