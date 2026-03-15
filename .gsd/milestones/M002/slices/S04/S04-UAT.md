# S04: Form Intelligence — UAT

**Milestone:** M002
**Written:** 2026-03-12

## UAT Type

- UAT mode: live-runtime
- Why this mode is sufficient: Form tools require a running browser and real HTML forms to verify label resolution, field filling, and validation collection. Automated Playwright verification against a test form covers the critical paths.

## Preconditions

- `npm run build` passes in the project root
- A local HTTP server serving a multi-field HTML form (or any web page with a form)

## Smoke Test

Run `browser_analyze_form` on any page with a form — it should return a structured field inventory without errors.

## Test Cases

### 1. Analyze a multi-field form

1. Navigate to a page with a form containing text inputs, selects, checkboxes, and a submit button
2. Call `browser_analyze_form` with no selector
3. **Expected:** Returns field inventory with correct labels, types, values, and validation state. Submit buttons listed. Hidden fields flagged.

### 2. Analyze with explicit selector

1. Navigate to a page with multiple forms
2. Call `browser_analyze_form` with `selector: "form#login"`
3. **Expected:** Returns only fields from the targeted form, not other forms on the page.

### 3. Fill form by label

1. Navigate to a page with a registration-style form
2. Call `browser_fill_form` with values like `{ "Email": "test@example.com", "Password": "secret123" }`
3. **Expected:** Fields matched by label, values filled, resolvedBy shows "label" or "label (exact)", validation state returned.

### 4. Fill with mixed resolution strategies

1. Navigate to a form with fields using different labeling strategies (label[for], aria-label, placeholder, name)
2. Call `browser_fill_form` with keys matching each strategy
3. **Expected:** Each field matched, resolvedBy shows the correct strategy (label, name, placeholder, aria-label).

### 5. Fill and submit

1. Navigate to a form page
2. Call `browser_fill_form` with valid values and `submit: true`
3. **Expected:** Fields filled, submit button clicked, response indicates submitted: true.

### 6. Unmatched keys reported

1. Call `browser_fill_form` with a key that doesn't match any field (e.g. `{ "Nonexistent Field": "value" }`)
2. **Expected:** Key appears in unmatched array with reason "No matching field found".

## Edge Cases

### File input skip

1. Navigate to a form with a file input labeled "Resume"
2. Call `browser_fill_form` with `{ "Resume": "file.pdf" }`
3. **Expected:** Field appears in skipped array with reason "File input — use browser_upload_file instead".

### Ambiguous label match

1. Navigate to a form with two fields having the same label text
2. Call `browser_fill_form` with a key matching that label
3. **Expected:** Field appears in skipped array with reason indicating ambiguity and count of matches.

### No forms on page

1. Navigate to a page with no `<form>` elements
2. Call `browser_analyze_form`
3. **Expected:** Falls back to document.body, inventories any loose inputs on the page.

## Failure Signals

- `browser_analyze_form` returns error or empty field list on a page with a visible form
- `browser_fill_form` reports fields as unmatched that should be matchable by label
- Filled values don't persist (visible in the form after fill)
- Validation state not collected after fill
- Build fails with new tool files

## Requirements Proved By This UAT

- R022 — browser_analyze_form returns correct field inventory with label resolution
- R023 — browser_fill_form maps values by label/name/placeholder/aria-label and reports results

## Not Proven By This UAT

- Performance characteristics (latency of form tools vs. manual multi-call approach) — deferred, not a requirement
- Custom dropdown component handling — explicitly out of scope
- Unit test coverage of label heuristics — S06 scope (R026)

## Notes for Tester

- The auto-detect logic picks the form with the most visible inputs when multiple forms exist. If the wrong form is selected, use the `selector` parameter explicitly.
- `title` attribute works for label resolution in `analyze_form` but is not used as a matching key in `fill_form` — this is intentional per D022.
