# S05: Intent-ranked retrieval and semantic actions — Research

**Date:** 2026-03-12

## Summary

This slice adds two new tools: `browser_find_best` (R024) — returns scored candidates for semantic intents like "submit form", "close dialog", "primary CTA" — and `browser_act` (R025) — executes common micro-tasks in one call by composing intent resolution with action execution.

The codebase is well-prepared. S01's module structure, `window.__pi` browser-side utilities, and the `ToolDeps` pattern give us clean extension points. S04's form tools (particularly submit button detection in `buildFormAnalysisScript`) provide a reusable pattern for the "submit form" intent. The V2 proposal lists 10 suggested intents; practical coverage of 6-8 high-value intents with deterministic scoring heuristics is achievable. Both tools should live in a new `tools/intent.ts` file following the established `registerXTools(pi, deps)` pattern.

The primary design challenge is crafting scoring heuristics that are useful across diverse real-world pages without being brittle. Each intent needs a candidate selector strategy (what elements to consider) and a scoring function (how to rank them). The scoring must be deterministic (D011 — no LLM calls). The `window.__pi` utilities (inferRole, accessibleName, isVisible, isEnabled, isInteractiveEl) provide the foundation for scoring signals.

## Recommendation

**Create `tools/intent.ts`** with both `browser_find_best` and `browser_act`. Structure intent resolution as a single `page.evaluate()` string template (same pattern as forms.ts) that takes an intent name and optional scope selector, then runs intent-specific candidate selection + heuristic scoring in the browser context. `browser_act` calls the same scoring logic, picks the top candidate, and executes the action via Playwright locator APIs (not evaluate-based clicks — per D021 pattern).

**Start with these intents:**
1. `submit_form` — find submit buttons/inputs within or near forms
2. `close_dialog` — find close/dismiss buttons within dialogs/modals
3. `primary_cta` — find the most prominent call-to-action button on the page
4. `search_field` — find the search input
5. `next_step` — find "next", "continue", "proceed" buttons
6. `dismiss` — find dismiss/cancel/close elements (broader than close_dialog)
7. `auth_action` — find login/signup/sign-in buttons
8. `back_navigation` — find back/previous navigation elements

**For `browser_act`:** take an `intent` string (same as browser_find_best) plus optional `scope` selector. Resolve the top candidate, execute the action (click for buttons, focus for inputs), settle, and return before/after diff. Bounded — single action, no loops, no retries (per R025 notes).

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Element visibility/role/name detection | `window.__pi.*` (9 functions) | Already injected, tested, survives navigation. Avoids inline redeclaration. |
| Selector generation for resolved elements | `window.__pi.cssPath()` + `window.__pi.selectorHints()` | Consistent with ref system. cssPath produces Playwright-compatible selectors. |
| Form submit detection | `tools/forms.ts` submit button query pattern | Proven pattern, but S05 should reimplement inline in the intent evaluate (D020 keeps form logic local; intent logic is also best kept local). |
| Action tracking (before/after state) | `deps.beginTrackedAction` / `deps.finishTrackedAction` | Established contract; all tools use it. |
| Compact state diffing | `diffCompactStates` from `core.js` | Used by click, type, etc. browser_act should use same diff pattern. |
| DOM settling after action | `deps.settleAfterActionAdaptive` | Mandatory after any action that changes the page. |
| TypeBox schema + StringEnum | `@sinclair/typebox` Type + `@gsd/pi-ai` StringEnum | Used by all other tool parameter definitions. Intent enum should use StringEnum. |

## Existing Code and Patterns

- `tools/forms.ts` — Pattern to follow: string template evaluate scripts (`buildFormAnalysisScript`), per-field error isolation, structured result in `details`. The submit button detection logic (`form.querySelectorAll('button, input[type="submit"]')` + type-checking) should be replicated in the intent evaluate for `submit_form` intent.
- `tools/interaction.ts` browser_click — Pattern for executing clicks: try `locator().click()`, fall back to `getByRole`, handle errors. `browser_act` should use the same Playwright locator approach, not `page.evaluate(() => el.click())`.
- `refs.ts` `buildRefSnapshot` — Uses `window.__pi.*` utilities for element metadata extraction. Intent scoring evaluate should follow this pattern of destructuring `window.__pi` at entry.
- `evaluate-helpers.ts` — 9 browser-side utilities under `window.__pi`. Scoring will lean heavily on: `inferRole` (button detection), `accessibleName` (text matching), `isVisible` (filter invisible), `isEnabled` (filter disabled), `isInteractiveEl` (interactive filtering).
- `core.js` `SNAPSHOT_MODES` — Dialog mode uses `containerExpand: true` pattern to find containers then include interactive children. Similar approach useful for `close_dialog` intent.
- `state.ts` ToolDeps — The contract. New tools must use deps for all infrastructure calls. buildRefSnapshot is available via deps if we want to return ref-compatible output (we should — allows follow-up with browser_click_ref).
- `index.ts` — Orchestrator. Needs import + registration call for `registerIntentTools`. Pattern is established: one line import, one line call.

