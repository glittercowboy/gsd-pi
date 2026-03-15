---
id: S04
parent: M002
milestone: M002
provides:
  - browser_analyze_form tool with 7-level label resolution, form auto-detection, validation state, and submit button discovery
  - browser_fill_form tool with 5-level field resolution, type-aware filling, skip logic, optional submit, and post-fill validation
requires:
  - slice: S01
    provides: module structure (state.ts ToolDeps, lifecycle.ts ensureBrowser/getActiveTarget, capture.ts captureCompactPageState/captureErrorScreenshot, settle.ts settleAfterActionAdaptive, utils.ts beginTrackedAction/finishTrackedAction)
affects:
  - S05
  - S06
key_files:
  - src/resources/extensions/browser-tools/tools/forms.ts
  - src/resources/extensions/browser-tools/index.ts
key_decisions:
  - "D020: Form analysis evaluate logic lives in tools/forms.ts, not extracted to evaluate-helpers.ts — form-specific, not shared"
  - "D021: browser_fill_form uses Playwright locator APIs (fill/selectOption/setChecked) not page.evaluate value setting — proper event dispatch for framework reactivity"
  - "D022: Fill field matching priority: label (exact → case-insensitive) → name → placeholder → aria-label"
patterns_established:
  - Form evaluate scripts built as string templates via helper functions (buildFormAnalysisScript, buildPostFillValidationScript) to avoid closure serialization issues with Playwright
  - Per-field error isolation in fill_form — try/catch around each fill operation prevents one bad field from crashing the whole tool
  - Structured result objects (formAnalysis, fillResult) in tool details for programmatic consumption
observability_surfaces:
  - browser_analyze_form returns structured formAnalysis in details with full field inventory
  - browser_fill_form returns structured fillResult in details with matched/unmatched/skipped arrays and resolvedBy per match
  - Error paths include captureErrorScreenshot and finishTrackedAction with error status
drill_down_paths:
  - .gsd/milestones/M002/slices/S04/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S04/tasks/T02-SUMMARY.md
duration: 33m
verification_result: passed
completed_at: 2026-03-12
---

# S04: Form Intelligence

**Two new browser tools — `browser_analyze_form` and `browser_fill_form` — that collapse multi-call form workflows into single tool calls, with 7-level label resolution, type-aware filling, and structured result reporting.**

## What Happened

Created `tools/forms.ts` with `registerFormTools()` exporting both tools, wired into `index.ts` via import + call.

**browser_analyze_form** runs a single `page.evaluate()` that: auto-detects the target form (single form → use it, multiple → most visible inputs, none → body), inventories all `input`/`select`/`textarea` fields excluding submit/button/reset/image, resolves labels through a 7-level priority chain (aria-labelledby → aria-label → label[for] → wrapping label → placeholder → title → humanized name), extracts per-field type/name/id/required/value/checked/options/validation/hidden/disabled/group, and finds submit buttons.

**browser_fill_form** resolves each key in the values mapping through 5 strategies: getByLabel exact → getByLabel loose → name attr → placeholder attr → aria-label attr. Fills by type using Playwright APIs: `fill()` for text-like inputs, `selectOption()` for selects (label first, then value), `setChecked()` for checkboxes/radios. Skips file inputs (with "use browser_upload_file" guidance) and hidden inputs. Reports ambiguity rather than guessing. Settles after all fills. Optional submit via clicking the form's submit button. Collects post-fill validation state via a second evaluate.

Both tools follow the established tracked-action pattern with before/after state capture and error screenshot on failure.

## Verification

- ✅ `npm run build` — passes clean, zero errors
- ✅ Tool count = 45 (43 existing + browser_analyze_form + browser_fill_form) via `grep -c registerTool`
- ✅ `registerFormTools` wired in index.ts (import line 18 + call line 48)
- ✅ browser_analyze_form verified against 12-field test HTML form — all fields inventoried with correct labels from diverse association methods (for, wrapping, aria-label, aria-labelledby, placeholder, title, name), hidden field flagged, submit buttons detected
- ✅ browser_fill_form verified against same form — 10 fields filled correctly via label/name/placeholder/aria-label resolution, file input skipped, nonexistent key reported as unmatched, all filled values confirmed via read-back assertions

## Requirements Advanced

- R022 — browser_analyze_form fully implemented with label resolution, form auto-detection, validation state, fieldset grouping, and submit button discovery
- R023 — browser_fill_form fully implemented with multi-strategy field resolution, type-aware filling, skip logic, optional submit, and structured result reporting

## Requirements Validated

- R022 — Verified end-to-end against a real multi-field HTML form with 7 different label association methods; all fields correctly inventoried
- R023 — Verified end-to-end: 10 fields filled correctly, file input skipped with reason, nonexistent key reported as unmatched, post-fill validation collected

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

- Task plan referenced `pkg/` prefix on source paths — actual paths have no prefix. No impact.
- Verification used grep-based tool count and Playwright script rather than jiti loader — jiti can't load the extension from source due to core.js being plain JS.

## Known Limitations

- Label resolution is form-specific (in forms.ts), not shared via window.__pi. If S05 intent tools need label resolution, D020 may need revisiting.
- `title` attribute not included in fill resolution chain — analyze reports it for display, but fill matches only label/name/placeholder/aria-label per D022.
- Custom dropdown components (non-`<select>`) are not supported — they don't use standard form semantics.

## Follow-ups

- S05 may reuse form analysis evaluate logic for "submit form" intent — the boundary map anticipates this.
- S06 will add unit tests for label resolution heuristics and field matching logic.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/forms.ts` — new file with registerFormTools(), browser_analyze_form, browser_fill_form, buildFormAnalysisScript(), buildPostFillValidationScript()
- `src/resources/extensions/browser-tools/index.ts` — added import and registration call for form tools

## Forward Intelligence

### What the next slice should know
- Form tools use `page.evaluate()` with string templates, not serialized functions — this is the pattern that works with Playwright's serialization model.
- The form analysis evaluate script is ~200 lines of self-contained browser-side code. If S05 needs to find submit buttons for "submit form" intent, it can either call `browser_analyze_form` internally or extract the submit detection logic.

### What's fragile
- The `CSS.escape()` call in the fill tool's `[name="${CSS.escape(key)}"]` selector — `CSS.escape` is well-supported in modern browsers but would fail in very old targets. Not a concern for current Playwright usage.
- Label resolution priority chain is hardcoded — changing the order requires editing the evaluate string template, not a config.

### Authoritative diagnostics
- `grep -rc registerTool src/resources/extensions/browser-tools/tools/` — 45 total confirms all tools registered
- Both tools return structured objects in `details` (formAnalysis / fillResult) — programmatic consumers should use those, not parse the text output.

### What assumptions changed
- Original plan assumed jiti could verify tool count — it can't due to core.js being plain JS. grep-based verification is equally reliable and simpler.
