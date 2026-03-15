---
id: T02
parent: S04
milestone: M002
provides:
  - browser_fill_form tool with multi-strategy field resolution and type-aware filling
key_files:
  - src/resources/extensions/browser-tools/tools/forms.ts
key_decisions:
  - Field resolution uses Playwright getByLabel() for label matching rather than DOM queries, giving consistent behavior with Playwright's own label semantics
  - title attribute not included in fill resolution chain (label → name → placeholder → aria-label only) — analyze_form reports it but fill_form matches what agents actually use as keys
  - Per-field error isolation via try/catch around each fill operation — one bad field doesn't crash the whole tool
patterns_established:
  - Fill tool returns structured { matched, unmatched, skipped, submitted, validationSummary } for programmatic consumption
  - Form auto-detection logic shared between analyze and fill via same evaluate pattern
observability_surfaces:
  - Tool returns structured fillResult object in details with per-field match/skip/unmatch info
  - Each matched field includes resolvedBy indicating which strategy matched (label, name, placeholder, aria-label)
  - Error path includes captureErrorScreenshot and finishTrackedAction with error status
duration: 18m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Implement browser_fill_form and verify both tools against a real form

**Added `browser_fill_form` tool with 5-level field resolution, type-aware filling (text/select/checkbox), skip logic for file/hidden inputs, optional submit, and post-fill validation collection. Both form tools verified end-to-end against a multi-field HTML form.**

## What Happened

Implemented `browser_fill_form` in `tools/forms.ts` following the same tracked-action pattern as `browser_analyze_form`. The tool:

1. **Auto-detects the form** using the same logic as analyze_form (single form → use it, multiple → most visible inputs, none → body)
2. **Resolves each key** in priority order: getByLabel exact → getByLabel loose → name attr → placeholder attr → aria-label attr
3. **Fills by type**: `fill()` for text-like inputs and textareas, `selectOption()` for selects (label first, then value), `setChecked()` for checkboxes/radios
4. **Skips** file inputs (with reason "use browser_upload_file") and hidden inputs
5. **Reports ambiguity** when multiple fields match a key — doesn't guess
6. **Catches per-field errors** individually — one failure doesn't crash the tool
7. **Settles** after all fills via `settleAfterActionAdaptive()`
8. **Submits** optionally by clicking `[type=submit]` or `<button>` without explicit type
9. **Collects post-fill validation** state via `page.evaluate()` on all visible form fields

Also added `buildPostFillValidationScript()` helper for the validation collection evaluate callback.

## Verification

- `npm run build` — passes clean, no errors
- Tool count: 45 (44 + browser_fill_form) confirmed via `grep -c registerTool`
- **Playwright verification script** exercised both tools against a served HTML form with 12 fields:
  - analyze_form: all 12 fields inventoried with correct labels from various association methods (for, wrapping, aria-label, aria-labelledby, placeholder, title, name)
  - Hidden field (csrf_token) flagged as hidden
  - Fill matched 10 fields correctly: text via label[for], email via wrapping label, password via aria-label, tel via placeholder, select via label, textarea via label, 2 checkboxes via labels, text via aria-labelledby, url via name attribute
  - File input skipped with "file input" reason
  - Nonexistent key reported as unmatched
  - All filled values verified via read-back (inputValue/isChecked assertions)
- **Browser verification**: navigated to form, filled fields, clicked submit — form data JSON displayed correctly

**Slice-level verification status (final task — all must pass):**
1. ✅ `npm run build` passes
2. ✅ Tool count = 45
3. ✅ browser_analyze_form returns correct field inventory from real HTML form
4. ✅ browser_fill_form fills fields correctly, skips file/hidden, reports unmatched

## Diagnostics

- Tool returns structured `fillResult` object in `details` with matched/unmatched/skipped arrays
- Each matched entry includes `resolvedBy` field showing which resolution strategy succeeded
- Error states tracked via `finishTrackedAction` with error message
- Error screenshots captured on exceptions for agent debugging

## Deviations

- `title` attribute not included in fill resolution chain — the task plan lists "label → name → placeholder → aria-label" which doesn't include title. The analyze tool reports it for display, but fill resolution correctly follows the plan's 5-strategy chain.
- Verification used a Playwright script rather than a jiti-based extension loader (jiti can't load the extension from source due to core.js being plain JS, same as T01).

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/forms.ts` — added `browser_fill_form` tool and `buildPostFillValidationScript()` helper
