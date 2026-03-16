# S02: Action pipeline performance — Research

**Date:** 2026-03-12

## Summary

The action pipeline's per-tool overhead comes from three sources: redundant evaluate calls in the capture path, unconditional body text capture, and a settle loop that doesn't short-circuit on zero mutations. All three are addressable without changing tool APIs or response formats.

The biggest win is consolidating `postActionSummary` + afterState `captureCompactPageState` into a single evaluate call. Currently every high-signal action tool (click, type, navigate, key_press, select_option, set_checked) runs both — `postActionSummary` internally calls `captureCompactPageState` without body text, then the tool calls it again with `includeBodyText: true`. That's 2 evaluates for the same data. One evaluate that always includes body text, with the summary derived from the resulting state object via `formatCompactStateSummary`, eliminates a round-trip per action.

Secondary consolidation targets: `countOpenDialogs` and `captureClickTargetState` are separate evaluates per action that could be folded into a single combined evaluate or merged into captureCompactPageState. Each saves one evaluate round-trip.

The settle zero-mutation short-circuit is straightforward: after 60ms with no mutation counter increment, reduce the quiet window to ~30ms. The current behavior runs the full 100ms quiet window regardless.

## Recommendation

Structure this as three tasks matching the three requirements:

**T01 — Consolidate postActionSummary + afterState capture** (R017): Change `postActionSummary` to accept an optional pre-captured state, or better — replace the `postActionSummary` + separate `captureCompactPageState` pattern in tools with a single `captureCompactPageState(includeBodyText: true)` call followed by `formatCompactStateSummary`. This is a mechanical refactor across all tool files. Additionally, fold `countOpenDialogs` into `captureCompactPageState`'s evaluate callback to eliminate another round-trip for tools that check dialogs.

**T02 — Settle zero-mutation short-circuit** (R019): In `settleAfterActionAdaptive`, track whether any mutation has fired since start. If after 60ms the mutation counter hasn't incremented from its initial value, use a smaller quiet window (30ms instead of 100ms). Return a new `settleReason` like `"zero_mutation_shortcut"` for observability.

**T03 — Conditional body text capture** (R018): Classify each tool as high-signal or low-signal. High-signal tools (navigate, click, type, key_press, select_option, set_checked, click_ref, fill_ref) capture body text. Low-signal tools (scroll, hover, drag, upload_file, hover_ref) skip body text. This is mostly about the `postActionSummary` callers — but after T01 consolidation, those tools won't call captureCompactPageState at all for afterState/diff. The classification needs to be passed through the capture call or set at the tool level.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| State formatting | `formatCompactStateSummary()` in utils.ts | Already extracts the summary text from CompactPageState without bodyText — use it directly instead of going through postActionSummary |
| State diffing | `diffCompactStates()` in core.js | Already handles bodyText presence/absence gracefully (truncates to 120 chars, compares as empty string when missing) |
| Settle observability | `AdaptiveSettleDetails` interface | Already has `settleReason` field — add `"zero_mutation_shortcut"` as a new value |
| Pending request tracking | `getPendingCriticalRequests()` in utils.ts (reads WeakMap) | Already Node-side, zero evaluate cost — no change needed |

## Existing Code and Patterns

