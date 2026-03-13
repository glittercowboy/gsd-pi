---
estimated_steps: 5
estimated_files: 7
---

# T01: Consolidate capture pipeline and classify tool signal levels

**Slice:** S02 — Action pipeline performance
**Milestone:** M002

## Description

Eliminate redundant evaluate round-trips per action by consolidating the capture pipeline. Currently high-signal tools call `postActionSummary` (which internally calls `captureCompactPageState` without body text) and then call `captureCompactPageState` again with `includeBodyText: true` — two evaluate calls for overlapping data. Additionally, tools call `countOpenDialogs` separately even though `captureCompactPageState` already captures `dialog.count`.

After this task: high-signal tools (click, type, key_press, select_option, set_checked, navigate) call `captureCompactPageState(includeBodyText: true)` once for afterState, derive the summary via `formatCompactStateSummary`, and read `dialog.count` from the captured state. Low-signal tools (scroll, hover, drag, upload_file) call `captureCompactPageState(includeBodyText: false)` and derive summary. Net saving: 3 evaluate round-trips per high-signal action.

## Steps

1. **Update ToolDeps in state.ts**: Remove `countOpenDialogs` from ToolDeps. `postActionSummary` stays in ToolDeps for now since summary-only tools (go_back, go_forward, reload) still use it — but action tools won't call it.

2. **Refactor high-signal tools in interaction.ts**: For `browser_click`, `browser_type`, `browser_key_press`, `browser_select_option`, `browser_set_checked`:
   - Remove the `postActionSummary` call
   - Remove standalone `countOpenDialogs` calls — use `beforeState.dialog.count` and `afterState.dialog.count` instead
   - After settle, call `captureCompactPageState(p, { ..., includeBodyText: true })` once for afterState
   - Derive summary text via `deps.formatCompactStateSummary(afterState)`
   - The beforeState capture already has `dialog.count` — use it directly for dialog comparison

3. **Refactor browser_navigate in navigation.ts**: Same pattern — remove `postActionSummary`, use afterState (already captured) for summary via `formatCompactStateSummary`, use `dialog.count` from state.

4. **Refactor ref action tools in refs.ts**: For `browser_click_ref` — remove `countOpenDialogs` calls, use state's `dialog.count`. For `browser_click_ref`, `browser_hover_ref`, `browser_fill_ref` — replace `postActionSummary` with `captureCompactPageState` + `formatCompactStateSummary`. Mark ref action tools with explicit body text classification: `browser_click_ref` and `browser_fill_ref` get `includeBodyText: true` (high-signal), `browser_hover_ref` gets `includeBodyText: false` (low-signal).

5. **Classify low-signal tools in interaction.ts**: For `browser_scroll`, `browser_hover`, `browser_drag`, `browser_upload_file` — replace `postActionSummary` with `captureCompactPageState(includeBodyText: false)` + `formatCompactStateSummary`. This makes the signal classification explicit in code.

## Must-Haves

- [ ] No standalone `countOpenDialogs` calls in any tool file under `tools/`
- [ ] High-signal tools call `captureCompactPageState` with `includeBodyText: true` for afterState and derive summary via `formatCompactStateSummary`
- [ ] Low-signal tools call `captureCompactPageState` with `includeBodyText: false` and derive summary via `formatCompactStateSummary`
- [ ] `postActionSummary` remains available in ToolDeps for summary-only navigation tools (go_back, go_forward, reload) — these don't do before/after diff
- [ ] `countOpenDialogs` removed from ToolDeps interface and index.ts wiring
- [ ] `npm run build` succeeds

## Verification

- `npm run build` exits 0
- `grep -c "countOpenDialogs" src/resources/extensions/browser-tools/tools/*.ts` returns 0 for every file
- `grep -c "postActionSummary" src/resources/extensions/browser-tools/tools/interaction.ts` returns 0
- `grep "includeBodyText: false" src/resources/extensions/browser-tools/tools/interaction.ts` shows low-signal tools explicitly skipping body text
- `grep "includeBodyText: true" src/resources/extensions/browser-tools/tools/interaction.ts` shows high-signal tools explicitly including body text

## Inputs

- `src/resources/extensions/browser-tools/capture.ts` — `captureCompactPageState` and `postActionSummary` implementations
- `src/resources/extensions/browser-tools/state.ts` — ToolDeps interface, CompactPageState shape (includes `dialog.count`)
- `src/resources/extensions/browser-tools/utils.ts` — `formatCompactStateSummary`, `countOpenDialogs`
- `src/resources/extensions/browser-tools/tools/interaction.ts` — 10 interaction tools with current capture patterns
- `src/resources/extensions/browser-tools/tools/navigation.ts` — browser_navigate with postActionSummary + separate afterState capture
- `src/resources/extensions/browser-tools/tools/refs.ts` — click_ref/hover_ref/fill_ref with countOpenDialogs and postActionSummary
- S01 summary — module structure, ToolDeps contract, accessor patterns

## Expected Output

- `src/resources/extensions/browser-tools/state.ts` — ToolDeps without `countOpenDialogs`
- `src/resources/extensions/browser-tools/index.ts` — wiring without `countOpenDialogs`
- `src/resources/extensions/browser-tools/tools/interaction.ts` — all 10 tools using consolidated capture with explicit signal classification
- `src/resources/extensions/browser-tools/tools/navigation.ts` — browser_navigate using consolidated capture
- `src/resources/extensions/browser-tools/tools/refs.ts` — ref action tools using consolidated capture with signal classification
