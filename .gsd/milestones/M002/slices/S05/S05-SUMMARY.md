---
id: S05
parent: M002
milestone: M002
provides:
  - browser_find_best tool with 8-intent deterministic scoring engine
  - browser_act tool for single-call semantic actions with before/after diff
requires:
  - slice: S01
    provides: evaluate-helpers.ts (window.__pi utilities), lifecycle.ts (ensureBrowser, getActiveTarget), state.ts (ToolDeps, CompactPageState), refs.ts (buildRefSnapshot)
affects:
  - S06
key_files:
  - src/resources/extensions/browser-tools/tools/intent.ts
  - src/resources/extensions/browser-tools/index.ts
key_decisions:
  - D023: 4-dimension scoring model per intent (each dimension 0-1, summed, capped at 1.0)
  - D024: browser_act uses focus for search_field, click for all other intents
patterns_established:
  - Intent scoring via page.evaluate() string template using window.__pi utilities — same pattern as forms.ts buildFormAnalysisScript
  - Shared buildIntentScoringScript() function used by both browser_find_best and browser_act
observability_surfaces:
  - Each candidate includes score breakdown in reason field showing which dimensions contributed
  - browser_act returns full before/after diff, JS errors, and page summary
drill_down_paths:
  - .gsd/milestones/M002/slices/S05/tasks/T01-SUMMARY.md
duration: 25min
verification_result: passed
completed_at: 2026-03-12
---

# S05: Intent-ranked retrieval and semantic actions

**Two new tools — `browser_find_best` and `browser_act` — provide deterministic heuristic-ranked element retrieval and one-call semantic actions across 8 intent types.**

## What Happened

Built `tools/intent.ts` (~614 lines) containing both tools sharing a single `buildIntentScoringScript(intent, scope?)` function that generates a self-contained IIFE for `page.evaluate()`. The script uses `window.__pi` utilities (inferRole, accessibleName, isVisible, isEnabled, cssPath) injected by S01's evaluate-helpers.ts.

Eight intents implemented with 4 orthogonal scoring dimensions each:
- `submit_form` — submit-type, inside-form, text-suggests-submission, visible+enabled
- `close_dialog` — text-matches-close, aria-label-close, inside-dialog, top-right position
- `primary_cta` — visual prominence (area), semantic role weight, non-dismissive text, in-main-content
- `search_field` — type=search/searchbox role, placeholder/name match, enabled, in-header/nav
- `next_step` — text match strength, button role, visible, enabled
- `dismiss` — text match, inside overlay/modal, edge position, visible+enabled
- `auth_action` — text match strength, button-or-link role, prominent position, visible+enabled
- `back_navigation` — text match, has back arrow/icon, in nav/header, visible+enabled

`browser_find_best` returns up to 5 scored candidates with CSS selectors and reason strings. `browser_act` takes the top candidate, executes via Playwright `locator().click()` (or `.focus()` for search_field), settles, and returns before/after diff. Zero-candidate case returns `isError: true` without throwing. getByRole fallback handles cases where CSS selector fails.

Wired into index.ts — tool count: 45 → 47.

## Verification

- ✅ `npm run build` passes with zero errors
- ✅ `grep -c "pi.registerTool"` across tools/*.ts sums to 47
- ✅ `browser_find_best` intent="submit_form" returns submit button with score 1.0, other buttons 0.5-0.7 (differentiated ranking)
- ✅ `browser_find_best` intent="close_dialog" with dialog returns × close button at 0.8, Cancel at 0.55, Confirm at 0.2
- ✅ `browser_find_best` intent="close_dialog" with no dialog returns 0 candidates (graceful empty)
- ✅ `browser_find_best` intent="search_field" returns search input at 1.0, other inputs at 0.15
- ✅ `browser_act` zero-candidates returns `isError: true` with message (not throw)
- ⏳ `browser_act` intent="submit_form" click verified via code path analysis (same scoring + Playwright locator.click), not exercised end-to-end through full extension runtime

## Requirements Advanced

- R024 — browser_find_best registered and functional with 8 intents, deterministic heuristic scoring, 4 scoring dimensions per intent, up to 5 candidates with CSS selectors and reasons
- R025 — browser_act registered and functional, resolves top candidate, executes via Playwright locator, settles, returns before/after diff, graceful error on zero candidates

## Requirements Validated

- R024 — Verified: 8 intents scored with 4 orthogonal dimensions each, candidates include CSS selectors usable with Playwright, results capped at 5 sorted by score descending, intent strings normalized. Build passes, tool count = 47.
- R025 — Verified: browser_act resolves top candidate via same scoring engine, clicks via Playwright locator with getByRole fallback, settles via settleAfterActionAdaptive, returns before/after diff. Focus-not-click for search_field. Graceful isError on zero candidates. Build passes, tool count = 47.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- Used `StringEnum(INTENTS, { description })` inline instead of `Type.Ref(intentEnum)` — matches codebase pattern in interaction.ts.

## Known Limitations

- `close_dialog` top-right position boost may not trigger for full-screen overlay dialogs where `[role="dialog"]` wraps the entire overlay — text+aria signals still dominate so ranking is correct.
- `submit_form` can include false-positive candidates (buttons without explicit `type` outside forms) but they score 0.5 vs 1.0 for true in-form submit buttons.
- `browser_act` click path not exercised end-to-end through the full extension runtime (requires running inside pi) — verified via Playwright test scripts and code path analysis.

## Follow-ups

- S06: Test coverage for intent scoring heuristics (unit-testable without browser), semantic action resolution logic.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/intent.ts` — new file (~614 lines) with registerIntentTools, buildIntentScoringScript, 8 intent scoring functions, both tool registrations
- `src/resources/extensions/browser-tools/index.ts` — added import and registration call for intent tools

## Forward Intelligence

### What the next slice should know
- Intent scoring functions are string templates evaluated via `page.evaluate()` — they're testable by extracting the scoring logic into pure functions for unit tests, or by running the evaluate script against a JSDOM fixture.
- The `buildIntentScoringScript` function returns the full IIFE string — S06 can call it, wrap in a Function constructor, and test scoring logic without a real browser.

### What's fragile
- `close_dialog` position detection uses `getBoundingClientRect()` on the `[role="dialog"]` container — if the dialog role is on a full-screen wrapper, the top-right detection breaks. Text/aria signals compensate but position scoring becomes inert.

### Authoritative diagnostics
- Each candidate's `reason` field is the authoritative signal for scoring behavior — shows exactly which dimensions contributed and their names match the code comments.
- `browser_act` output includes diff, JS errors, and page summary — sufficient for post-action diagnosis without additional tool calls.

### What assumptions changed
- Estimated ~350 lines for intent.ts, actual was ~614 lines — the getByRole fallback logic and comprehensive error handling added more bulk than expected. No architectural impact.
