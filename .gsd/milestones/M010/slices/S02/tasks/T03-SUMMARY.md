---
id: T03
parent: S02
milestone: M010
provides:
  - End-to-end test proving the full damaged-state recovery path works correctly
  - Verification that ghost milestones don't pollute state derivation
  - Proof that doctor diagnostics surface ghosts with actionable guidance
key_files:
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - Structured the e2e test to mirror the exact observed user incident (ghost M001/M002, CONTEXT-only M003, real M010)
  - Used nativeInit to create a git worktree on milestone/M010 branch for realistic lineage simulation
patterns_established:
  - End-to-end tests should test the full incident path: fixture setup → doctor → deriveState → rebuildState
observability_surfaces:
  - Test output shows each step of the recovery path with assertion messages
  - Console warning from rebuildState visible in test output when regression is detected
duration: 15m
verification_result: passed
completed_at: 2026-03-20T04:45:00Z
blocker_discovered: false
---

# T03: End-to-end damaged-state recovery test

**Added end-to-end test proving ghost milestones don't regress active milestone after doctor repair.**

## What Happened

The task created a comprehensive end-to-end test that reproduces the observed user incident: ghost milestone directories (M001, M002 as empty dirs, M003 with only CONTEXT.md) existing alongside a real in-flight milestone (M010 with ROADMAP and incomplete slices).

The test verifies the full recovery path:

1. **Fixture setup**: Creates the incident state with ghost M001/M002/M003 and real M010, initializes git repo on milestone/M010 branch
2. **Doctor checks**: Verifies `orphaned_milestone_directory` warnings are emitted for M001, M002, M003 but NOT for M010
3. **deriveState()**: Verifies M010 is returned as the active milestone despite ghost presence
4. **rebuildState()**: Reads STATE.md and verifies M010 is shown as active with no regression warning

The test confirms that all three slice verification requirements pass:
- Ghost filtering works (ghosts excluded from state derivation)
- Doctor diagnostics surface ghosts with actionable file inventory
- rebuildState regression guard doesn't fire when branch matches derived milestone

## Verification

Ran the full test suite for ghost milestone regression tests, verifying all 77 tests pass including the new end-to-end test. Also ran factcheck tests to confirm no regressions (42 tests pass).

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` | 0 | ✅ pass | 1.4s |
| 2 | `npx tsx --test 'src/resources/extensions/gsd/tests/factcheck-*.test.ts'` | 0 | ✅ pass | 1.9s |

## Diagnostics

To verify the end-to-end test:
- Run `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts`
- Look for the "e2e: damaged-state recovery with ghost milestones" test case
- The test output shows each step (fixture setup, doctor checks, deriveState, rebuildState) with assertions

## Deviations

None. Implementation followed the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — Added end-to-end damaged-state recovery test that creates ghost milestones + real M010, runs doctor/deriveState/rebuildState, and verifies correct active milestone throughout
- `.gsd/milestones/M010/slices/S02/tasks/T03-PLAN.md` — Added missing Observability Impact section
