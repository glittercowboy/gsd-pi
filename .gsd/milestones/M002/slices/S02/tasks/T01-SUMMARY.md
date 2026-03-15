---
id: T01
parent: S02
milestone: M002
provides:
  - Consolidated capture pipeline — high-signal tools do one captureCompactPageState(includeBodyText: true) for afterState, low-signal tools do one with includeBodyText: false
  - Dialog count from state — all tools use beforeState.dialog.count / afterState.dialog.count instead of standalone countOpenDialogs
  - countOpenDialogs removed from ToolDeps interface and index.ts wiring
key_files:
  - src/resources/extensions/browser-tools/tools/interaction.ts
  - src/resources/extensions/browser-tools/tools/navigation.ts
  - src/resources/extensions/browser-tools/tools/refs.ts
  - src/resources/extensions/browser-tools/state.ts
  - src/resources/extensions/browser-tools/index.ts
key_decisions:
  - postActionSummary retained in ToolDeps for summary-only navigation tools (go_back, go_forward, reload) that don't do before/after diff
  - browser_click_ref and browser_fill_ref classified as high-signal (includeBodyText: true), browser_hover_ref as low-signal (includeBodyText: false)
patterns_established:
  - High-signal tool pattern: captureCompactPageState(includeBodyText: true) → formatCompactStateSummary(afterState) for summary text
  - Low-signal tool pattern: captureCompactPageState(includeBodyText: false) → formatCompactStateSummary(afterState) for summary text
  - Dialog count comparison via state.dialog.count instead of standalone evaluate call
observability_surfaces:
  - none
duration: 20m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Consolidate capture pipeline and classify tool signal levels

**Eliminated 3 redundant evaluate round-trips per high-signal action by consolidating postActionSummary + captureCompactPageState + countOpenDialogs into a single captureCompactPageState call with explicit signal classification.**

## What Happened

Refactored all 10 interaction tools, browser_navigate, and 3 ref action tools to use a consolidated capture pipeline:

- **High-signal tools** (click, type, key_press, select_option, set_checked, navigate, click_ref, fill_ref): Call `captureCompactPageState(includeBodyText: true)` once for afterState. Summary derived via `formatCompactStateSummary(afterState)`. Dialog count read from `beforeState.dialog.count` / `afterState.dialog.count`.

- **Low-signal tools** (drag, scroll, hover, upload_file, hover_ref): Call `captureCompactPageState(includeBodyText: false)` once. Summary derived via `formatCompactStateSummary(afterState)`.

Removed `countOpenDialogs` from `ToolDeps` interface and `index.ts` wiring. The function remains in `utils.ts` for any future direct usage but is no longer part of the tool dependency contract.

`postActionSummary` remains in ToolDeps for summary-only navigation tools (go_back, go_forward, reload) that don't perform before/after diffing.

## Verification

- `npm run build` exits 0
- `grep -c "countOpenDialogs" src/resources/extensions/browser-tools/tools/*.ts` returns 0 for all 9 tool files
- `grep -c "postActionSummary" src/resources/extensions/browser-tools/tools/interaction.ts` returns 0
- `grep "includeBodyText: false" src/resources/extensions/browser-tools/tools/interaction.ts` shows 4 low-signal tools
- `grep "includeBodyText: true" src/resources/extensions/browser-tools/tools/interaction.ts` shows 5 high-signal tools

Slice-level checks:
- ✅ `npm run build` succeeds
- ✅ `countOpenDialogs` returns 0 in all tool files
- ✅ `postActionSummary` returns 0 in interaction.ts
- ⬜ `zero_mutation_shortcut` in settle.ts — T02
- ✅ `includeBodyText` shows explicit true/false per tool signal level

## Diagnostics

None — this is a structural refactor. The capture pipeline behavior is observable through the same tool output format as before (summary text, diff, verification checks).

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/interaction.ts` — All 10 tools refactored: 5 high-signal use captureCompactPageState(includeBodyText: true) + formatCompactStateSummary, 4 low-signal use captureCompactPageState(includeBodyText: false) + formatCompactStateSummary, 1 (set_viewport) unchanged
- `src/resources/extensions/browser-tools/tools/navigation.ts` — browser_navigate uses afterState for summary via formatCompactStateSummary instead of postActionSummary
- `src/resources/extensions/browser-tools/tools/refs.ts` — click_ref (high-signal), fill_ref (high-signal), hover_ref (low-signal) all use consolidated capture; countOpenDialogs removed from click_ref
- `src/resources/extensions/browser-tools/state.ts` — countOpenDialogs removed from ToolDeps interface
- `src/resources/extensions/browser-tools/index.ts` — countOpenDialogs removed from ToolDeps wiring
