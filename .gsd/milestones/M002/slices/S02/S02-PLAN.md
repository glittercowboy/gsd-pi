# S02: Action pipeline performance

**Goal:** Reduce per-action evaluate overhead by consolidating state capture, short-circuiting settle on zero mutations, and skipping body text for low-signal actions.
**Demo:** Build succeeds. A browser_click action runs 3 fewer evaluate calls than before (5+N vs 8+N). Settle returns `zero_mutation_shortcut` reason when no mutations fire. Low-signal tools (scroll, hover, drag) skip body text capture.

## Must-Haves

- `postActionSummary` eliminated from high-signal tools — replaced by `captureCompactPageState` + `formatCompactStateSummary`
- `countOpenDialogs` removed as standalone call — dialog count comes from `captureCompactPageState`'s existing `dialog.count` field
- High-signal tools (click, type, key_press, select_option, set_checked, navigate) capture body text in afterState
- Low-signal tools (scroll, hover, drag, upload_file, hover_ref) skip body text in `captureCompactPageState`
- `settleAfterActionAdaptive` short-circuits with `zero_mutation_shortcut` settle reason when no mutations fire in the first 60ms
- `AdaptiveSettleDetails.settleReason` type includes `"zero_mutation_shortcut"`
- `readMutationCounter` + `readFocusedDescriptor` combined into single evaluate per settle poll
- Build succeeds via `npm run build`

## Proof Level

- This slice proves: operational + behavioral
- Real runtime required: no (build verification sufficient — behavioral improvements are structural, not observable without timing instrumentation)
- Human/UAT required: no

## Verification

- `npm run build` succeeds with zero errors
- `grep -c "countOpenDialogs" src/resources/extensions/browser-tools/tools/*.ts` returns 0 (no standalone dialog counting in tool files)
- `grep -c "postActionSummary" src/resources/extensions/browser-tools/tools/interaction.ts` returns 0 for high-signal tools that now use direct capture
- `grep "zero_mutation_shortcut" src/resources/extensions/browser-tools/settle.ts` finds the new settle reason
- `grep "includeBodyText" src/resources/extensions/browser-tools/tools/interaction.ts` shows explicit true/false per tool signal level

## Tasks

- [x] **T01: Consolidate capture pipeline and classify tool signal levels** `est:45m`
  - Why: R017 + R018 — eliminate redundant evaluate calls per action by removing the `postActionSummary` + separate `captureCompactPageState` pattern in high-signal tools, folding `countOpenDialogs` into the existing `dialog.count` from captureCompactPageState, and classifying tools as high/low signal for body text capture.
  - Files: `capture.ts`, `state.ts`, `utils.ts`, `index.ts`, `tools/interaction.ts`, `tools/navigation.ts`, `tools/refs.ts`
  - Do: (1) Remove `postActionSummary` from ToolDeps — high-signal tools call `captureCompactPageState(includeBodyText: true)` once for afterState and derive summary via `formatCompactStateSummary`. Low-signal tools call `captureCompactPageState(includeBodyText: false)` and derive summary. (2) Remove standalone `countOpenDialogs` calls from tool files — use `afterState.dialog.count` / `beforeState.dialog.count` from the state already captured. (3) Keep `postActionSummary` function in capture.ts but remove it from ToolDeps and stop using it in action tools. Summary-only tools (go_back, go_forward, reload) can keep calling it since they don't do before/after diff. (4) Update ToolDeps interface. (5) Build verify.
  - Verify: `npm run build` succeeds. `grep -c "countOpenDialogs" src/resources/extensions/browser-tools/tools/*.ts` returns 0. High-signal tools in interaction.ts have `includeBodyText: true` in afterState capture and no `postActionSummary` call.
  - Done when: Build passes and high-signal tools use consolidated capture with explicit body text classification.

- [x] **T02: Settle zero-mutation short-circuit and poll consolidation** `est:25m`
  - Why: R019 — save ~50ms on zero-mutation actions by short-circuiting the settle quiet window, and reduce per-poll evaluate calls by combining readMutationCounter + readFocusedDescriptor into one evaluate.
  - Files: `settle.ts`, `state.ts`
  - Do: (1) Add `"zero_mutation_shortcut"` to `AdaptiveSettleDetails.settleReason` union in state.ts. (2) In `settleAfterActionAdaptive`, track whether any mutation has fired since start. After 60ms with zero mutations, switch to a 30ms quiet window instead of 100ms and return `zero_mutation_shortcut` reason. (3) Combine `readMutationCounter` + `readFocusedDescriptor` into a single `readSettleState(target, checkFocus)` evaluate that returns `{ mutationCount, focusDescriptor }`. Replace per-poll sequential evaluates with this combined call. (4) Build verify.
  - Verify: `npm run build` succeeds. `grep "zero_mutation_shortcut" src/resources/extensions/browser-tools/settle.ts` finds the new reason. The combined poll evaluate is a single `target.evaluate()` call returning both mutation count and focus descriptor.
  - Done when: Build passes. Settle logic has zero-mutation short-circuit and combined poll evaluate.

## Files Likely Touched

- `src/resources/extensions/browser-tools/capture.ts`
- `src/resources/extensions/browser-tools/settle.ts`
- `src/resources/extensions/browser-tools/state.ts`
- `src/resources/extensions/browser-tools/utils.ts`
- `src/resources/extensions/browser-tools/index.ts`
- `src/resources/extensions/browser-tools/tools/interaction.ts`
- `src/resources/extensions/browser-tools/tools/navigation.ts`
- `src/resources/extensions/browser-tools/tools/refs.ts`