- `capture.ts` — `captureCompactPageState` runs one evaluate that captures URL, title, focus, headings, body text (conditional), element counts, dialog state, and selector states. This is the right data shape; the issue is it's called twice per action.
- `capture.ts` — `postActionSummary` is a 5-line wrapper: calls `captureCompactPageState(p, { target })` then `formatCompactStateSummary()`. After consolidation, tools can call `captureCompactPageState` once and derive the summary themselves.
- `settle.ts` — `settleAfterActionAdaptive` polls every 40ms. Each poll does `readMutationCounter` (1 evaluate) and optionally `readFocusedDescriptor` (1 evaluate). These could be combined into one evaluate per poll.
- `utils.ts` — `countOpenDialogs` is a single `target.evaluate()` that counts `[role="dialog"]:not([hidden]),dialog[open]`. The same selector is already used inside `captureCompactPageState`'s evaluate at `dialog.count`.
- `utils.ts` — `captureClickTargetState` checks aria-expanded/pressed/selected/open on a selector target. This is a separate evaluate that's harder to fold in (needs the target selector).
- `state.ts` — `ToolDeps` interface defines the contract. Changes to `postActionSummary` signature need ToolDeps updates. Adding an `includeBodyText` parameter or removing `postActionSummary` entirely affects the interface.
- `tools/interaction.ts` — 10 interaction tools. Pattern: click/type/key_press do full before+after+diff. scroll/hover/drag/upload do summary-only.
- `tools/navigation.ts` — 4 tools. browser_navigate does full before+after+diff. go_back/go_forward/reload do summary-only.
- `tools/refs.ts` — 3 action tools (click_ref, hover_ref, fill_ref). click_ref does dialog+target checks but no before/after body text diff. hover_ref does summary-only. fill_ref does summary-only.
- `core.js` — `diffCompactStates` uses bodyText for diff when present (compares, truncates to 120 chars). When both before and after bodyText are empty strings, no diff is generated for that field.

## Constraints

- **ToolDeps is the API contract.** All 9 tool files import from it. If `postActionSummary` is removed or its signature changes, ToolDeps must be updated and all call sites migrated.
- **`captureCompactPageState` always captures dialog info already.** The `dialog.count` field inside captureCompactPageState already queries the same selector as `countOpenDialogs()`. This is duplicated work for tools that call both.
- **Settle evaluate calls are per-poll, not per-action.** Combining `readMutationCounter` + `readFocusedDescriptor` into one evaluate saves 1 call per poll iteration (typically 2-4 polls), not per action.
- **`captureClickTargetState` is selector-specific.** It checks ARIA attributes on a specific element. This can't be folded into the generic `captureCompactPageState` evaluate without making that evaluate selector-aware for ARIA state (which it partly is via selectorStates, but selectorStates captures different attributes).
- **Low-signal tools that don't do before/after/diff today** (scroll, hover, drag) call `postActionSummary` which already skips body text. R018's main impact is ensuring the classification is explicit and that future tools follow the pattern.
- **The `formatCompactStateSummary` function doesn't reference bodyText.** So calling captureCompactPageState with `includeBodyText: true` and then `formatCompactStateSummary` on the result is safe — the summary ignores body text regardless.

## Common Pitfalls

- **Removing postActionSummary entirely vs deprecating.** Some tools (go_back, go_forward, reload, hover, scroll, drag) only need the summary — they don't do before/after diff. Removing postActionSummary forces these tools to call captureCompactPageState + formatCompactStateSummary themselves. This is fine but means every tool file changes. Alternatively, keep postActionSummary as a thin wrapper but also offer a combined path for diff tools.
- **Settle short-circuit false positives.** Zero mutations after 60ms could be because the page hasn't started processing yet (e.g., async operation with initial delay). The short-circuit should still wait the reduced quiet window (30ms) rather than returning immediately. This is already handled by the proposed design.
- **captureClickTargetState temptation.** It's tempting to fold this into captureCompactPageState, but it serves a different purpose (verifying click had an effect on ARIA state). Keeping it separate is cleaner. The optimization is to combine it with countOpenDialogs into a single pre-click and post-click evaluate.
- **Breaking the diff when body text is conditionally absent.** If low-signal tools skip body text but still compute diffs, the diff will show no body_text change (empty vs empty). This is fine — these tools don't do diffs today anyway. But if a future change adds diffs to hover/scroll, the lack of body text will be visible.
- **Settle poll combining must handle checkFocus=false.** When focus checking is disabled, readFocusedDescriptor isn't called. The combined evaluate must return a sentinel for focus when not requested, or the caller must know not to compare it.

## Open Risks

- **Evaluate round-trip latency varies by page complexity.** The consolidation saves a fixed number of round-trips, but each round-trip's actual cost depends on page complexity and Playwright's CDP overhead. Savings may be 20-50ms per action in practice, not the theoretical maximum.
- **Settle zero-mutation threshold (60ms) is empirical.** Some pages fire mutations after >60ms (e.g., after a network request completes). The threshold may need tuning. Including it in `AdaptiveSettleOptions` as configurable would de-risk this.
- **Combining readMutationCounter + readFocusedDescriptor changes the settle timing subtly.** Currently they're sequential evaluates; combining them means the focus check happens at the exact same instant as the mutation check. This is actually more correct (atomic snapshot) but could theoretically change settle behavior on edge cases.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | github/awesome-copilot@playwright-generate-test (7.4K installs) | available — not relevant (for writing tests from scratch, not optimizing internal Playwright wrappers) |

