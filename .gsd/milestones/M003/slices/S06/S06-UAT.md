# S06: Doctor + cleanup + code simplification — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: Doctor checks are CLI commands with deterministic output — detection and fix results are fully verifiable via command output and git state inspection.

## Preconditions

- Must be in the gsd-2 project root
- Git CLI available
- Project builds cleanly (`npx tsc --noEmit`)

## Smoke Test

Run `/gsd doctor` in a clean repo. Confirm no git-related issues are reported (no orphaned worktrees, no stale branches, no corrupt merge state, no tracked runtime files). Output should show only non-git checks.

## Test Cases

### 1. Orphaned worktree detection and fix

1. Create a temp git repo with a completed milestone in the roadmap
2. Create a worktree under `.gsd/worktrees/M099/` on branch `milestone/M099`
3. Run `/gsd doctor` (detection only)
4. **Expected:** Issue `orphaned_auto_worktree` reported with severity and worktree path
5. Run `/gsd doctor --fix`
6. **Expected:** Worktree removed, fix recorded in fixesApplied
7. Run `/gsd doctor` again
8. **Expected:** No orphaned worktree issues

### 2. Stale milestone branch detection and fix

1. Create a temp git repo with a completed milestone in the roadmap
2. Create branch `milestone/M099` (no worktree)
3. Run `/gsd doctor`
4. **Expected:** Issue `stale_milestone_branch` reported
5. Run `/gsd doctor --fix`
6. **Expected:** Branch deleted, fix recorded
7. Verify branch gone: `git branch --list milestone/M099` returns empty

### 3. Corrupt merge state detection and fix

1. Create a temp git repo
2. Create `.git/MERGE_HEAD` file with dummy content
3. Run `/gsd doctor`
4. **Expected:** Issue `corrupt_merge_state` reported
5. Run `/gsd doctor --fix`
6. **Expected:** MERGE_HEAD removed via abortAndReset, fix recorded

### 4. Tracked runtime files detection and fix

1. Create a temp git repo
2. `git add` a file matching RUNTIME_EXCLUSION_PATHS (e.g., `.gsd/activity/foo.md`)
3. Run `/gsd doctor`
4. **Expected:** Issue `tracked_runtime_files` reported
5. Run `/gsd doctor --fix`
6. **Expected:** File untracked via `git rm --cached`, fix recorded

### 5. Non-git directory safety

1. Run `/gsd doctor` from a non-git directory (e.g., `/tmp/nonrepo`)
2. **Expected:** No crash, no git-related issues reported, other checks still run

### 6. Active worktree not flagged

1. Create a temp git repo with an in-progress milestone
2. Create a worktree under `.gsd/worktrees/M099/` on branch `milestone/M099`
3. Run `/gsd doctor`
4. **Expected:** Worktree NOT flagged as orphaned (milestone is in-progress)

## Edge Cases

### cwd matches orphaned worktree

1. Create a worktree for a completed milestone
2. `cd` into the worktree directory
3. Run doctor
4. **Expected:** Worktree detected as orphaned but NOT removed (safety guard against removing cwd)

### Multiple issue types simultaneously

1. Create a repo with an orphaned worktree AND a MERGE_HEAD file AND tracked runtime files
2. Run `/gsd doctor`
3. **Expected:** All 3 issues detected independently
4. Run `/gsd doctor --fix`
5. **Expected:** All 3 fixed independently

## Failure Signals

- Any test in `doctor-git.test.ts` failing
- `npx tsc --noEmit` producing errors
- Existing `doctor.test.ts` or `doctor-fixlevel.test.ts` tests regressing
- `/gsd doctor` crashing in a non-git directory

## Requirements Proved By This UAT

- R040 — Doctor detects and fixes orphaned auto-worktrees, stale milestone branches, corrupt merge state, and tracked runtime files

## Not Proven By This UAT

- R041 — Full test suite coverage (deferred to S07)
- R036 — Dead code removal (annotated only, not removed, per backwards compatibility)
- Live auto-mode interaction with doctor (operational verification)

## Notes for Tester

- All test cases are already covered by automated tests in `doctor-git.test.ts`. Run `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` to verify all 17 assertions pass.
- The `.gsd/` conflict resolution code was annotated, not removed — this is intentional per R038 (backwards compatibility with branch-per-slice model).
