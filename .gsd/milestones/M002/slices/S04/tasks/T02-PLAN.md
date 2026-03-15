---
estimated_steps: 5
estimated_files: 2
---

# T02: Implement browser_fill_form and verify both tools against a real form

**Slice:** S04 — Form Intelligence
**Milestone:** M002

## Description

Add `browser_fill_form` to `tools/forms.ts` and verify both form tools end-to-end against a served multi-field HTML test form. The fill tool takes a values mapping, resolves fields by label/name/placeholder/aria-label, fills using Playwright APIs, and returns a detailed result with matched/unmatched/skipped fields and post-fill validation state. End-to-end verification retires the key risk: label association works on real HTML forms.

## Steps

1. Implement `browser_fill_form` in `tools/forms.ts`. Schema: `selector` (optional form selector), `values` (Record<string, string> — keys are field identifiers, values are field values), `submit` (optional boolean). Follow interaction.ts patterns for tracked actions and error handling.

2. Implement the field matching and filling logic:
   - For each key in the values mapping, resolve the target field in priority order:
     1. Exact label match via Playwright `getByLabel(key, { exact: true })` scoped to the form
     2. Case-insensitive label match via `getByLabel(key)` scoped to form
     3. `locator('[name="key"]')` scoped to form
     4. `locator('[placeholder="key" i]')` scoped to form
     5. `locator('[aria-label="key" i]')` scoped to form
   - If multiple matches found for a key, report ambiguity — don't fill
   - If no match found, add to unmatched list
   - For matched fields: use `locator.fill()` for text/email/password/url/tel/search/number inputs and textareas, `locator.selectOption()` for selects, `locator.setChecked(value === 'true' || value === 'on')` for checkboxes/radios
   - Skip file inputs and hidden inputs — add to skipped list with reason
   - Catch Playwright errors per-field (e.g. `fill()` on non-fillable) and add to skipped with error message

3. After all fills: run `settleAfterActionAdaptive()`, then collect post-fill validation state via `page.evaluate()` on the form fields. If `submit` flag is set, find and click the form's submit button (first `[type=submit]` or first `<button>` in form). Return structured result: `{ matched: [...], unmatched: [...], skipped: [...], submitted: boolean, validationSummary: {...} }`.

4. Create a test HTML file with diverse field types: text inputs with labels (for, wrapping, aria-label), selects, checkboxes, radios, textareas, fieldsets, required fields, hidden inputs, a file input, a submit button. Serve it via a local HTTP server.

5. Verify end-to-end: navigate to the test form, run `browser_analyze_form` and verify the field inventory matches expected structure (correct labels, types, required flags). Run `browser_fill_form` with a values mapping and verify fields are filled (check via `page.evaluate` reading field values), unmatched keys are reported, and file/hidden inputs are skipped.

## Must-Haves

- [ ] `browser_fill_form` registered with `selector`, `values`, and `submit` parameters
- [ ] Matching resolves fields by label → name → placeholder → aria-label, exact first then case-insensitive
- [ ] Uses Playwright `fill()` for text-like inputs, `selectOption()` for selects, `setChecked()` for checkboxes/radios
- [ ] Ambiguous matches reported, not guessed
- [ ] File inputs and hidden inputs skipped with reason
- [ ] Per-field errors caught and reported (not tool-level crash)
- [ ] Post-fill validation state collected
- [ ] Optional submit clicks the submit button
- [ ] Settle after fills
- [ ] Both tools verified against a real multi-field HTML form
- [ ] Build passes, tool count is 45

## Verification

- `cd pkg && npm run build` completes without errors
- jiti script loads extension, counts registered tools — expect 45
- Serve test HTML form, navigate browser, run `browser_analyze_form`:
  - Returns fields with correct labels resolved from various association methods
  - Hidden fields flagged
  - Select options listed
  - Submit buttons detected
- Run `browser_fill_form` with values mapping:
  - Text fields filled (verified by reading values back)
  - Select option changed
  - Checkbox checked
  - File input skipped
  - Hidden input skipped
  - Unmatched keys reported
  - Validation state returned

## Inputs

- `src/resources/extensions/browser-tools/tools/forms.ts` — T01's output with `browser_analyze_form` implemented
- `src/resources/extensions/browser-tools/tools/interaction.ts` — pattern reference for settle, tracked actions

## Expected Output

- `src/resources/extensions/browser-tools/tools/forms.ts` — updated with `browser_fill_form` implementation
- End-to-end verification passing: both tools work against a real multi-field form with diverse field types and label association patterns
