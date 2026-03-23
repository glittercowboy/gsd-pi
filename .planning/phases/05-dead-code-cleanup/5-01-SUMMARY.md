---
phase: 05-dead-code-cleanup
plan: 01
status: complete
started: 2026-03-22
completed: 2026-03-22
---

## Summary

Removed selfHealRuntimeRecords, verifyExpectedArtifact (and helpers), and the doctor-fix/STATE-rebuild blocks from auto-post-unit.ts. These were dead code since Phase 4 moved all state authority to the engine.

## What Was Done

1. Removed `verifyExpectedArtifact`, `resolveExpectedArtifactPath`, `diagnoseExpectedArtifact` from `auto-recovery.ts` (~200 lines)
2. Extracted `resolveExpectedArtifactPath` + `diagnoseExpectedArtifact` to new `auto-artifact-paths.ts` (still needed by `auto-timeout-recovery.ts`)
3. Removed `runGSDDoctor` call and `rebuildState` block from `auto-post-unit.ts`
4. Replaced `verifyExpectedArtifact` calls in `forensics.ts` and `auto/phases.ts` with WorkflowEngine queries
5. Removed `verifyExpectedArtifact` from `loop-deps.ts` interface
6. Removed `selfHealRuntimeRecords` tombstone comments from `auto.ts` and `guided-flow.ts`
7. Updated `auto-timeout-recovery.ts` to import from `auto-artifact-paths.js`

## Key Files

### Created
- `src/resources/extensions/gsd/auto-artifact-paths.ts` — Extracted artifact path resolution (still used)

### Modified
- `src/resources/extensions/gsd/auto-recovery.ts` — Major shrink, dead functions removed
- `src/resources/extensions/gsd/auto-post-unit.ts` — Doctor/STATE blocks removed
- `src/resources/extensions/gsd/forensics.ts` — Engine queries replace verifyExpectedArtifact
- `src/resources/extensions/gsd/auto/phases.ts` — Engine queries replace verifyExpectedArtifact
- `src/resources/extensions/gsd/auto/loop-deps.ts` — Interface cleaned
- `src/resources/extensions/gsd/auto.ts` — Tombstone comments removed
- `src/resources/extensions/gsd/guided-flow.ts` — Stale imports removed

## Net Impact

- 277 insertions, 404 deletions (net -127 lines)
- All 10 auto-recovery tests pass
- Overall test suite: 1412 pass (up from 1402 baseline)

## Decisions

- 5-01: Extracted artifact path helpers to auto-artifact-paths.ts rather than duplicating code (auto-timeout-recovery.ts still needs them)

## Self-Check: PASSED

- [x] selfHealRuntimeRecords does not exist as callable function
- [x] verifyExpectedArtifact does not exist outside auto-artifact-paths
- [x] auto-post-unit.ts contains no doctor fix runs
- [x] auto-post-unit.ts contains no STATE.md rebuild logic
- [x] All tests pass after removals
