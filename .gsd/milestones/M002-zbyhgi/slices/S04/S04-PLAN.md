# S04: Form Intelligence

**Goal:** Two new browser tools — `browser_analyze_form` and `browser_fill_form` — that collapse multi-call form workflows into single tool calls.
**Demo:** Run `browser_analyze_form` against a multi-field HTML form and get a complete field inventory. Run `browser_fill_form` with a values mapping and see fields filled correctly with validation feedback.

## Must-Haves

- `browser_analyze_form` returns field inventory: labels, names, types, required, values, validation state, submit buttons
- Label resolution handles: `aria-labelledby`, `aria-label`, `<label for>`, wrapping `<label>`, `placeholder`, `title`, inferred from `name`
- `browser_fill_form` maps values by label, name, placeholder, aria-label — exact match first, then substring
- Fill uses Playwright APIs (`fill()`, `selectOption()`, `setChecked()`) not `page.evaluate()` value setting
- Fill reports: matched fields, unmatched keys, skipped fields (file inputs, hidden, custom dropdowns), validation state after fill
- Optional submit flag on `browser_fill_form`
- Ambiguous matches reported rather than wrong-field fills
- Auto-detect form if no selector provided (single form → use it, multiple → most visible inputs, none → body)
- Hidden fields included in analysis but flagged as not user-fillable
- Fieldset/legend grouping captured as context metadata
- Both tools registered and functional — build passes

## Proof Level

- This slice proves: integration (tools work against real HTML forms in a running browser)
- Real runtime required: yes (Playwright browser for verification)
- Human/UAT required: no (automated verification against test page sufficient; UAT deferred to S06)

## Verification

- `cd pkg && npm run build` — build succeeds with new tools
- Standalone jiti verification script that loads the extension and confirms tool count is 45 (43 existing + 2 new)
- Browser verification: serve a test HTML form, run `browser_analyze_form`, assert field inventory matches expected structure
- Browser verification: run `browser_fill_form` with values mapping, assert fields are filled correctly

## Integration Closure

- Upstream surfaces consumed: `state.ts` (ToolDeps), `lifecycle.ts` (ensureBrowser, getActiveTarget), `settle.ts` (settleAfterActionAdaptive), `utils.ts` (beginTrackedAction, finishTrackedAction, formatCompactStateSummary), `capture.ts` (captureCompactPageState, captureErrorScreenshot)
- New wiring introduced in this slice: `import { registerFormTools } from "./tools/forms.js"` + `registerFormTools(pi, deps)` in index.ts
- What remains before the milestone is truly usable end-to-end: S05 (intent-ranked retrieval, semantic actions), S06 (test coverage)

## Tasks

- [x] **T01: Implement browser_analyze_form with full label resolution** `est:45m`
  - Why: R022 — the form analysis tool is the foundation. Its evaluate function implements label resolution heuristics that drive both analysis output and inform the fill tool's matching strategy.
  - Files: `src/resources/extensions/browser-tools/tools/forms.ts`, `src/resources/extensions/browser-tools/index.ts`
  - Do: Create `forms.ts` with `registerFormTools(pi, deps)`. Implement `browser_analyze_form` with a single `page.evaluate()` that inventories all form fields — full label resolution (aria-labelledby, aria-label, label-for, wrapping label, placeholder, title, name), type/required/value/validation extraction, fieldset/legend grouping, submit button detection. Auto-detect form if no selector given. Follow interaction.ts patterns for beginTrackedAction/finishTrackedAction and error handling. Wire into index.ts.
  - Verify: `npm run build` passes, jiti load confirms 45 tools registered
  - Done when: `browser_analyze_form` is registered, build succeeds, tool count is 45

- [x] **T02: Implement browser_fill_form and verify both tools against a real form** `est:45m`
  - Why: R023 — the fill tool completes the form intelligence pair. End-to-end verification against a real form proves both tools work and retires the key risk (label association).
  - Files: `src/resources/extensions/browser-tools/tools/forms.ts`
  - Do: Add `browser_fill_form` to `forms.ts`. Matching logic: try exact label match via `getByLabel()`, then `[name=]`, then `[placeholder=]`, then `[aria-label=]`. Use `fill()` for text inputs, `selectOption()` for selects, `setChecked()` for checkboxes/radios. Handle ambiguity (report, don't guess). Skip file inputs and hidden fields. Settle after fills. Optional submit flag. Return matched/unmatched/skipped summary with post-fill validation state. Verify both tools against a served multi-field test HTML form.
  - Verify: Build passes, serve test HTML form, run `browser_analyze_form` → verify field inventory, run `browser_fill_form` → verify fields filled and validation state returned
  - Done when: Both tools work against a real multi-field form — analyze returns correct field inventory, fill maps values correctly and reports results

## Files Likely Touched

- `src/resources/extensions/browser-tools/tools/forms.ts` (new)
- `src/resources/extensions/browser-tools/index.ts`
