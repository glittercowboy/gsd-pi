---
id: T03
parent: S01
milestone: M010
provides:
  - End-to-end verification that deriveState rejects CONTEXT-only ghosts
  - Comprehensive edge case coverage for ghost milestone scenarios
key_files:
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - CONTEXT-only ghosts (doctor repair skeletons) are correctly excluded from milestone election
  - Ghosts with depends_on frontmatter do not enter the milestone sequence
patterns_established:
  - A ghost milestone is any directory lacking ROADMAP.md, SUMMARY.md, or populated slices/
  - CONTEXT.md and CONTEXT-DRAFT.md alone represent queued/seeded milestones, not in-flight work
observability_surfaces:
  - Test assertions clearly indicate which ghost milestone incorrectly won election
  - deriveState registry entries expose status field; ghosts never have status='active'
duration: 10m
verification_result: passed
completed_at: 2026-03-20T00:15:00-04:00
blocker_discovered: false
---

# T03: Verify deriveState ghost rejection end-to-end

**Added two end-to-end tests proving deriveState rejects CONTEXT-only ghost milestones and activates real milestones.**

## What Happened

Ran the existing 27-assertion test suite for ghost-milestone-regression.test.ts — all passed with T02's hardened `isSubstantiveMilestone`. Added two new end-to-end test cases: (1) CONTEXT-only ghost alongside real ROADMAP milestone — deriveState correctly activates the real milestone; (2) CONTEXT-only ghost with depends_on frontmatter — does not enter the milestone sequence at all. Fixed pre-flight observability gaps by adding Observability sections to S01-PLAN.md and T03-PLAN.md.

## Verification

- Ran `ghost-milestone-regression.test.ts` — 32 assertions pass (27 existing + 5 new from 2 new test cases)
- Ran `factcheck-*.test.ts` — 42 tests pass, zero regressions
- All slice verification criteria met

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` | 0 | ✅ pass | 1.25s |
| 2 | `npx tsx --test src/resources/extensions/gsd/tests/factcheck-*.test.ts` | 0 | ✅ pass | 1.77s |

## Diagnostics

Test assertions provide clear failure messages indicating which ghost milestone incorrectly won election (e.g., "activeMilestone is M005 (real), not M001 (ghost)"). The `deriveState()` registry entries expose `status` field — ghost milestones never appear with `status: 'active'`.

## Deviations

None — followed the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — Added two new test cases for CONTEXT-only ghost scenarios
- `.gsd/milestones/M010/slices/S01/S01-PLAN.md` — Added Observability section and failure-path verification check
- `.gsd/milestones/M010/slices/S01/tasks/T03-PLAN.md` — Added Observability Impact section
