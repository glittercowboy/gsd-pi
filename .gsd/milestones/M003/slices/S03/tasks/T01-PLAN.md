---
estimated_steps: 6
estimated_files: 2
---

# T01: Implement mergeMilestoneToMain and wire into auto.ts

**Slice:** S03 — Milestone-to-main squash merge + worktree teardown
**Milestone:** M003

## Description

Add `mergeMilestoneToMain` to auto-worktree.ts that squash-merges the milestone branch to main with a rich commit message listing all completed slices. Wire it into auto.ts's `phase === "complete"` path before `stopAuto`. Make `stopAuto`'s worktree teardown idempotent.

## Steps

1. In auto-worktree.ts, add imports: `parseRoadmap` from files.ts, `loadEffectiveGSDPreferences` from preferences.ts, `resolveMilestoneFile` from files.ts (for reading roadmap)
2. Add helper `autoCommitDirtyState(cwd)` — checks `git status --porcelain`, if dirty runs `git add -A && git commit -m "chore: auto-commit before milestone merge"`
3. Add `mergeMilestoneToMain(originalBasePath, milestoneId, roadmapContent: string)`:
   - Parse roadmap to get completed slices list
   - Auto-commit any dirty state in the worktree (cwd) before leaving
   - chdir to originalBasePath
   - `git checkout main` (use `getMainBranch` pattern — check pref, fallback to "main")
   - Build rich commit message: `feat(MID): milestone title` subject + body listing completed slices as `- SXX: title` + branch metadata
   - `git merge --squash milestone/<MID>`
   - `git commit -m <rich message>` — catch "nothing to commit" and handle gracefully
   - Auto-push if `auto_push` pref enabled (read from `loadEffectiveGSDPreferences`)
   - Delete milestone branch: `git branch -D milestone/<MID>`
   - Remove worktree directory via `removeWorktree(originalBasePath, milestoneId, { branch: null })` (branch already deleted)
   - Clear `originalBase = null`
4. In auto.ts `phase === "complete"` block (~L1717), before `stopAuto(ctx, pi)`, add:
   ```
   if (isInAutoWorktree(basePath) && originalBasePath) {
     try {
       const roadmapPath = resolveMilestoneFile(originalBasePath, currentMilestoneId, "ROADMAP");
       const roadmapContent = readFileSync(roadmapPath, "utf-8");
       mergeMilestoneToMain(originalBasePath, currentMilestoneId, roadmapContent);
       basePath = originalBasePath;
       gitService = new GitServiceImpl(basePath, loadEffectiveGSDPreferences()?.preferences?.git ?? {});
       ctx.ui.notify("Milestone merged to main.", "info");
     } catch (err) { ... notify error ... }
   }
   ```
5. Verify `stopAuto`'s existing `isInAutoWorktree(basePath)` guard (~L360) already makes it idempotent — after mergeMilestoneToMain clears originalBase, `isInAutoWorktree` returns false, so teardown is skipped
6. `npx tsc --noEmit` to verify clean build

## Must-Haves

- [x] `mergeMilestoneToMain` exported from auto-worktree.ts
- [x] Rich commit message with conventional commit format and slice listing
- [x] Auto-commit dirty worktree state before merge
- [x] Auto-push when pref enabled
- [x] Graceful handling of nothing-to-commit
- [x] Wired into auto.ts complete path
- [x] stopAuto idempotent (no double teardown)

## Verification

- `npx tsc --noEmit` — zero errors
- Code review: mergeMilestoneToMain follows squash-merge pattern from git-service.ts
- Code review: auto.ts complete path calls merge before stopAuto

## Observability Impact

- **New signals:** UI notifications on milestone merge success/failure with push status. Rich commit message logged in git history.
- **Inspection:** `git log --oneline main` shows `feat(MID): title` commit after merge. `git worktree list` confirms worktree removed. `git branch` confirms milestone branch deleted.
- **Failure state:** MergeConflictError with conflicted file list propagated to UI notification. Nothing-to-commit handled silently (no error).

## Inputs

- `src/resources/extensions/gsd/auto-worktree.ts` — existing module with worktree lifecycle + mergeSliceToMilestone
- `src/resources/extensions/gsd/auto.ts` — existing auto-mode state machine with `phase === "complete"` block
- S01/S02 summaries — upstream contracts (isInAutoWorktree, teardownAutoWorktree, autoWorktreeBranch)

## Expected Output

- `src/resources/extensions/gsd/auto-worktree.ts` — new `mergeMilestoneToMain` export
- `src/resources/extensions/gsd/auto.ts` — milestone merge call in complete path
