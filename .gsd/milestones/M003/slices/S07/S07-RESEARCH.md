# S07: Test suite for worktree-isolated flow — Research

**Date:** 2026-03-14

## Summary

S07 is a test consolidation and gap-filling slice. S01–S06 each built their own integration tests (total: ~140 assertions across 7 test files). All 7 files pass today with the resolve-ts.mjs loader. The primary gap is **end-to-end flow tests** that chain multiple operations (create worktree → slice merges → milestone squash → teardown) and **preference-driven behavior tests** (set isolation: "branch" → confirm no worktree created). There is no missing infrastructure — all test helpers, patterns, and the real-temp-repo approach are established.

The secondary goal is ensuring existing git tests (`git-service.test.ts` at 1788 lines, `worktree.test.ts`, `worktree-manager.test.ts`, `worktree-integration.test.ts`) still pass — confirming zero regressions in branch-per-slice mode.

## Recommendation

Create one new test file `worktree-e2e.test.ts` that tests the full lifecycle across multiple operations. Don't restructure or consolidate existing test files — they're well-scoped to their slices and all pass. The new file should cover:

1. **Full lifecycle**: create worktree → merge 2 slices (--no-ff) → squash milestone to main → verify git log
2. **Preference gating**: isolation: "branch" skips worktree creation; isolation: "worktree" creates it
3. **merge_to_main: "slice"** routes slice merges to main instead of milestone branch
4. **Self-heal + retry**: corrupt merge state → self-heal clears it → merge succeeds
5. **Doctor finds/fixes issues in context**: orphaned worktree after simulated crash

Then run `npm run test:unit && npm run test:integration` to confirm zero regressions across all 64 test files.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Temp git repo setup | `createTestContext` + helper pattern from all M003 tests | Consistent assertion API, cleanup |
| Worktree creation in tests | `createAutoWorktree` from auto-worktree.ts | Already proven in S01 tests |
| Slice merge setup | `addSliceToMilestone` helper from auto-worktree-milestone-merge.test.ts | Creates realistic branch history |
| Resolve .ts imports | `resolve-ts.mjs` loader | Required for all tests — .js import specifiers map to .ts files |

## Existing Code and Patterns

- `tests/auto-worktree.test.ts` (147 lines, 21 assertions) — lifecycle create/teardown/re-entry/coexistence. Pattern: single `main()` async function, `createTestContext()` for assertions, `realpathSync(mkdtempSync(...))` for macOS /tmp symlink handling, `try/finally` cleanup.
- `tests/auto-worktree-merge.test.ts` (282 lines, 21 assertions) — --no-ff slice merge. Pattern: helper to create worktree + slice branch + commits, then call `mergeSliceToMilestone`.
- `tests/auto-worktree-milestone-merge.test.ts` (259 lines, 23 assertions) — squash merge to main. Pattern: `addSliceToMilestone` helper, verify `git log --oneline main`.
- `tests/git-self-heal.test.ts` (234 lines, 14 assertions) — deliberately broken git state, verify recovery.
- `tests/doctor-git.test.ts` (246 lines, 17 assertions) — `createRepoWithCompletedMilestone` helper, detect→fix→verify cycle.
- `tests/isolation-resolver.test.ts` (107 lines, 4 assertions) — resolver with overridePrefs.
- `tests/preferences-git.test.ts` (88 lines, 21 assertions) — validation of git preference fields.
- `tests/git-service.test.ts` (1788 lines) — existing branch-per-slice tests, must not regress.

## Constraints

- Tests must run via `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test` — direct `node --test` without the loader fails on .js→.ts import resolution.
- `loadEffectiveGSDPreferences` captures `process.cwd()` at module load time — preference-driven tests must use `overridePrefs` parameter on `shouldUseWorktreeIsolation`, not actual pref files.
- No Unicode characters in JSDoc comments — Node's strip-types parser misinterprets them (D035/S04 forward intel).
- `process.chdir` in tests affects global state — each test must restore cwd in finally block.
- macOS `/tmp` is a symlink to `/private/tmp` — use `realpathSync` on temp dirs for assertion equality.

## Common Pitfalls

- **Forgetting resolve-ts.mjs loader** — tests fail with `ERR_MODULE_NOT_FOUND` for .js imports. Always run via `npm run test:unit`.
- **Leftover worktrees from crashed tests** — `git worktree remove` in finally blocks. Tests that crash mid-worktree leave orphans that break subsequent runs.
- **chdir not restored** — if a test calls `createAutoWorktree` (which does chdir) and throws before cleanup, subsequent tests run in wrong directory.
- **Module state leakage** — `originalBase` in auto-worktree.ts is module-level. Must call `teardownAutoWorktree` or manually reset between tests.

## Open Risks

- Running `npm run test:unit` across all 64 test files may surface pre-existing failures unrelated to M003. These should be noted but not blocked on.
- The `git-service.test.ts` (1788 lines) may have edge cases that interact with new exports in auto-worktree.ts — unlikely but possible.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Node.js test runner | built-in `node:test` | native — no skill needed |
| Git worktrees | core git feature | no skill applicable |

## Sources

- All source material from existing test files and slice summaries (S01–S06)
- No external research needed — this is a test-writing slice using established patterns
