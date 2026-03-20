---
id: T02
parent: S01
milestone: M010
provides:
  - Hardened isSubstantiveMilestone rejects CONTEXT-only directories
  - Complete edge case coverage for milestone substantiveness checks
key_files:
  - src/resources/extensions/gsd/guided-flow.ts
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - CONTEXT.md and CONTEXT-DRAFT.md excluded from substantive artifact list — they represent queued/seeded milestones, not in-flight work
patterns_established:
  - A milestone must have ROADMAP.md, SUMMARY.md, or populated slices/ to be substantive
observability_surfaces:
  - none (pure logic function with explicit return values)
duration: 10m
verification_result: passed
completed_at: 2026-03-20T00:12:15-04:00
blocker_discovered: false
---

# T02: Strengthen isSubstantiveMilestone to reject metadata-only skeletons

**Removed CONTEXT.md and CONTEXT-DRAFT.md from qualifying artifacts so metadata-only directories are excluded from milestone election.**

## What Happened

Modified `isSubstantiveMilestone` in guided-flow.ts to exclude CONTEXT.md and CONTEXT-DRAFT.md from the list of artifacts that make a milestone "substantive." Added inline comment explaining the rationale: CONTEXT files represent queued/seeded milestones, not real in-flight work. A milestone needs at least ROADMAP.md, SUMMARY.md, or a populated slices/ directory to participate in active-milestone election.

Updated the test file with corrected expectations: CONTEXT-only and CONTEXT-DRAFT-only directories now correctly return false from isSubstantiveMilestone. Added a ROADMAP-only test case to complete edge case coverage per task plan step 3.

## Verification

- All 27 ghost-milestone-regression tests pass, including new ROADMAP-only edge case
- All 42 factcheck tests pass (no regressions)
- Edge cases verified: empty dir → false, CONTEXT-only → false, CONTEXT-DRAFT-only → false, ROADMAP-only → true, SUMMARY-only → true, slices dir → true

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` | 0 | ✅ pass | 1.1s |
| 2 | `npx tsx --test 'src/resources/extensions/gsd/tests/factcheck-*.test.ts'` | 0 | ✅ pass | 1.9s |

## Diagnostics

None applicable — this is a pure logic function with explicit boolean returns. The test suite provides complete coverage of all edge cases.

## Deviations

None. All task plan steps executed as specified.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/guided-flow.ts` — Removed CONTEXT.md and CONTEXT-DRAFT.md from substantive artifact list, added explanatory comment
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — Updated CONTEXT-only and CONTEXT-DRAFT-only tests to expect false, added ROADMAP-only test case
