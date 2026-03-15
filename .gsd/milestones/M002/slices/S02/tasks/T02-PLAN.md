---
estimated_steps: 3
estimated_files: 2
---

# T02: Settle zero-mutation short-circuit and poll consolidation

**Slice:** S02 — Action pipeline performance
**Milestone:** M002

## Description

Save ~50ms on zero-mutation actions by short-circuiting the settle quiet window, and reduce per-poll evaluate overhead by combining `readMutationCounter` and `readFocusedDescriptor` into a single evaluate call.

Currently `settleAfterActionAdaptive` runs the full 100ms quiet window even when zero mutations have occurred. For actions like scroll, hover, or clicking static elements, this is wasted time. After 60ms with no mutation counter increment, the quiet window drops to 30ms.

Additionally, each poll iteration runs `readMutationCounter` (1 evaluate) and optionally `readFocusedDescriptor` (1 evaluate) sequentially. Combining them into one evaluate saves 1 round-trip per poll iteration (typically 2-4 polls per settle).

## Steps

1. **Add settle reason to type in state.ts**: Extend `AdaptiveSettleDetails.settleReason` union to include `"zero_mutation_shortcut"`.

2. **Create combined poll evaluate in settle.ts**: Replace separate `readMutationCounter` + `readFocusedDescriptor` calls in the poll loop with a single `readSettleState(target, checkFocus)` function that returns `{ mutationCount: number; focusDescriptor: string }` from one `target.evaluate()`. When `checkFocus` is false, return empty string for focusDescriptor. Keep the standalone `readMutationCounter` and `readFocusedDescriptor` exports for other consumers (interaction.ts imports `readFocusedDescriptor` directly for key_press before/after focus comparison).

3. **Implement zero-mutation short-circuit in settleAfterActionAdaptive**: Track `totalMutationsSeen` (sum of all mutation increments across polls). After 60ms, if `totalMutationsSeen === 0`, switch `quietWindowMs` to 30ms. When settle completes under this condition, return `settleReason: "zero_mutation_shortcut"`. The initial `ensureMutationCounter` + first `readMutationCounter` call before the loop should also be combined into the loop's first iteration where possible (use the combined evaluate).

## Must-Haves

- [ ] `AdaptiveSettleDetails.settleReason` union includes `"zero_mutation_shortcut"`
- [ ] Combined poll evaluate reads mutation counter + focus descriptor in one `evaluate()` call
- [ ] Zero-mutation short-circuit: after 60ms with no mutations, quiet window reduces to 30ms
- [ ] Settle returns `"zero_mutation_shortcut"` reason when short-circuit path is taken
- [ ] Standalone `readMutationCounter` and `readFocusedDescriptor` exports preserved for external consumers
- [ ] `npm run build` succeeds

## Verification

- `npm run build` exits 0
- `grep "zero_mutation_shortcut" src/resources/extensions/browser-tools/settle.ts` finds the new reason
- `grep "zero_mutation_shortcut" src/resources/extensions/browser-tools/state.ts` finds it in the type union
- The poll loop body contains a single `evaluate()` call (not two sequential ones)

## Inputs

- `src/resources/extensions/browser-tools/settle.ts` — current `settleAfterActionAdaptive`, `readMutationCounter`, `readFocusedDescriptor`
- `src/resources/extensions/browser-tools/state.ts` — `AdaptiveSettleDetails` interface
- S02 Research — settle timing analysis and proposed thresholds

## Expected Output

- `src/resources/extensions/browser-tools/settle.ts` — combined poll evaluate, zero-mutation short-circuit, new settle reason
- `src/resources/extensions/browser-tools/state.ts` — updated `AdaptiveSettleDetails.settleReason` type
