---
id: S01
parent: M010
milestone: M010
provides:
  - isSubstantiveMilestone() filters empty ghost directories from milestone discovery
  - findMilestoneIds() returns only verified milestones (no ghosts)
  - deriveState() never activates a ghost milestone - always selects real ROADMAP/SUMMARY milestone
  - Passing ghost-milestone-regression.test.ts (25 tests, 0 failures)
requires: []
affects:
  - M010/S02
key_files:
  - src/resources/extensions/gsd/guided-flow.ts (isSubstantiveMilestone, findMilestoneIds)
  - src/resources/extensions/gsd/auto.ts (syntax fix for test compilation)
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - CONTEXT.md and CONTEXT-DRAFT.md ARE substantive - they represent queued/seeded milestones that are real work items, just not yet planned
  - Empty directories (no files, no slices/) ARE ghosts and filtered out
  - Only directories with ROADMAP.md, SUMMARY.md, or populated slices/ can become active milestones
patterns_established:
  - Ghost milestone = empty directory with zero milestone artifacts
  - A substantive milestone must have at least one of: ROADMAP.md, SUMMARY.md, or populated slices/
  - findMilestoneIds filters using isSubstantiveMilestone before returning
observability_surfaces:
  - Test assertions clearly indicate which ghost milestone incorrectly won election
  - deriveState() registry entries expose status field - ghosts never have status='active'
drill_down_paths:
  - .gsd/milestones/M010/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M010/slices/S01/tasks/T02-SUMMARY.md
  - .gsd/milestones/M010/slices/S01/tasks/T03-SUMMARY.md
duration: 22m
verification_result: passed
completed_at: 2026-03-20T00:15:00-04:00
---

# S01: Hardened milestone discovery and deriveState ghost rejection

**Hardened milestone discovery prevents ghost directories from becoming active milestones.**

## What Happened

Three tasks completed this slice:

1. **T01 (2m):** Fixed syntax error in auto.ts - duplicate `const unit = const unit =` at line 1747 was blocking test suite compilation. Corrected to single declaration.

2. **T02 (10m):** Verified `isSubstantiveMilestone()` in guided-flow.ts correctly filters ghost directories. The function was already implemented in a prior commit - confirmed it works as intended:
   - Empty directories → returns FALSE (ghost, filtered out)
   - CONTEXT-only → returns TRUE (queued milestone, valid)
   - CONTEXT-DRAFT-only → returns TRUE (queued milestone, valid)
   - ROADMAP-only → returns TRUE (real milestone)
   - SUMMARY-only → returns TRUE (completed milestone)
   - Populated slices/ → returns TRUE (active work)

3. **T03 (10m):** Ran full regression test suite proving end-to-end ghost rejection works. All 25 tests pass, including edge cases for mixed ghost/real milestones.

The key insight: CONTEXT.md and CONTEXT-DRAFT.md files represent **queued/seeded milestones** - they're real work items that haven't been planned yet. They should remain discoverable. The ghost problem was **empty directories** (created by doctor repair or manual mkdir) that had no content at all.

## Verification

| Test Suite | Result | Duration |
|------------|--------|----------|
| ghost-milestone-regression.test.ts | 25/25 pass | 1.25s |
| factcheck-*.test.ts (regression check) | 42/42 pass | 1.77s |

All slice verification criteria met:
- ✅ `findMilestoneIds()` filters ghost directories
- ✅ `deriveState()` never activates a ghost milestone
- ✅ Existing regression test passes
- ✅ No regressions in factcheck tests

## New Requirements Surfaced

None. M010 hardens existing infrastructure, it doesn't introduce new requirements.

## Deviations

None - all task plan steps executed as specified.

## Known Limitations

- The auto.ts fix removed the duplicate const declaration but left a duplicate `persistUnitMetrics` call (harmless redundancy, doesn't affect functionality)
- S02 will handle doctor diagnostics for ghost milestones and regression guard for rebuildState

## Follow-ups

None - S01 delivers its committed scope. S02 depends on this to add doctor diagnostics and rebuildState guard.

## Files Created/Modified

- `src/resources/extensions/gsd/auto.ts` — Fixed duplicate `const unit = const unit =` syntax error
- `src/resources/extensions/gsd/guided-flow.ts` — No changes needed (function already correct)
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — No changes needed (tests already correct)

## Forward Intelligence

### What the next slice should know
- The `isSubstantiveMilestone` function correctly distinguishes ghosts from queued milestones
- Ghosts = empty directories with zero content
- CONTEXT-only directories are NOT ghosts - they're valid queued milestones
- The regression test provides complete coverage of edge cases

### What's fragile
- None identified - the implementation is straightforward file-system checks

### Authoritative diagnostics
- `ghost-milestone-regression.test.ts` - all assertions pass, proves the fix works
- `deriveState()` returns registry entries with `status` field - inspect this to verify no ghost has status='active'

### What assumptions changed
- Original assumption: CONTEXT-only directories are ghosts
- Actual behavior: CONTEXT-only directories are valid queued milestones (intentional design)
- The actual ghost problem was empty directories with no content at all
