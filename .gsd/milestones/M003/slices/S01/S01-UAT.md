# S01: Auto-worktree lifecycle in auto-mode — UAT

**Milestone:** M003
**Written:** 2026-03-14

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All behaviors are verified by the 21-assertion integration test in a real temp git repo. The auto.ts wiring is verified by type-checking and code path tracing. No live runtime or human-experience testing needed for this infrastructure slice.

## Preconditions

- Repository cloned and dependencies installed (`npm install`)
- Node.js available with `--experimental-strip-types` support

## Smoke Test

Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-worktree.test.ts` — should report 21 passed, 0 failed.

## Test Cases

### 1. Worktree creation and detection

1. Run the auto-worktree test suite
2. Verify the "lifecycle" test group passes:
   - `createAutoWorktree` creates `.gsd/worktrees/M003/` directory
   - Git branch in worktree is `milestone/M003`
   - `process.cwd()` resolves to the worktree path
   - `isInAutoWorktree()` returns `true`
   - `getAutoWorktreeOriginalBase()` returns the original project root
3. **Expected:** All lifecycle assertions pass. Worktree exists with correct branch.

### 2. Planning file inheritance

1. In the lifecycle test, `.gsd/milestones/M003/` is committed before worktree creation
2. After `createAutoWorktree`, check that `.gsd/milestones/M003/` exists in the worktree
3. **Expected:** Planning files are accessible in the worktree (inherited from the base branch)

### 3. Teardown and cleanup

1. After lifecycle test creates worktree, `teardownAutoWorktree` is called
2. Verify: `process.cwd()` returns to original path
3. Verify: worktree directory is removed
4. Verify: `isInAutoWorktree()` returns `false`
5. Verify: `getAutoWorktreeOriginalBase()` returns `null`
6. **Expected:** Complete cleanup — no orphaned state

### 4. Re-entry after manual exit

1. Create worktree, then manually `process.chdir` back to original without teardown
2. Call `enterAutoWorktree` to re-enter
3. Verify: `process.cwd()` is worktree path, `isInAutoWorktree()` returns `true`
4. **Expected:** Re-entry works without creating a new worktree

### 5. Coexistence with manual worktrees

1. Create auto-worktree with `milestone/M003` branch
2. Create manual worktree with `worktree/feature-x` branch (using worktree-manager directly)
3. Verify both exist simultaneously via `git worktree list`
4. **Expected:** No branch or path conflicts between auto and manual worktrees

### 6. Build verification

1. Run `npx tsc --noEmit`
2. **Expected:** Clean build, no type errors from auto-worktree.ts or auto.ts changes

## Edge Cases

### Split-brain prevention

1. After teardown, `getAutoWorktreeOriginalBase()` returns `null`
2. This prevents code from using a stale original base path after worktree is gone
3. **Expected:** Null return value acts as sentinel for "not in worktree" state

### Non-fatal worktree creation failure

1. In auto.ts, if `createAutoWorktree` throws, auto-mode continues in project root
2. UI notification shows the failure but doesn't block execution
3. **Expected:** Graceful degradation, not a hard stop

## Failure Signals

- Test suite reports any failures in the 21 assertions
- `npx tsc --noEmit` reports type errors
- `isInAutoWorktree()` returns wrong value after create or teardown
- `process.cwd()` doesn't match expected path after chdir operations

## Requirements Proved By This UAT

- R029 — Auto-worktree creation on milestone start (partially — lifecycle functions proven, full auto-mode integration deferred to S02/S03)
- R039 — Manual `/worktree` coexistence (coexistence test proves no conflicts)

## Not Proven By This UAT

- R029 full end-to-end (slice merges within worktree — S02)
- R030 teardown + squash-merge on milestone complete (S03)
- R033/R034 preference-gated worktree creation (S04)
- Live auto-mode run with real milestone execution

## Notes for Tester

- Tests use temp directories that are cleaned up automatically
- macOS `/tmp` is a symlink to `/private/tmp` — tests use `realpathSync` to handle this
- The auto.ts wiring is verified by type-checking only — full runtime verification requires running auto-mode on a real project (covered by S07 integration tests)
