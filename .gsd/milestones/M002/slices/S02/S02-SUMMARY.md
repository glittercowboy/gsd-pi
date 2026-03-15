---
id: S02
parent: M002
milestone: M002
provides:
  - Consolidated capture pipeline — action tools use single captureCompactPageState + formatCompactStateSummary instead of postActionSummary + captureCompactPageState + countOpenDialogs
  - Signal-classified body text capture — high-signal tools (click, type, key_press, select_option, set_checked, navigate, click_ref, fill_ref) capture body text, low-signal tools (scroll, hover, drag, upload_file, hover_ref) skip it
  - Zero-mutation settle short-circuit — 60ms detection window, 30ms shortened quiet window, zero_mutation_shortcut settle reason
  - Combined settle poll evaluate — readSettleState() reads mutation counter + focus descriptor in one evaluate call
requires:
  - slice: S01
    provides: Module decomposition (state.ts, capture.ts, settle.ts, tools/interaction.ts, tools/navigation.ts, tools/refs.ts, index.ts)
affects:
  - S06
key_files:
  - src/resources/extensions/browser-tools/tools/interaction.ts
  - src/resources/extensions/browser-tools/tools/navigation.ts
  - src/resources/extensions/browser-tools/tools/refs.ts
  - src/resources/extensions/browser-tools/settle.ts
  - src/resources/extensions/browser-tools/state.ts
  - src/resources/extensions/browser-tools/index.ts
key_decisions:
  - D017 — Action tool signal classification (high vs low signal for body text capture)
  - D018 — postActionSummary retained for summary-only navigation tools, removed from action tools
  - D019 — Zero-mutation settle thresholds (60ms detection, 30ms quiet window)
patterns_established:
  - High-signal tool pattern: captureCompactPageState(includeBodyText: true) → formatCompactStateSummary(afterState)
  - Low-signal tool pattern: captureCompactPageState(includeBodyText: false) → formatCompactStateSummary(afterState)
  - Dialog count via state.dialog.count instead of standalone countOpenDialogs evaluate
  - Combined settle poll evaluate returning structured { mutationCount, focusDescriptor }
observability_surfaces:
  - settleReason "zero_mutation_shortcut" in AdaptiveSettleDetails distinguishes short-circuited settles from normal dom_quiet
drill_down_paths:
  - .gsd/milestones/M002/slices/S02/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S02/tasks/T02-SUMMARY.md
duration: 30m
verification_result: passed
completed_at: 2026-03-12
---

# S02: Action pipeline performance

**Eliminated ~3 redundant evaluate calls per action via consolidated capture pipeline, signal-classified body text, and zero-mutation settle short-circuit.**

## What Happened

Two tasks, both structural refactors to the action pipeline.

**T01 — Capture consolidation.** Refactored all 10 interaction tools, browser_navigate, and 3 ref action tools. High-signal tools (click, type, key_press, select_option, set_checked, navigate, click_ref, fill_ref) now call `captureCompactPageState(includeBodyText: true)` once for afterState and derive the summary via `formatCompactStateSummary`. Low-signal tools (scroll, hover, drag, upload_file, hover_ref) use `includeBodyText: false`. `countOpenDialogs` removed from ToolDeps — dialog count comes from the state object's `dialog.count` field. `postActionSummary` retained only for summary-only navigation tools (go_back, go_forward, reload) that don't do before/after diffs.

**T02 — Settle optimization.** Added `zero_mutation_shortcut` settle reason. After 60ms with zero total mutations observed, the quiet window shrinks from 100ms to 30ms. Created module-private `readSettleState()` that reads both mutation counter and focus descriptor in a single evaluate call, replacing two sequential evaluates per poll iteration (typically 2-4 iterations per settle). Standalone `readMutationCounter` and `readFocusedDescriptor` exports preserved for external consumers.

## Verification

All 5 slice-level checks pass:
- ✅ `npm run build` exits 0
- ✅ `grep -c "countOpenDialogs" tools/*.ts` returns 0 for all 9 tool files
- ✅ `grep -c "postActionSummary" tools/interaction.ts` returns 0
- ✅ `grep "zero_mutation_shortcut" settle.ts` finds the new settle reason
- ✅ `grep "includeBodyText" tools/interaction.ts` shows explicit true/false per tool signal level

## Requirements Advanced

- R017 — postActionSummary eliminated from action tools, countOpenDialogs removed from ToolDeps, single captureCompactPageState call per action
- R018 — explicit includeBodyText classification for all action tools, 5 high-signal and 4 low-signal in interaction.ts
- R019 — zero_mutation_shortcut settle reason, combined poll evaluate, 60ms/30ms thresholds

## Requirements Validated

- R017 — Build passes, grep confirms zero postActionSummary in interaction.ts and zero countOpenDialogs in all tool files
- R018 — Build passes, grep confirms explicit includeBodyText true/false per tool
- R019 — Build passes, grep confirms zero_mutation_shortcut in settle.ts type and return path

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

None.

## Known Limitations

- No runtime timing instrumentation to measure actual ms savings — the improvements are structural (fewer evaluate round-trips) and verifiable by code inspection, not runtime benchmarks
- `readSettleState` is module-private — if other modules need combined mutation+focus reads, it would need to be exported

## Follow-ups

None — S06 will add test coverage for the settle short-circuit logic and signal classification.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/interaction.ts` — All 10 tools refactored: 5 high-signal with includeBodyText: true, 4 low-signal with includeBodyText: false, 1 (set_viewport) unchanged
- `src/resources/extensions/browser-tools/tools/navigation.ts` — browser_navigate uses afterState + formatCompactStateSummary instead of postActionSummary
- `src/resources/extensions/browser-tools/tools/refs.ts` — click_ref (high), fill_ref (high), hover_ref (low) use consolidated capture; countOpenDialogs removed
- `src/resources/extensions/browser-tools/settle.ts` — readSettleState() combined evaluate, zero-mutation short-circuit with ZERO_MUTATION_THRESHOLD_MS (60ms) and ZERO_MUTATION_QUIET_MS (30ms) constants
- `src/resources/extensions/browser-tools/state.ts` — zero_mutation_shortcut added to AdaptiveSettleDetails.settleReason union; countOpenDialogs removed from ToolDeps
- `src/resources/extensions/browser-tools/index.ts` — countOpenDialogs removed from ToolDeps wiring

## Forward Intelligence

### What the next slice should know
- The capture pipeline is now consistently `captureCompactPageState(opts) → formatCompactStateSummary(state)` for all action tools. Any new action tools should follow this pattern with explicit signal classification.
- `postActionSummary` still exists in capture.ts and ToolDeps for summary-only tools (go_back, go_forward, reload). Don't remove it without migrating those.

### What's fragile
- Signal classification is hardcoded per tool — if a tool's behavior changes (e.g., upload_file starts triggering form validation), its classification may need updating. The classification lives inline in each tool handler, not in a central registry.

### Authoritative diagnostics
- `settleReason` in AdaptiveSettleDetails — when debugging settle behavior, check whether `zero_mutation_shortcut` is firing. If it fires on actions that should have mutations, the 60ms threshold may be too short.
- `grep "includeBodyText"` in tool files — instant audit of signal classification across all tools.

### What assumptions changed
- None — the plan's assumptions about evaluate call counts and settle behavior held.
