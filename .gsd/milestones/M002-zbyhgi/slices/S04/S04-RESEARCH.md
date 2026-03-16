# S04: Form Intelligence — Research

**Date:** 2026-03-12

## Summary

S04 delivers two new tools: `browser_analyze_form` (R022) and `browser_fill_form` (R023). The codebase is well-prepared — S01 established the module structure, tool registration patterns, and `window.__pi` browser-side utilities. The core challenge is label association: mapping human-readable field identifiers to their input elements across the diverse patterns used in real-world HTML forms.

Playwright provides `getByLabel()` which already handles `<label for="id">`, wrapping labels, `aria-label`, and `aria-labelledby`. The `browser_fill_form` tool should leverage this directly for filling rather than reimplementing label-to-element resolution. For `browser_analyze_form`, the analysis needs to happen entirely in-browser via `page.evaluate()` since we need to extract a comprehensive field inventory in one round trip.

The existing `accessibleName()` in `evaluate-helpers.ts` handles `aria-label`, `aria-labelledby`, `placeholder`, `alt`, `value`, and `textContent` — but critically does NOT handle `<label for="id">` or wrapping `<label>` elements. The form analysis evaluate function must implement this label resolution itself (it can't use `accessibleName()` directly for label discovery).

## Recommendation

### browser_analyze_form
Single `page.evaluate()` call scoped to a form selector (or auto-detected form). Returns a structured inventory of fields with labels, types, values, required status, validation state, and submit buttons. The evaluate function implements full label resolution: `<label for>`, wrapping `<label>`, `aria-label`, `aria-labelledby`, `placeholder`, `fieldset/legend` grouping.

### browser_fill_form
Takes a `Record<string, string>` values mapping where keys match by label text, `name` attribute, `placeholder`, or `aria-label` (tried in that order). Uses Playwright's `getByLabel()` first for label-based matching, then falls back to `locator('[name="..."]')` and `locator('[placeholder="..."]')`. Uses `locator.fill()` for text inputs, `locator.selectOption()` for selects, `locator.setChecked()` for checkboxes/radios. Optionally submits the form after filling.

### Implementation structure
New file: `src/resources/extensions/browser-tools/tools/forms.ts` with `registerFormTools(pi, deps)`. Registered in `index.ts` alongside other tool groups. The form analysis evaluate logic stays in the tool file (not extracted to evaluate-helpers.ts) since it's form-specific, not a shared utility.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Label → input resolution for filling | Playwright `getByLabel()` | Handles `<label for>`, wrapping labels, aria-label, aria-labelledby. Battle-tested, handles edge cases. |
| Clicking/filling inputs | Playwright `locator.fill()`, `selectOption()`, `setChecked()` | Already used by `browser_type`, `browser_select_option`, `browser_set_checked`. Handles actionability waits. |
| Form-mode element filtering | `SNAPSHOT_MODES.form` in core.js | Already defines form-related tags/roles. Useful reference, though analyze_form needs richer output. |
| Settling after fill actions | `settleAfterActionAdaptive()` | Used by all interaction tools. Handles mutation observation and quiet window detection. |
| Type schema definitions | `@sinclair/typebox` `Type.*` | Standard across all browser tools. `Type.Record(Type.String(), Type.String())` for the values mapping. |
| Error screenshots on failure | `captureErrorScreenshot()` | Standard error handling pattern used by all interaction tools. |

## Existing Code and Patterns

- `tools/interaction.ts` — **Follow this pattern** for tool registration, `beginTrackedAction`/`finishTrackedAction`, error handling with `captureErrorScreenshot`, and action settle. `browser_type` is the closest analog for form filling.
- `evaluate-helpers.ts` — `window.__pi.accessibleName()` handles `aria-label`, `aria-labelledby`, `placeholder`, `alt`, `value`, `textContent`. Does NOT handle `<label for>` or wrapping `<label>`. Form analysis must add this.
- `refs.ts` — `computeFormOwnership()` (inline in buildRefSnapshot evaluate) shows how to walk up ancestors to find a `<form>`. Reusable pattern for auto-detecting the form context.
- `state.ts` — `ToolDeps` interface is the contract. New tools consume `ensureBrowser`, `getActiveTarget`, `captureCompactPageState`, `settleAfterActionAdaptive`, `beginTrackedAction`, `finishTrackedAction`, `formatCompactStateSummary`, `getRecentErrors`, `captureErrorScreenshot`, `getActivePageOrNull`, `readInputLikeValue`, `firstErrorLine`.
- `index.ts` — Import `registerFormTools` and add `registerFormTools(pi, deps)` call. No ToolDeps expansion needed — existing deps cover all form tool needs.
- `core.js` SNAPSHOT_MODES.form — Defines form-related tags: `["input", "select", "textarea", "button", "fieldset", "label", "output", "datalist"]` and roles: `["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "listbox", "option"]`. Good reference for what elements to inventory.

## Constraints

- **All evaluate code must be ES5-compatible** — `evaluate-helpers.ts` uses `var`/`function` syntax since it runs in arbitrary browser contexts. The form analysis evaluate function should follow this convention (though inline evaluates in tool files use TypeScript arrow functions — the pattern in `interaction.ts` and `refs.ts` uses modern syntax since it's compiled by TypeScript).
- **Single evaluate round-trip for analysis** — The field inventory must be collected in one `page.evaluate()` call for performance. Walking the DOM field-by-field would be O(n) round trips.
- **Label association priority order** — Must handle (in priority order): (1) `aria-labelledby`, (2) `aria-label`, (3) `<label for="id">`, (4) wrapping `<label>`, (5) `placeholder`, (6) `title` attribute, (7) inferred from `name` attribute. This matches WAI-ARIA accessible name computation.
- **Fill by Playwright APIs, not evaluate** — `browser_fill_form` must use Playwright's `locator.fill()` / `selectOption()` / `setChecked()` for filling, not `page.evaluate()` value setting. Playwright APIs trigger proper events (`input`, `change`) and handle framework-specific reactivity (React, Vue, Angular).
- **ToolDeps interface is frozen for S04** — No additions needed; all required infrastructure functions already exist on ToolDeps. Adding deps would require coordinating with index.ts wiring.
- **Form selector is optional** — Must auto-detect the form if no selector provided. Strategy: if only one `<form>` exists, use it. If multiple, pick the one with the most visible input fields. If none, scope to `document.body`.

## Common Pitfalls

- **`<label>` without `for` wrapping an input** — Many forms use `<label>Email <input type="email"></label>`. The label text is `Email` but `accessibleName(input)` returns `""` because the input has no attributes. Must walk up from the input to check for wrapping `<label>` elements and extract the label's text content minus the input's text.
- **Hidden/invisible fields** — Forms often have hidden inputs (`type="hidden"`), CSRF tokens, honeypot fields. The analysis should include them but flag them appropriately (hidden fields are not user-fillable).
- **Custom select/dropdown components** — `<div role="combobox">` elements won't respond to `selectOption()`. The fill tool should detect these and fall back to click-based interaction or report them as unfillable.
- **Radio button groups** — Multiple radio inputs share the same `name`. Fill mapping by name should set the radio whose `value` matches. By label should find the specific radio + label pair.
- **Validation state extraction** — `el.validity` (ValidityState API) gives `valid`, `valueMissing`, `typeMismatch`, `patternMismatch`, etc. Must be read inside evaluate since it's a browser-only API. `el.validationMessage` gives the browser's validation text.
- **Fieldset/legend grouping** — Some forms organize fields into `<fieldset>` with `<legend>`. The legend text provides context (e.g., "Billing Address"). Should be captured as group metadata but not confuse field label detection.
- **Matching ambiguity in fill** — If the user passes `{ "Name": "John" }` and there are two fields with a label containing "Name" (First Name, Last Name), the tool should report the ambiguity rather than filling the wrong field. Exact match first, then substring match.
- **Playwright `fill()` on non-fillable elements** — `fill()` throws on elements that aren't `<input>`, `<textarea>`, or `[contenteditable]`. Must catch and report gracefully.

## Open Risks

- **Custom React/Vue form components** — Some component libraries render inputs inside Shadow DOM or use custom elements that Playwright's `getByLabel()` may not resolve. Mitigation: fall back to `name`/`placeholder` matching, report unresolved fields.
- **Dynamic forms** — Forms that add/remove fields based on earlier selections (multi-step wizards, conditional fields). The analyze snapshot is point-in-time; the agent may need to re-analyze after filling some fields. Not a tool problem — just a usage pattern the agent needs to learn.
- **File inputs** — `<input type="file">` can't be filled via `fill()`. The tool should skip these and note them as requiring `browser_upload_file`.
- **Internationalized labels** — Labels in non-Latin scripts work fine for exact matching but fuzzy matching (substring, case-insensitive) may have Unicode normalization issues. Low risk for initial implementation.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | `github/awesome-copilot@playwright-automation-fill-in-form` | available (7.1K installs) — relevant but the form filling logic here is Playwright-native and well-understood; skill unlikely to add value over the Playwright docs |

No skills recommended for installation — the work is Playwright-native DOM traversal and label association heuristics, both well-covered by existing codebase patterns and Playwright documentation.

## Sources

- Playwright locator fill/check/select API (source: [Context7 /microsoft/playwright](https://github.com/microsoft/playwright/blob/main/docs/src/input.md))
- Playwright getByLabel for label association (source: [Context7 /microsoft/playwright](https://github.com/microsoft/playwright/blob/main/docs/src/locators.md))
- WAI-ARIA accessible name computation — priority order for label resolution (source: existing knowledge, W3C spec)
- Existing codebase: `evaluate-helpers.ts`, `refs.ts`, `interaction.ts`, `core.js` SNAPSHOT_MODES
