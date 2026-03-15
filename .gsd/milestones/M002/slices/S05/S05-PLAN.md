# S05: Intent-ranked retrieval and semantic actions

**Goal:** `browser_find_best` returns scored candidates for semantic intents; `browser_act` resolves the top candidate and executes it in one call.
**Demo:** Run `browser_find_best` with intent "submit_form" against a real page with a form and get ranked candidates. Run `browser_act` with intent "close_dialog" against a page with a modal and see it dismissed.

## Must-Haves

- `browser_find_best` registered and functional with 8 intents: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation
- Each intent uses deterministic heuristic scoring (no LLM calls) with 2+ scoring dimensions per intent
- Candidates include CSS selectors usable with Playwright locator APIs
- Results capped at 5 candidates, scored 0-1 with human-readable reasons
- Intent strings normalized (accept underscores, spaces, mixed case)
- `browser_act` resolves top candidate, executes via Playwright locator click (not evaluate click), settles, returns before/after diff
- `browser_act` returns error (not throw) when zero candidates found
- Both tools wired into index.ts, tool count = 47
- Build passes

## Proof Level

- This slice proves: integration (new tools against real browser pages)
- Real runtime required: yes (Playwright against real pages)
- Human/UAT required: no (automated verification sufficient)

## Verification

- `npm run build` passes
- `grep -c "pi.registerTool" src/resources/extensions/browser-tools/tools/*.ts` sums to 47
- `browser_find_best` with intent "submit_form" against a page with a `<form>` returns candidates with scores > 0
- `browser_find_best` with intent "close_dialog" against a page with a `[role="dialog"]` returns close button candidates
- `browser_act` with intent "submit_form" clicks the submit button and returns before/after state
- `browser_act` against a page with no dialog returns a graceful error (not throw) for "close_dialog" intent
- Scoring heuristics produce differentiated rankings (top candidate scores higher than others)

## Integration Closure

- Upstream surfaces consumed: `evaluate-helpers.ts` (window.__pi utilities), `lifecycle.ts` (ensureBrowser, getActiveTarget), `state.ts` (ToolDeps, CompactPageState), `utils.ts` (action tracking, formatting), `core.js` (diffCompactStates), `settle.ts` (settleAfterActionAdaptive)
- New wiring introduced: `tools/intent.ts` + import/call in `index.ts`
- What remains before the milestone is truly usable end-to-end: S06 (test coverage)

## Tasks

- [x] **T01: Implement browser_find_best and browser_act with 8-intent scoring engine** `est:45m`
  - Why: This is the entire slice — two tools sharing a single intent resolution engine, all in one file following the established forms.ts pattern. The scoring evaluate script, both tool registrations, and the index.ts wiring are tightly coupled and well within a single context window (~350 lines new code, 2 files created/modified).
  - Files: `src/resources/extensions/browser-tools/tools/intent.ts` (new), `src/resources/extensions/browser-tools/index.ts` (wire)
  - Do: Build `buildIntentScoringScript(intent, scope?)` as a string template evaluate returning scored candidates with cssPath selectors. Implement 8 intent scoring functions using window.__pi utilities (inferRole, accessibleName, isVisible, isEnabled, isInteractiveEl). Register `browser_find_best` (intent + optional scope → scored candidates) and `browser_act` (intent + optional scope → resolve top candidate → Playwright locator click → settle → diff). Wire via registerIntentTools import + call in index.ts.
  - Verify: `npm run build` passes; grep tool count = 47; run both tools against real test pages via Playwright scripts
  - Done when: Both tools registered, build passes, verified against real pages with forms and dialogs

## Files Likely Touched

- `src/resources/extensions/browser-tools/tools/intent.ts` (new)
- `src/resources/extensions/browser-tools/index.ts` (wire registration)
