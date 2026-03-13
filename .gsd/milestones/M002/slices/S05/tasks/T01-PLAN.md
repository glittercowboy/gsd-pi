---
estimated_steps: 5
estimated_files: 2
---

# T01: Implement browser_find_best and browser_act with 8-intent scoring engine

**Slice:** S05 — Intent-ranked retrieval and semantic actions
**Milestone:** M002

## Description

Create `tools/intent.ts` with both `browser_find_best` and `browser_act`, sharing a single intent resolution engine built as a string template evaluate script (same pattern as forms.ts `buildFormAnalysisScript`). The scoring engine runs entirely in-browser via `page.evaluate()`, using `window.__pi` utilities for element metadata. Each of 8 intents has a candidate selector strategy and multi-dimensional scoring function. `browser_act` takes the top candidate from the same scoring logic, executes via Playwright `locator().click()` (D021), settles, and returns a before/after diff.

## Steps

1. **Create `tools/intent.ts`** with the `registerIntentTools(pi, deps)` export function. Define the 8 intent names as a const array and use `StringEnum` for the parameter schema. Build `buildIntentScoringScript(intent, scope?)` as a string template that:
   - Normalizes the intent string (lowercase, strip spaces/underscores/hyphens)
   - For each intent, selects candidate elements (e.g., submit_form → buttons/inputs inside or near forms; close_dialog → buttons inside `[role="dialog"]` or `dialog` elements)
   - Scores each candidate 0-1 across 2-4 dimensions (structural position, role, text signals, visibility/enabled state)
   - Returns top 5 candidates sorted by score, each with: `{ score, selector, tag, role, name, text, reason }`
   - Uses `window.__pi.cssPath()` for selector generation, `window.__pi.inferRole()` / `window.__pi.accessibleName()` / `window.__pi.isVisible()` / `window.__pi.isEnabled()` for scoring signals

2. **Implement the 8 intent scoring functions** inside the evaluate string template:
   - `submitform` — query `button[type="submit"], input[type="submit"], button:not([type])` within forms; score by: is-submit-type, inside-form, text-suggests-submission, visible+enabled
   - `closedialog` — query buttons/links inside `[role="dialog"], dialog, [aria-modal="true"]`; score by: text-matches-close-pattern, has-aria-label-close, is-visible, position (top-right gets a boost)
   - `primarycta` — query all visible enabled buttons/links; score by: visual prominence (size), semantic weight (role=button > link), text-not-cancel/dismiss, position (main content area)
   - `searchfield` — query inputs with type=search or role=searchbox or name/placeholder matching "search"; score by: type-match, placeholder-match, visibility, is-in-header/nav
   - `nextstep` — query buttons/links with text matching next/continue/proceed/forward patterns; score by: text-match-strength, is-button, visible+enabled, not-disabled
   - `dismiss` — query buttons/links matching close/cancel/dismiss/skip/no-thanks patterns; score by: text-match, position, inside-dialog/modal/overlay, is-visible
   - `authaction` — query buttons/links matching login/sign-in/signup/register patterns; score by: text-match-strength, is-button-or-link, prominent-position, visible
   - `backnavigation` — query buttons/links matching back/previous/return patterns; score by: text-match, has-back-arrow/icon, is-in-nav/header, visible

3. **Register `browser_find_best`** tool:
   - Parameters: `intent` (StringEnum of 8 intents), optional `scope` (CSS selector to narrow search)
   - Execute: ensureBrowser → getActiveTarget → captureCompactPageState (before) → target.evaluate(buildIntentScoringScript) → format results as markdown with scores and selectors → tracked action finish
   - Output format: numbered candidates with score, selector, role, text, and reason

4. **Register `browser_act`** tool:
   - Parameters: `intent` (same StringEnum), optional `scope` (CSS selector)
   - Execute: ensureBrowser → captureCompactPageState (before) → target.evaluate(buildIntentScoringScript) → if zero candidates, return error → take top candidate → locator(candidate.selector).click() with getByRole fallback → settleAfterActionAdaptive → captureCompactPageState (after) → diffCompactStates → format result with before/after diff
   - For search_field intent: focus instead of click
   - Error handling: graceful error return when no candidates found, captureErrorScreenshot on unexpected failures

5. **Wire into index.ts**: Add `import { registerIntentTools } from "./tools/intent.js"` and `registerIntentTools(pi, deps)` call. Verify build passes and tool count = 47.

## Must-Haves

- [ ] `browser_find_best` registered with 8-intent StringEnum parameter
- [ ] `browser_act` registered with same 8-intent parameter
- [ ] Intent scoring runs as a single page.evaluate() string template per call
- [ ] Each intent has 2+ orthogonal scoring dimensions producing differentiated rankings
- [ ] Scoring uses `window.__pi.*` utilities (no inline redeclarations)
- [ ] Candidates include CSS selectors from `window.__pi.cssPath()`
- [ ] Results capped at 5 candidates, scored 0-1
- [ ] Intent string normalization handles underscores, spaces, mixed case
- [ ] `browser_act` clicks via `target.locator(selector).click()` not `page.evaluate(() => el.click())`
- [ ] `browser_act` returns error (not throw) when zero candidates
- [ ] Both tools use tracked action pattern (beginTrackedAction / finishTrackedAction)
- [ ] Tool count = 47 after wiring
- [ ] `npm run build` passes

## Verification

- `npm run build` passes with zero errors
- `grep -c "pi.registerTool" src/resources/extensions/browser-tools/tools/*.ts | awk -F: '{s+=$2} END {print s}'` outputs 47
- Playwright verification script against a test HTML page with form + dialog:
  - `browser_find_best` intent="submit_form" returns candidates with submit button scored highest
  - `browser_find_best` intent="close_dialog" returns close/dismiss button inside dialog
  - `browser_act` intent="submit_form" clicks the submit button
  - `browser_act` intent="close_dialog" with no dialog on page returns error, not crash

## Inputs

- `src/resources/extensions/browser-tools/tools/forms.ts` — pattern for string template evaluates, tool registration, error handling
- `src/resources/extensions/browser-tools/tools/interaction.ts` — pattern for Playwright locator click with getByRole fallback
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — window.__pi API surface (9 functions)
- `src/resources/extensions/browser-tools/index.ts` — wiring pattern (import + ToolDeps + registerXTools call)
- `src/resources/extensions/browser-tools/state.ts` — ToolDeps interface, CompactPageState type
- S05-RESEARCH.md — intent list, scoring guidance, common pitfalls

## Expected Output

- `src/resources/extensions/browser-tools/tools/intent.ts` — new file with ~350-400 lines containing `registerIntentTools(pi, deps)`, `buildIntentScoringScript()`, and both tool registrations
- `src/resources/extensions/browser-tools/index.ts` — modified with 1 new import line + 1 new registration call
