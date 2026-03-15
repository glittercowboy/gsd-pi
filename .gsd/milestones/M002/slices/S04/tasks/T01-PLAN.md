---
estimated_steps: 5
estimated_files: 3
---

# T01: Implement browser_analyze_form with full label resolution

**Slice:** S04 — Form Intelligence
**Milestone:** M002

## Description

Create `tools/forms.ts` with the `registerFormTools` function and implement `browser_analyze_form`. The tool takes an optional form selector, auto-detects the form if not provided, and returns a structured field inventory via a single `page.evaluate()` call. The evaluate function implements the full label resolution priority chain (aria-labelledby → aria-label → label-for → wrapping label → placeholder → title → name inference). Wire the new file into `index.ts`.

## Steps

1. Create `src/resources/extensions/browser-tools/tools/forms.ts` with the `registerFormTools(pi, deps)` export. Define the `browser_analyze_form` tool schema using Typebox — parameters: `selector` (optional string for form CSS selector). Return type is a structured field inventory.

2. Implement the `browser_analyze_form` execute function following the interaction.ts pattern: `ensureBrowser()` → `getActiveTarget()` → `captureCompactPageState()` (for before-state) → `beginTrackedAction()` → `page.evaluate()` → `finishTrackedAction()`. Error path uses `captureErrorScreenshot()`.

3. Implement the `page.evaluate()` callback with:
   - Form auto-detection: if no selector, find the single `<form>` or the form with most visible inputs, or fall back to `document.body`
   - Field inventory: iterate all `<input>`, `<select>`, `<textarea>` within the form scope
   - Label resolution (priority order): `aria-labelledby` → `aria-label` → `<label for="id">` → wrapping `<label>` → `placeholder` → `title` → humanized `name`
   - For each field: extract `type`, `name`, `id`, `label` (resolved), `required`, `value`, `checked` (for checkboxes/radios), `options` (for selects), `validation` (ValidityState + validationMessage), `hidden` flag, `disabled` flag
   - Fieldset/legend: walk up from each field to capture `<fieldset>` `<legend>` text as `group`
   - Submit buttons: find `<button type="submit">`, `<input type="submit">`, and `<button>` without explicit type within the form
   - Return: `{ formSelector, fields: [...], submitButtons: [...], fieldCount, visibleFieldCount }`

4. Wire into `index.ts`: import `registerFormTools` from `./tools/forms.js` and add `registerFormTools(pi, deps)` call alongside the other register calls.

5. Build and verify: run `npm run build`, then run a jiti verification script confirming 45 tools are registered (43 existing + browser_analyze_form + placeholder for browser_fill_form — actually 44 since fill isn't added yet; correct: verify 44 tools).

## Must-Haves

- [ ] `browser_analyze_form` registered as a tool with optional `selector` parameter
- [ ] Single `page.evaluate()` call collects entire field inventory
- [ ] Label resolution handles all 7 priority levels: aria-labelledby, aria-label, label-for, wrapping label, placeholder, title, name
- [ ] Fields include: type, name, id, label, required, value, validation state, hidden flag, disabled flag
- [ ] Select elements include their options
- [ ] Checkbox/radio elements include checked state
- [ ] Fieldset/legend captured as group context
- [ ] Submit buttons detected and listed
- [ ] Form auto-detection when no selector provided
- [ ] Hidden fields included but flagged
- [ ] Follows beginTrackedAction/finishTrackedAction pattern with error handling
- [ ] Wired into index.ts
- [ ] Build passes

## Verification

- `cd pkg && npm run build` completes without errors
- jiti script loads extension, counts registered tools — expect 44 (43 + browser_analyze_form)
- `grep -c "registerFormTools" src/resources/extensions/browser-tools/index.ts` returns 2 (import + call)

## Inputs

- `src/resources/extensions/browser-tools/tools/interaction.ts` — pattern for tool registration, beginTrackedAction/finishTrackedAction, error handling
- `src/resources/extensions/browser-tools/index.ts` — wiring pattern for new tool groups
- `src/resources/extensions/browser-tools/state.ts` — ToolDeps interface (no modifications needed)
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — window.__pi utilities (accessibleName available but doesn't handle label-for; form evaluate must implement its own label resolution)

## Expected Output

- `src/resources/extensions/browser-tools/tools/forms.ts` — new file with `registerFormTools()` containing `browser_analyze_form` implementation
- `src/resources/extensions/browser-tools/index.ts` — modified with import and registration of form tools
- Build succeeds with 44 registered tools
