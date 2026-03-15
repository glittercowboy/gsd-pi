---
id: T01
parent: S04
milestone: M002
provides:
  - browser_analyze_form tool with full label resolution and form auto-detection
key_files:
  - src/resources/extensions/browser-tools/tools/forms.ts
  - src/resources/extensions/browser-tools/index.ts
key_decisions:
  - Form analysis runs as a single page.evaluate() string template rather than a serialized function, avoiding closure serialization issues with Playwright
  - Label resolution implemented entirely inside the evaluate callback (7-level priority chain) rather than reusing window.__pi.accessibleName which doesn't handle label-for
patterns_established:
  - registerFormTools(pi, deps) pattern consistent with other tool groups
  - Form evaluate script built via buildFormAnalysisScript() helper that injects the selector as JSON
observability_surfaces:
  - Tool returns structured formAnalysis object in details for programmatic consumption
  - Error path includes captureErrorScreenshot and finishTrackedAction with error status
duration: 15m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Implement browser_analyze_form with full label resolution

**Added `browser_analyze_form` tool that inventories form fields with 7-level label resolution, auto-detection, validation state, and submit button discovery via a single `page.evaluate()` call.**

## What Happened

Created `tools/forms.ts` with `registerFormTools()` containing the `browser_analyze_form` tool. The tool follows the established pattern: `ensureBrowser()` → `getActiveTarget()` → `captureCompactPageState()` → `beginTrackedAction()` → `page.evaluate()` → `finishTrackedAction()` with error screenshot on failure.

The evaluate callback handles:
- **Form auto-detection**: single form → use it; multiple forms → pick the one with most visible inputs; no forms → fall back to `document.body`
- **Field inventory**: iterates `input`, `select`, `textarea` excluding submit/button/reset/image inputs
- **Label resolution** (7 levels): aria-labelledby → aria-label → label[for] → wrapping label → placeholder → title → humanized name
- **Per-field data**: type, name, id, resolved label, required, value, checked (checkbox/radio), options (select), validation (ValidityState + message), hidden flag, disabled flag, fieldset/legend group
- **Submit buttons**: finds `<button type="submit">`, `<input type="submit">`, and `<button>` without explicit type

Wired into `index.ts` with import + `registerFormTools(pi, deps)` call.

## Verification

- `npm run build` — passes clean
- Tool count: 44 (43 existing + browser_analyze_form) verified via `grep -c registerTool` across all tool files
- `grep -c registerFormTools index.ts` returns 2 (import + call)
- TypeScript check on forms.ts shows no errors (only pre-existing core.js declaration warnings)

**Slice-level verification status (intermediate task — partial expected):**
1. ✅ `npm run build` passes
2. ✅ Tool count verified (44, will be 45 after T02 adds browser_fill_form)
3. ⏳ Browser verification of analyze_form — deferred to T02/slice completion
4. ⏳ Browser verification of fill_form — T02 scope

## Diagnostics

- Tool returns structured `formAnalysis` object in `details` with the full inventory
- Error states tracked via `finishTrackedAction` with error message
- Error screenshots captured on exceptions for agent debugging

## Deviations

- Task plan referenced `pkg/` prefix on all source paths — actual paths have no `pkg/` prefix. No impact on implementation.
- Task plan said to verify 44 tools via jiti script — jiti can't load the extension from source due to core.js being plain JS. Used grep-based tool count instead, which is equally reliable.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/forms.ts` — new file with `registerFormTools()` containing `browser_analyze_form` implementation
- `src/resources/extensions/browser-tools/index.ts` — added import and registration call for form tools
