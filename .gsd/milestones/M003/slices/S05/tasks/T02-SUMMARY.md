---
id: T02
parent: S05
milestone: M003
provides:
  - self-heal wrappers integrated into merge and checkout paths in auto-worktree.ts and auto.ts
key_files:
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto.ts
key_decisions:
  - Re-throw MergeConflictError with correct branch context after withMergeHeal, since withMergeHeal uses "unknown" placeholders
patterns_established:
  - withMergeHeal wraps merge execSync calls; catch block re-throws MergeConflictError with correct branch names
  - recoverCheckout replaces raw git checkout execSync at both checkout sites
observability_surfaces:
  - formatGitError output in auto.ts error notifications includes /gsd doctor suggestion
duration: 8 minutes
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T02: Wire self-heal into auto-worktree.ts and auto.ts

**Integrated self-heal recovery (recoverCheckout, withMergeHeal, formatGitError) into merge/checkout paths**

## What Happened

Replaced raw `execSync git checkout` calls with `recoverCheckout` at both checkout sites (mergeSliceToMilestone and mergeMilestoneToMain). Wrapped both merge blocks with `withMergeHeal` for automatic abort+reset+retry on transient failures. Added `formatGitError` import to auto.ts and used it in the non-conflict error notification path (~L1675). MergeConflictError is re-thrown with correct branch context after withMergeHeal since the heal function uses "unknown" placeholders.

## Verification

- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-merge.test.ts` — 21 passed, 0 failed
- `npx tsx src/resources/extensions/gsd/tests/auto-worktree-milestone-merge.test.ts` — 23 passed, 0 failed
- `npx tsc --noEmit` — zero errors
- MergeConflictError propagation confirmed: test "branch includes S01" passes (correct branch context preserved)

## Diagnostics

- Merge failures in auto-mode now show user-friendly messages via formatGitError instead of raw git output
- All error messages include `/gsd doctor` suggestion
- Self-heal retry is transparent — withMergeHeal handles abort+reset+retry internally

## Deviations

MergeConflictError from withMergeHeal needed re-throw with correct branch names (sliceBranch/milestoneBranch) since withMergeHeal creates errors with "unknown" placeholders. This was discovered via test failure and fixed.

## Known Issues

None

## Files Created/Modified

- `src/resources/extensions/gsd/auto-worktree.ts` — replaced checkout/merge with recoverCheckout/withMergeHeal wrappers
- `src/resources/extensions/gsd/auto.ts` — added formatGitError import and usage in non-conflict error path
