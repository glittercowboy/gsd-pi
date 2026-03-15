---
estimated_steps: 4
estimated_files: 1
---

# T02: Integration tests for doctor git health checks

**Slice:** S06 — Doctor + cleanup + code simplification
**Milestone:** M003

## Description

Build integration tests that create real temp git repos with deliberate broken state, run `runGSDDoctor`, and assert correct detection and fixing of all 4 git issue codes.

## Steps

1. Create `doctor-git.test.ts` using `node:test` with temp dir helpers (consistent with `auto-worktree.test.ts` pattern — `mkdtempSync`, `realpathSync`, `execSync` for git init)
2. Write helper to create a minimal GSD project with roadmap containing a milestone (reuse pattern from auto-worktree tests)
3. Implement test cases:
   - Orphaned worktree: create worktree with `milestone/M001` branch, mark M001 complete in roadmap → doctor detects `orphaned_auto_worktree`, fix removes it
   - Stale branch: create `milestone/M001` branch (no worktree), mark M001 complete → doctor detects `stale_milestone_branch`, fix deletes branch
   - Corrupt merge state: write MERGE_HEAD file in `.git/` → doctor detects `corrupt_merge_state`, fix cleans it
   - Tracked runtime files: `git add -f .gsd/activity/test.log` → doctor detects `tracked_runtime_files`, fix untracks
   - Non-git dir: run doctor in a plain temp dir → no crash, no git issues reported
   - Active worktree safety: create worktree, milestone in-progress → NOT flagged as orphaned
4. Each test: run `runGSDDoctor(basePath)` for detection assertions, then `runGSDDoctor(basePath, { fix: true })` for fix assertions, then verify git state after fix

## Must-Haves

- [ ] All 4 issue codes tested for detection
- [ ] All 4 issue codes tested for fix
- [ ] Non-git directory graceful degradation tested
- [ ] Active worktree not flagged (false positive prevention)

## Verification

- `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` — all pass
- `npx tsx src/resources/extensions/gsd/tests/doctor.test.ts` — still passes
- `npx tsx src/resources/extensions/gsd/tests/doctor-fixlevel.test.ts` — still passes

## Inputs

- `src/resources/extensions/gsd/doctor.ts` — T01's new `checkGitHealth` function and issue codes
- `src/resources/extensions/gsd/tests/auto-worktree.test.ts` — temp repo setup patterns
- `src/resources/extensions/gsd/tests/git-self-heal.test.ts` — corrupt state injection patterns

## Expected Output

- `src/resources/extensions/gsd/tests/doctor-git.test.ts` — 6+ test cases with real git repos

## Observability Impact

- **Test output:** Running `npx tsx src/resources/extensions/gsd/tests/doctor-git.test.ts` prints pass/fail for all 6 test cases (17 assertions) covering detection and fix of all 4 git issue codes plus graceful degradation and false positive prevention.
- **Failure diagnostics:** Each failed assertion prints the expected vs actual value with a descriptive label.
- **No runtime signals changed** — this task adds tests only, no production behavior changes.
