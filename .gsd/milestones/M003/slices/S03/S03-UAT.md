# S03: Milestone-to-main squash merge + worktree teardown — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All behavior verified via integration tests against real git repos. No UI or runtime beyond git operations.

## Preconditions

- Repository cloned with `npm install` completed
- Node.js available with `npx tsx`
- Git configured (user.name, user.email set)

## Smoke Test

Run `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — all 23 assertions pass.

## Test Cases

### 1. Basic squash merge produces one commit on main

1. Create a temp git repo with an initial commit on main
2. Create `milestone/M099` branch, add two --no-ff slice merges with multiple commits each
3. Create a worktree pointing to the milestone branch
4. Call `mergeMilestoneToMain` with a roadmap listing completed slices
5. **Expected:** `git log --oneline main` shows exactly one new commit (2 total including initial). Commit message starts with `feat(M099):`. Milestone branch is deleted. Worktree directory is gone.

### 2. Rich commit message format

1. Same setup as test 1 with slices S01 and S02 in the roadmap
2. Call `mergeMilestoneToMain`
3. **Expected:** Commit message body contains "## Completed Slices" section, lists "- S01:" and "- S02:" with titles. Subject line uses conventional commit format.

### 3. Nothing-to-commit handling

1. Create a milestone branch that is identical to main (no additional commits)
2. Call `mergeMilestoneToMain`
3. **Expected:** Function completes without error. No new commit on main. Milestone branch deleted. Worktree removed.

### 4. Auto-push to remote

1. Create a bare remote repo, configure it as origin
2. Create milestone branch with slice merges
3. Call `mergeMilestoneToMain`, then push
4. **Expected:** Remote main has the squash commit. `git log` on the bare remote shows the milestone commit.

## Edge Cases

### stopAuto idempotency after merge

1. Call `mergeMilestoneToMain` (clears originalBase state)
2. Check `isInAutoWorktree()` returns false
3. **Expected:** `stopAuto` would skip worktree teardown since `isInAutoWorktree` is false — no double-teardown error.

### Dirty worktree before merge

1. Create milestone branch, add uncommitted changes
2. Call `mergeMilestoneToMain`
3. **Expected:** Dirty changes auto-committed before squash merge proceeds. Squash commit includes those changes.

## Failure Signals

- Test suite reports FAIL lines with assertion details
- `git log --oneline main` shows more than one new commit (squash didn't work)
- Worktree directory still exists after merge
- Milestone branch still exists after merge
- Error thrown on nothing-to-commit case

## Requirements Proved By This UAT

- R030 — Squash-merge to main with teardown, one commit per milestone
- R032 — Rich commit message with slice listing

## Not Proven By This UAT

- R030 auto-push driven by `auto_push` preference (tested via manual push due to module-level const limitation)
- R035 self-healing on merge failure (deferred to S05)
- R034 `git.merge_to_main` preference gating (deferred to S04)

## Notes for Tester

The integration tests are the primary verification. Run them and confirm 23/23 pass. The tests create and clean up temp directories automatically. If a test fails, check for stale `/tmp/gsd-test-*` directories.
