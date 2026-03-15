# S03: Milestone-to-main squash merge + worktree teardown

**Goal:** When a milestone completes, squash-merge the milestone branch to main with a rich commit message, tear down the worktree, chdir back to project root. `git log main` shows one clean commit per milestone.
**Demo:** In a temp repo with a milestone branch containing multiple --no-ff slice merges, `complete` triggers squash-merge → `git log --oneline main` shows exactly one new commit with all slice titles listed. Worktree directory is gone. Auto-push works if enabled.

## Must-Haves

- `mergeMilestoneToMain(originalBasePath, milestoneId, roadmapContent)` squash-merges milestone branch to main
- Rich commit message lists all completed slices with titles
- Auto-push to remote if `auto_push` pref is enabled
- Worktree teardown happens after successful merge (branch deleted, directory removed)
- `stopAuto` is idempotent — skips teardown if worktree already torn down
- Dirty worktree auto-committed before squash-merge
- Handles "nothing to commit" gracefully (milestone branch identical to main)

## Proof Level

- This slice proves: integration
- Real runtime required: yes (real git repos)
- Human/UAT required: no

## Verification

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — all tests pass
- Tests cover: single-commit squash on main, rich message content, auto-push, nothing-to-commit, dirty worktree auto-commit, stopAuto idempotency
- Diagnostic check: MergeConflictError thrown with conflicted file list when merge conflicts exist; error message propagated to UI notification

## Observability / Diagnostics

- Runtime signals: UI notifications on merge success/failure, commit message logged
- Inspection surfaces: `git log --oneline main` shows milestone commit; `git worktree list` confirms worktree removed
- Failure visibility: MergeConflictError with conflicted file list; error notification in UI
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `mergeSliceToMilestone` (S02), `isInAutoWorktree`/`teardownAutoWorktree`/`getAutoWorktreeOriginalBase` (S01), `removeWorktree` (worktree-manager.ts)
- New wiring introduced in this slice: `mergeMilestoneToMain` call in auto.ts `phase === "complete"` block before `stopAuto`
- What remains before the milestone is truly usable end-to-end: S04 (preferences), S05 (self-healing), S06 (doctor/cleanup), S07 (full test suite)

## Tasks

- [x] **T01: Implement mergeMilestoneToMain and wire into auto.ts** `est:40m`
  - Why: Core function that squash-merges milestone branch to main with rich commit message, plus wiring into the completion path and making stopAuto idempotent
  - Files: `src/resources/extensions/gsd/auto-worktree.ts`, `src/resources/extensions/gsd/auto.ts`
  - Do: (1) Add `mergeMilestoneToMain(originalBasePath, milestoneId, roadmapContent)` to auto-worktree.ts — chdir to originalBasePath, checkout main, auto-commit dirty worktree state on milestone branch first, build rich commit message from parsed roadmap slices, `git merge --squash milestone/<MID>`, commit, auto-push if pref enabled, delete milestone branch, remove worktree via `removeWorktree(deleteBranch: false)` since branch already deleted, clear originalBase. (2) In auto.ts `phase === "complete"` block (~L1717), before `stopAuto`, add milestone merge call guarded by `isInAutoWorktree`. (3) Make `stopAuto`'s worktree teardown conditional — if `isInAutoWorktree` returns false (already torn down), skip teardown.
  - Verify: `npx tsc --noEmit` — clean build
  - Done when: `mergeMilestoneToMain` exported from auto-worktree.ts, wired in auto.ts, stopAuto idempotent, compiles clean

- [x] **T02: Integration tests for milestone squash-merge** `est:30m`
  - Why: Prove squash-merge produces correct git state in real repos — one commit on main, rich message, worktree removed, edge cases handled
  - Files: `src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts`
  - Do: Build test suite with real temp git repos. Tests: (1) basic squash — create milestone branch with 2 --no-ff slice merges, call mergeMilestoneToMain, verify `git log --oneline main` has exactly one new commit, message contains slice titles, milestone branch deleted, worktree dir gone. (2) rich commit message — verify conventional commit format, slice listing in body. (3) nothing-to-commit — milestone branch identical to main, verify graceful handling. (4) dirty worktree — uncommitted changes exist before merge, verify auto-committed. (5) auto-push — set up bare remote, verify push happens when pref enabled.
  - Verify: `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — all pass
  - Done when: 5+ tests passing with 15+ assertions covering happy path, edge cases, and auto-push

## Files Likely Touched

- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts`