## Constraints

- **Deterministic heuristics only** (D011) — no LLM calls in scoring. All ranking must be based on DOM signals: tag, role, name, text content, position, visibility, enabled state, size, prominence.
- **window.__pi must be available** — evaluate scripts can reference it. The addInitScript injection (D010) guarantees this for all pages after browser launch.
- **Playwright locator for actions** (D021) — browser_act must execute clicks via `target.locator(selector).click()`, not `page.evaluate(() => el.click())`. Proper event dispatch matters for SPAs.
- **Single file for both tools** — following the pattern of forms.ts (2 tools in one file). Both tools share intent resolution logic; splitting would force duplication or a shared module.
- **Tool count will go from 45 → 47** — verify via grep after implementation.
- **Intent evaluate scripts as string templates** — Playwright serialization doesn't support closures. Must use the string template pattern from forms.ts.
- **browser_act is bounded** — single action execution, no loops, no retries. If the top candidate fails, return error, don't try the second candidate.

## Common Pitfalls

- **Overly specific text matching** — Hardcoding "Submit" or "Close" in English won't work internationally. Score based on structural signals (button inside form, button inside dialog, aria-label patterns) more than exact text matching. Use text as a boost signal, not a gate.
- **Scoring that doesn't differentiate** — If all candidates score 0.5, the tool isn't useful. Each intent needs at least 2-3 orthogonal scoring dimensions so there's meaningful ranking differentiation. E.g., for submit_form: (1) is it a submit-type button? (2) is it inside a form? (3) does its text suggest submission? (4) is it visible?
- **Returning too many candidates** — `browser_find_best` should cap at 5 candidates. More is noise. The point is to narrow, not to enumerate.
- **Forgetting to expose selectors** — Each candidate must include a CSS selector that works with `locator().click()`. Without this, the output isn't actionable.
- **Intent string normalization** — "submit form" vs "submit_form" vs "Submit Form". Accept any reasonable variant by normalizing: lowercase, strip spaces/underscores, then match.
- **browser_act running on zero candidates** — If browser_find_best returns nothing, browser_act should return an error, not throw. Handle gracefully.

## Open Risks

- **Real-world heuristic accuracy** — Scoring heuristics designed against common patterns may fail on unusual pages (custom web components, shadow DOM buttons, non-standard dialog implementations). Mitigation: focus on structural signals (role, tag, position relative to form/dialog) over text content. Accept that some pages will produce low-confidence results.
- **Intent coverage vs complexity** — 8 intents means 8 scoring functions. Each must be tested in S06. Risk of scope creep if intents get too sophisticated. Mitigation: start simple, each intent is 15-30 lines of scoring logic. Don't over-engineer.
- **Score calibration** — Scores should be 0-1 but "0.93" is meaningless without consistent calibration. Risk: scores from different intents aren't comparable. Mitigation: document that scores are intent-relative, not cross-intent comparable.
- **Dialog detection across frameworks** — React portals, Material UI, Headless UI, Bootstrap modals all implement dialogs differently. `[role="dialog"]` + `dialog` tag covers most but not all. The close_dialog intent may miss framework-specific patterns.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | `github/awesome-copilot@playwright-generate-test` | available — not relevant (test generation, not tool building) |
| Browser automation | — | none found (custom infrastructure) |

No relevant skills to install. This is custom browser extension infrastructure work using Playwright APIs directly.

## Sources

- V2 Proposal (source: `src/resources/extensions/browser-tools/BROWSER-TOOLS-V2-PROPOSAL.md`) — sections 5 (intent-ranked retrieval) and 9 (goal-oriented composite tools) define the original vision: 10 suggested intents, deterministic heuristic ranking, bounded execution for browser_act.
- S04 forward intelligence (source: `.gsd/milestones/M002/slices/S04/S04-SUMMARY.md`) — form analysis evaluate scripts use string templates; submit detection logic can be replicated; D020 keeps form logic local to forms.ts.
- S01 forward intelligence (source: `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md`) — tool files import state accessors directly; ToolDeps carries infrastructure; window.__pi available via addInitScript.
