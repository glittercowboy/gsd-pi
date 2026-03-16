# S07: Test suite for worktree-isolated flow

**Goal:** Full test coverage for the worktree-isolated git flow, confirming zero regressions across all existing tests.
**Demo:** `npm run test:unit && npm run test:integration` passes with the new e2e test file exercising the complete lifecycle.

## Must-Haves

- End-to-end test: create worktree → merge 2 slices (--no-ff) → squash milestone to main → verify git log
- Preference gating test: isolation: "branch" skips worktree creation
- merge_to_main: "slice" test: routes slice merges to main instead of milestone branch
- Self-heal in context: corrupt merge state → self-heal clears → merge succeeds
- Doctor in context: orphaned worktree detected and fixed after simulated crash
- All existing tests pass — zero regressions

## Proof Level

- This slice proves: integration
- Real runtime required: yes (real git repos)
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts` — all assertions pass
- `npm run test:unit` — zero failures across all test files
- `npm run test:integration` — zero failures

## Tasks

- [x] **T01: Write worktree-e2e.test.ts and verify full regression suite** `est:45m`
  - Why: This is the entire slice — one test file covering the 5 gap scenarios identified in research, plus a full regression run to confirm zero breakage.
  - Files: `src/resources/extensions/gsd/tests/worktree-e2e.test.ts`
  - Do: Create `worktree-e2e.test.ts` using established patterns (createTestContext, realpathSync temp dirs, try/finally cleanup). 5 test groups: (1) full lifecycle — create worktree, add 2 slices via addSliceToMilestone helper, squash to main, verify single commit on main with both slice titles in message; (2) preference gating — call shouldUseWorktreeIsolation with overridePrefs isolation:"branch", confirm it returns false; (3) merge_to_main:"slice" — call getMergeToMainMode with overridePrefs, confirm it returns "slice"; (4) self-heal+retry — create repo with MERGE_HEAD file, call abortAndReset, verify cleaned; (5) doctor in context — create completed milestone with orphaned worktree, run checkGitHealth, verify issue detected and fixed. No Unicode in JSDoc. Restore cwd in finally blocks. Then run `npm run test:unit && npm run test:integration` and confirm zero failures.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts` passes, then `npm run test:unit` passes
  - Done when: New test file passes with 15+ assertions covering all 5 scenarios, and full regression suite has zero new failures

## Files Likely Touched

- `src/resources/extensions/gsd/tests/worktree-e2e.test.ts`

## Observability / Diagnostics

- **Runtime signals:** Test file outputs pass/fail counts to stdout via `createTestContext().report()`. Non-zero exit code on any failure.
- **Inspection:** Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-e2e.test.ts` to see per-group results.
- **Failure visibility:** Failed assertions print `FAIL: <message>` with expected vs actual values to stderr. Process exits with code 1.
- **Redaction:** No secrets or PII in test output — uses temp repos with synthetic data.
