# S05: Intent-ranked retrieval and semantic actions — UAT

**Milestone:** M002
**Written:** 2026-03-12

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: Both tools were verified against real Playwright test pages during T01. The scoring engine is deterministic — same inputs always produce same outputs. Build verification + Playwright-level testing is sufficient without human gut-checking.

## Preconditions

- `npm run build` passes
- pi extension system can load browser-tools (jiti resolution works)

## Smoke Test

Run `npm run build` — if it passes, both tools are registered and the type system verified all interfaces.

## Test Cases

### 1. browser_find_best with submit_form intent

1. Navigate to a page with a `<form>` containing a submit button
2. Call `browser_find_best` with intent `"submit_form"`
3. **Expected:** Returns 1+ candidates, top candidate is the submit button with score > 0.7, includes `selector`, `reason`, `role`, `name` fields

### 2. browser_find_best with close_dialog intent

1. Navigate to a page with an open `[role="dialog"]` containing a close button
2. Call `browser_find_best` with intent `"close_dialog"`
3. **Expected:** Returns candidates including close/dismiss buttons, top candidate scores > 0.5, reason includes "inside-dialog"

### 3. browser_find_best with no matching elements

1. Navigate to a page with no dialog
2. Call `browser_find_best` with intent `"close_dialog"`
3. **Expected:** Returns 0 candidates, no error thrown

### 4. browser_act executes top candidate

1. Navigate to a page with a form and submit button
2. Call `browser_act` with intent `"submit_form"`
3. **Expected:** Clicks submit button, returns before/after diff showing form submission effects

### 5. browser_act graceful error on zero candidates

1. Navigate to a page with no dialog
2. Call `browser_act` with intent `"close_dialog"`
3. **Expected:** Returns `isError: true` with message explaining no candidates found, does not throw

### 6. Intent string normalization

1. Call `browser_find_best` with intent `"submit_form"` (underscore variant)
2. **Expected:** Works identically — normalization strips underscores/spaces/hyphens

### 7. Scoring differentiation

1. Navigate to a page with multiple buttons (submit, cancel, generic)
2. Call `browser_find_best` with intent `"submit_form"`
3. **Expected:** Submit button scores highest, cancel scores lower, ranking is differentiated (not all same score)

## Edge Cases

### Unknown intent string

1. Call `browser_find_best` with intent not in the 8 valid intents
2. **Expected:** Returns error message listing valid intents

### Scope selector not found

1. Call `browser_find_best` with scope `"#nonexistent-container"`
2. **Expected:** Returns error "Scope selector not found"

### search_field focuses instead of clicking

1. Navigate to a page with a search input
2. Call `browser_act` with intent `"search_field"`
3. **Expected:** Search input receives focus (not click), page state reflects focused element

## Failure Signals

- `npm run build` fails with type errors in intent.ts
- Tool count grep shows != 47
- `browser_find_best` returns empty candidates for pages that obviously have matching elements
- `browser_act` throws instead of returning `isError: true` on zero candidates
- Scoring produces identical scores for all candidates (no differentiation)

## Requirements Proved By This UAT

- R024 — browser_find_best with 8 intents, deterministic scoring, CSS selectors, up to 5 candidates
- R025 — browser_act resolves top candidate, executes via Playwright, settles, returns diff, graceful error

## Not Proven By This UAT

- R026 — Test coverage (deferred to S06)
- End-to-end browser_act execution through the full pi extension runtime (verified via Playwright scripts, not through tool registration dispatch)

## Notes for Tester

The scoring is purely deterministic — no randomness, no LLM calls. If a test fails, the same page state will always reproduce the same failure. Each candidate's `reason` field shows exactly which scoring dimensions contributed, making debugging straightforward.
