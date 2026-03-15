---
id: T02
parent: S02
milestone: M002
provides:
  - Zero-mutation short-circuit — settle completes ~50ms faster when no DOM mutations fire (30ms quiet window instead of 100ms)
  - Combined poll evaluate — readSettleState() reads mutation counter + focus descriptor in one evaluate() call, saving 1 round-trip per poll iteration
key_files:
  - src/resources/extensions/browser-tools/settle.ts
  - src/resources/extensions/browser-tools/state.ts
key_decisions:
  - readSettleState is module-private (not exported) since only settleAfterActionAdaptive needs it; standalone readMutationCounter and readFocusedDescriptor preserved for external consumers
  - Zero-mutation threshold set at 60ms with 30ms shortened quiet window, matching the plan thresholds
  - Short-circuit only activates when totalMutationsSeen === 0 (not just current poll), ensuring any mutation activity during settle prevents the shortcut
patterns_established:
  - Combined evaluate pattern for settle polling — single page.evaluate() returns structured object with all needed values
observability_surfaces:
  - settleReason "zero_mutation_shortcut" in AdaptiveSettleDetails distinguishes short-circuited settles from normal dom_quiet
duration: 10m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Settle zero-mutation short-circuit and poll consolidation

**Added zero-mutation settle short-circuit (60ms threshold → 30ms quiet window) and combined per-poll evaluate call.**

## What Happened

Three changes in settle.ts and one in state.ts:

1. Added `"zero_mutation_shortcut"` to the `AdaptiveSettleDetails.settleReason` union type.

2. Created `readSettleState(target, checkFocus)` — a module-private function that reads both the mutation counter and focused element descriptor in a single `target.evaluate()` call. This replaces the two sequential `readMutationCounter` + `readFocusedDescriptor` calls in the poll loop, saving one evaluate round-trip per iteration (typically 2-4 iterations per settle = 2-4 fewer evaluate calls per action).

3. In `settleAfterActionAdaptive`, added `totalMutationsSeen` tracking across all polls. After 60ms with zero total mutations, `activeQuietWindowMs` drops from 100ms to 30ms. When settle completes under this condition, the returned reason is `"zero_mutation_shortcut"` instead of `"dom_quiet"`.

The standalone `readMutationCounter` and `readFocusedDescriptor` exports are preserved — interaction.ts imports `readFocusedDescriptor` directly for key_press before/after focus comparison.

## Verification

- `npm run build` exits 0 — clean build
- `grep "zero_mutation_shortcut" state.ts` — found in type union
- `grep "zero_mutation_shortcut" settle.ts` — found in return path
- Poll loop body contains single `readSettleState()` call (line 147), not two sequential evaluates
- Standalone `readMutationCounter` (line 38) and `readFocusedDescriptor` (line 54) preserved as exports

### Slice-level verification (all 5 pass — this is the final task):
- `npm run build` succeeds ✅
- `countOpenDialogs` count = 0 in all tool files ✅
- `postActionSummary` count = 0 in interaction.ts ✅
- `zero_mutation_shortcut` found in settle.ts ✅
- `includeBodyText` explicit per tool signal level in interaction.ts ✅

## Diagnostics

The `settleReason` field in `AdaptiveSettleDetails` is returned from every settle call. Tools that log or return settle details will show `"zero_mutation_shortcut"` when the short-circuit path was taken, making it observable in tool output without additional instrumentation.

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/settle.ts` — added `readSettleState()` combined evaluate, zero-mutation short-circuit logic with 60ms/30ms thresholds, `ZERO_MUTATION_THRESHOLD_MS` and `ZERO_MUTATION_QUIET_MS` constants
- `src/resources/extensions/browser-tools/state.ts` — added `"zero_mutation_shortcut"` to `AdaptiveSettleDetails.settleReason` union type