No skills are relevant to this internal performance optimization work.

## Sources

- `src/resources/extensions/browser-tools/capture.ts` — captureCompactPageState and postActionSummary implementations
- `src/resources/extensions/browser-tools/settle.ts` — settleAfterActionAdaptive implementation with polling loop
- `src/resources/extensions/browser-tools/tools/interaction.ts` — 10 interaction tools showing the before/settle/summary/after/diff pattern
- `src/resources/extensions/browser-tools/tools/navigation.ts` — 4 navigation tools, browser_navigate does full capture, others summary-only
- `src/resources/extensions/browser-tools/tools/refs.ts` — 3 ref action tools showing lighter capture patterns
- `src/resources/extensions/browser-tools/utils.ts` — formatCompactStateSummary, countOpenDialogs, captureClickTargetState
- `src/resources/extensions/browser-tools/state.ts` — ToolDeps interface, CompactPageState shape
- `src/resources/extensions/browser-tools/core.js` — diffCompactStates (uses bodyText when present)

## Appendix: Evaluate Call Audit

### browser_click (current — high-signal tool with diff)
| Phase | Function | Evaluates |
|-------|----------|-----------|
| Before | captureCompactPageState (body text) | 1 |
| Before | captureClickTargetState | 1 |
| Before | countOpenDialogs | 1 |
| Action | locator.click | (Playwright internal) |
| Settle | ensureMutationCounter | 1 |
| Settle | readMutationCounter × N polls | N |
| After | countOpenDialogs | 1 |
| After | captureClickTargetState | 1 |
| After | postActionSummary → captureCompactPageState | 1 |
| After | captureCompactPageState (body text) | 1 |
| **Total** | | **8 + N** |

### After consolidation (proposed)
| Phase | Function | Evaluates |
|-------|----------|-----------|
| Before | captureCompactPageState (body text + dialog count included) | 1 |
| Before | captureClickTargetState | 1 |
| Action | locator.click | (Playwright internal) |
| Settle | ensureMutationCounter + readMutationCounter initial | 1 |
| Settle | readMutationCounter × N polls | N |
| After | captureCompactPageState (body text + dialog count) | 1 |
| After | captureClickTargetState | 1 |
| **Total** | | **5 + N** |

**Savings per action: 3 evaluate round-trips** (countOpenDialogs ×2 folded into captureCompactPageState, postActionSummary eliminated in favor of formatCompactStateSummary on the afterState).

### browser_scroll (current — low-signal tool)
| Phase | Function | Evaluates |
|-------|----------|-----------|
| Settle | ensureMutationCounter | 1 |
| Settle | readMutationCounter × N polls | N |
| After | scrollInfo evaluate | 1 |
| After | postActionSummary → captureCompactPageState | 1 |
| **Total** | | **3 + N** |

### After consolidation (proposed)
| Phase | Function | Evaluates |
|-------|----------|-----------|
| Settle | ensureMutationCounter + readMutationCounter initial | 1 |
| Settle | readMutationCounter × N polls | N |
| After | scrollInfo evaluate | 1 |
| After | captureCompactPageState (no body text) | 1 |
| **Total** | | **3 + N** |

Scroll savings are minimal (postActionSummary already skips body text). The main scroll improvement comes from settle short-circuiting (R019), saving ~1-2 poll iterations (~40-80ms).

### Settle with zero-mutation short-circuit (proposed)
| Scenario | Current | Proposed |
|----------|---------|----------|
| Zero mutations | ~140ms (3 polls × 40ms + 100ms quiet) | ~90ms (2 polls × 40ms + 30ms quiet after 60ms zero-mut check) |
| Active mutations | ~200-500ms (normal adaptive) | ~200-500ms (unchanged) |
| **Saving on zero-mutation** | | **~50ms** |
