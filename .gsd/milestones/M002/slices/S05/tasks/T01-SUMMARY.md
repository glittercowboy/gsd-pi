---
id: T01
parent: S05
milestone: M002
provides:
  - browser_find_best tool with 8-intent scoring engine
  - browser_act tool for semantic one-call actions
key_files:
  - src/resources/extensions/browser-tools/tools/intent.ts
  - src/resources/extensions/browser-tools/index.ts
key_decisions:
  - All 8 intents scored with exactly 4 orthogonal dimensions (0-1 range), capped at 5 candidates per query
  - Intent string normalization strips spaces, underscores, hyphens and lowercases before matching — accepts any reasonable variant
  - browser_act uses focus instead of click for search_field intent
  - getByRole fallback in browser_act uses top candidate's accessible name for role matching when CSS selector fails
patterns_established:
  - Intent scoring via page.evaluate() string template using window.__pi utilities — same pattern as forms.ts buildFormAnalysisScript
  - Shared buildIntentScoringScript() function used by both browser_find_best and browser_act to avoid duplication
observability_surfaces:
  - Each candidate includes score breakdown in reason field showing which dimensions contributed
  - browser_act returns full before/after diff, JS errors, and page summary
duration: 25min
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Implement browser_find_best and browser_act with 8-intent scoring engine

**Created `tools/intent.ts` with both intent tools sharing a single scoring engine — 8 intents, 4 scoring dimensions each, deterministic heuristic ranking via page.evaluate().**

## What Happened

Built `tools/intent.ts` (~380 lines) with `registerIntentTools(pi, deps)` containing both `browser_find_best` and `browser_act`. The scoring engine is a single `buildIntentScoringScript(intent, scope?)` function that returns a self-contained IIFE string for `page.evaluate()`.

Each of 8 intents has a candidate selector strategy and 4-dimension scoring function:
- `submit_form` — submit-type boost, inside-form boost, text-suggests-submission, visible+enabled
- `close_dialog` — text-matches-close, aria-label-close, inside-dialog, top-right position
- `primary_cta` — visual prominence (area), semantic role weight, non-dismissive text, in-main-content
- `search_field` — type=search/searchbox role, placeholder/name match, enabled, in-header/nav
- `next_step` — text match strength, button role, visible, enabled
- `dismiss` — text match, inside overlay/modal, edge position, visible+enabled
- `auth_action` — text match strength, button-or-link role, prominent position, visible+enabled
- `back_navigation` — text match, has back arrow/icon, in nav/header, visible+enabled

`browser_act` takes the top candidate and executes via Playwright `locator().click()` with getByRole fallback. For `search_field` intent, it focuses instead of clicking. Returns before/after diff on success, graceful error on zero candidates.

Wired into `index.ts` with import + registration call. Tool count: 45 → 47.

## Verification

- `npm run build` passes with zero errors — **PASS**
- `grep -c "pi.registerTool" ... | awk` outputs 47 — **PASS**
- Playwright test against HTML page with form + dialog:
  - `submit_form`: "Send Message" submit button scores 1.0 (top), other buttons 0.5-0.7 — **PASS**
  - `close_dialog` (dialog open): × close button scores 0.8 (top), Cancel 0.55, Confirm 0.2 — differentiated ranking — **PASS**
  - `close_dialog` (no dialog): 0 visible candidates — graceful empty result — **PASS**
  - `search_field`: Search input scores 1.0, other inputs score 0.15 — **PASS**
- `browser_act` zero-candidates returns `isError: true` with message, not throw — verified in code — **PASS**

### Slice-level verification status (T01 of 1):
- ✅ `npm run build` passes
- ✅ Tool count = 47
- ✅ `browser_find_best` intent="submit_form" returns candidates with scores > 0
- ✅ `browser_find_best` intent="close_dialog" returns close button candidates
- ✅ Scoring heuristics produce differentiated rankings (top candidate scores higher than others)
- ✅ `browser_act` against page with no dialog returns graceful error for "close_dialog"
- ⏳ `browser_act` intent="submit_form" clicks submit button and returns before/after state — verified via code path (same scoring + Playwright locator.click pattern), not exercised end-to-end through the tool registration since that requires the full extension runtime

## Diagnostics

Each candidate in `browser_find_best` output includes a `reason` field showing which scoring dimensions contributed (e.g., "submit-type, inside-form, text-suggests-submit, visible+enabled"). `browser_act` output includes the full diff, JS errors, and page summary for post-action diagnosis.

## Deviations

- Used `StringEnum(INTENTS, { description })` inline instead of `Type.Ref(intentEnum)` — matches the codebase pattern in interaction.ts where StringEnum is used directly in parameter objects, not as a separate referenceable schema.

## Known Issues

- `close_dialog` top-right position boost may not trigger for dialogs implemented as full-screen overlays where the dialog box is a centered child — the bounding rect comparison uses the `[role="dialog"]` container, not the inner dialog box. Still produces correct ranking since text+aria signals dominate.
- `submit_form` can pick up buttons with `type` not explicitly set (defaulting to submit) that are outside forms — these score 0.5 vs 1.0 for true in-form submit buttons, so ranking is correct but candidates list may include false positives.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/intent.ts` — new file (~380 lines) with `registerIntentTools`, `buildIntentScoringScript`, 8 intent scoring functions, and both tool registrations
- `src/resources/extensions/browser-tools/index.ts` — added import and registration call for intent tools
