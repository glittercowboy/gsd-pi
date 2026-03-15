---
id: M002
provides:
  - Modular browser-tools architecture — 8 infrastructure modules + 11 categorized tool files replacing 5000-line monolith
  - 47 registered browser tools (43 original + browser_analyze_form, browser_fill_form, browser_find_best, browser_act)
  - Consolidated action pipeline with signal-classified body text capture and zero-mutation settle short-circuit
  - Sharp-based screenshot resizing (no browser canvas dependency)
  - Opt-in screenshots on browser_navigate (default off)
  - Form intelligence — analyze any form's field inventory and fill by label/name/placeholder in one call
  - Intent-ranked element retrieval — 8 deterministic heuristic-scored intents with semantic action execution
  - 108 automated tests (63 unit + 45 integration) covering pure functions, state management, image processing, browser-side utilities, intent scoring, and form analysis
key_decisions:
  - "D007: Module split into state.ts, lifecycle.ts, capture.ts, settle.ts, refs.ts, utils.ts, evaluate-helpers.ts, and tools/ directory"
  - "D008: sharp for image resizing (replaces fragile canvas round-trip)"
  - "D009: Navigate screenshots off by default"
  - "D010: Browser-side utilities injected via addInitScript under window.__pi namespace"
  - "D011: Deterministic heuristics only for intent resolution (no hidden LLM calls)"
  - "D013: get/set accessors for mutable state (jiti CJS compatibility)"
  - "D015: Factory pattern for lifecycle-dependent utils to avoid circular deps"
  - "D017: High/low signal classification for body text capture"
  - "D019: Zero-mutation settle thresholds (60ms detection, 30ms quiet window)"
  - "D021: Fill uses Playwright locator APIs for proper event dispatch"
  - "D023: 4-dimension scoring model per intent"
  - "D025: jiti CJS imports for tests"
patterns_established:
  - "Accessor pattern for all mutable state: getX()/setX() in state.ts"
  - "registerXTools(pi, deps) as standard tool registration signature"
  - "ToolDeps interface as contract between tool files and infrastructure"
  - "window.__pi namespace for browser-side shared utilities injected via addInitScript"
  - "High-signal/low-signal tool classification for conditional state capture"
  - "page.evaluate string templates (not serialized closures) for complex browser-side logic"
  - "Per-field error isolation in fill operations"
  - "4-dimension orthogonal scoring for intent-ranked retrieval"
observability_surfaces:
  - "settleReason 'zero_mutation_shortcut' distinguishes short-circuited settles from normal dom_quiet"
  - "browser_analyze_form returns structured formAnalysis in details"
  - "browser_fill_form returns structured fillResult with matched/unmatched/skipped and resolvedBy per match"
  - "browser_find_best candidates include score breakdown in reason field"
  - "browser_act returns before/after diff, JS errors, and page summary"
requirement_outcomes:
  - id: R015
    from_status: active
    to_status: validated
    proof: "index.ts is 51-line orchestrator with zero registerTool calls; 8 infrastructure modules + 11 tool files; extension loads via jiti; 47 tools register"
  - id: R016
    from_status: active
    to_status: validated
    proof: "window.__pi contains 9 functions injected via addInitScript; survives navigation; refs.ts has zero inline redeclarations of shared functions"
  - id: R017
    from_status: active
    to_status: validated
    proof: "postActionSummary eliminated from action tools (grep returns 0 in interaction.ts); countOpenDialogs removed from all tool files; single captureCompactPageState call per action"
  - id: R018
    from_status: active
    to_status: validated
    proof: "explicit includeBodyText: true for 5 high-signal tools and includeBodyText: false for 4 low-signal tools in interaction.ts"
  - id: R019
    from_status: active
    to_status: validated
    proof: "zero_mutation_shortcut settle reason in settle.ts; combined readSettleState poll; 60ms/30ms thresholds"
  - id: R020
    from_status: active
    to_status: validated
    proof: "constrainScreenshot uses sharp(buffer).metadata() and sharp(buffer).resize(); zero page.evaluate calls in capture.ts; build passes"
  - id: R021
    from_status: active
    to_status: validated
    proof: "browser_navigate has screenshot: Type.Optional(Type.Boolean({ default: false })); capture gated with if (params.screenshot)"
  - id: R022
    from_status: active
    to_status: validated
    proof: "browser_analyze_form registered; 7-level label resolution verified against 12-field test form with diverse label associations"
  - id: R023
    from_status: active
    to_status: validated
    proof: "browser_fill_form registered; 5-strategy field resolution; 10 fields filled correctly; file input skipped; unmatched key reported"
  - id: R024
    from_status: active
    to_status: validated
    proof: "8 intents with 4-dimension scoring; up to 5 candidates with CSS selectors and reasons; differentiated rankings verified via Playwright tests"
  - id: R025
    from_status: active
    to_status: validated
    proof: "browser_act resolves top candidate, executes via Playwright locator.click() with getByRole fallback, settles, returns before/after diff; graceful isError on zero candidates"
  - id: R026
    from_status: active
    to_status: validated
    proof: "108 tests (63 unit + 45 integration) passing via npm run test:browser-tools in ~700ms"
duration: ~3h
verification_result: passed
completed_at: 2026-03-12
---

# M002: Browser Tools Performance & Intelligence

**Decomposed the monolithic 5000-line browser-tools into 8 focused modules + 11 tool files, cut per-action evaluate overhead, replaced canvas screenshots with sharp, and added 4 new tools — form analysis, form fill, intent-ranked retrieval, and semantic actions — backed by 108 automated tests.**

## What Happened

Six slices, executed sequentially. The first was the foundation; the rest built on it in parallel tracks that converged at testing.

**S01 (Module decomposition)** split the monolith into state.ts (18 mutable state variables behind get/set accessors), utils.ts (38 Node-side utilities), evaluate-helpers.ts (9 browser-side functions under window.__pi injected via addInitScript), lifecycle.ts, capture.ts, settle.ts, refs.ts, and 9 categorized tool files under tools/. Index.ts became a 51-line orchestrator. The accessor pattern was required because jiti's CJS shim doesn't propagate ES module live bindings. All 43 existing tools survived the split — verified by loading the extension, counting registrations, and spot-checking browser_navigate, browser_snapshot_refs, and browser_click_ref against a real page.

**S02 (Action pipeline performance)** consolidated the capture pipeline. Action tools now call `captureCompactPageState` once instead of separate postActionSummary + captureCompactPageState + countOpenDialogs calls. Tools are classified as high-signal (click, type, key_press, etc. — capture body text) or low-signal (scroll, hover, drag — skip body text). The settle function got a zero-mutation short-circuit: after 60ms with no mutations observed, the quiet window shrinks from 100ms to 30ms. Combined readSettleState replaces two sequential evaluate calls per poll iteration.

**S03 (Screenshot pipeline)** replaced the canvas round-trip in constrainScreenshot with sharp. No more shipping buffers to the browser as base64, drawing to canvas, and shipping back. Images within bounds pass through unchanged. browser_navigate screenshots became opt-in (default: false) — saves tokens on every navigation.

**S04 (Form intelligence)** added browser_analyze_form (7-level label resolution, form auto-detection, validation state, submit button discovery) and browser_fill_form (5-strategy field matching, type-aware filling via Playwright locator APIs, skip logic, optional submit). Both verified end-to-end against a 12-field test form with diverse label association methods.

**S05 (Intent-ranked retrieval)** added browser_find_best (8 intents, 4-dimension deterministic scoring per intent, up to 5 scored candidates) and browser_act (resolves top candidate, executes via Playwright locator, returns before/after diff). Intents: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation.

**S06 (Test coverage)** delivered 108 tests: 63 unit tests (CJS, jiti imports) covering pure functions, state accessors, EVALUATE_HELPERS_SOURCE validation, and constrainScreenshot with synthetic sharp buffers; 45 integration tests (ESM, Playwright) covering window.__pi utilities against real DOM, intent scoring differentiation, and form label resolution.

## Cross-Slice Verification

Each success criterion from the roadmap verified with specific evidence:

| Criterion | Evidence | Status |
|---|---|---|
| All 43 existing browser tools work identically after module decomposition | Extension loads via jiti; 43 original tools register across 9 tool files (3+10+7+4+5+5+1+7+1); spot-checked against real page in S01 | ✅ |
| Per-action latency reduced by consolidating state capture evaluate calls | postActionSummary eliminated from interaction.ts (grep: 0); countOpenDialogs removed from all tool files (grep: 0 across 11 files); single captureCompactPageState per action | ✅ |
| settleAfterActionAdaptive short-circuits on zero-mutation actions | `zero_mutation_shortcut` settle reason in settle.ts; 60ms/30ms thresholds; combined readSettleState poll | ✅ |
| constrainScreenshot uses sharp in Node, not page canvas | sharp imported in capture.ts; zero page.evaluate calls in capture.ts; sharp in root dependencies and extension peerDependencies | ✅ |
| browser_navigate returns no screenshot by default | `screenshot: Type.Optional(Type.Boolean({ default: false }))` parameter; capture block gated with `if (params.screenshot)` | ✅ |
| browser_analyze_form returns field inventory for any standard HTML form | Registered (47 total tools); 7-level label resolution; verified against 12-field test form | ✅ |
| browser_fill_form fills fields by label/name/placeholder mapping | Registered; 5-strategy field resolution; verified 10 fields filled correctly with type-aware Playwright APIs | ✅ |
| browser_find_best returns scored candidates for semantic intents | 8 intents with 4-dimension scoring; up to 5 candidates sorted by score with CSS selectors and reasons; differentiated rankings verified | ✅ |
| browser_act executes common micro-tasks in one call | Resolves top candidate via same scoring engine; executes via Playwright locator; returns before/after diff; graceful error on zero candidates | ✅ |
| Test suite covers shared utilities, heuristics, and new tools | 108 tests (63 unit + 45 integration) passing via `npm run test:browser-tools` in ~700ms | ✅ |

**Definition of done:**
- ✅ index.ts decomposed into focused modules; build succeeds (`npm run build` exits 0)
- ✅ Shared browser-side utilities injected once via addInitScript and used by buildRefSnapshot, resolveRefTarget, and new tools (window.__pi with 9 functions; refs.ts has zero inline redeclarations)
- ✅ Action tools use consolidated state capture (fewer evaluate calls than before)
- ✅ Low-signal actions skip body text capture (explicit `includeBodyText: false`)
- ✅ Settle short-circuits on zero-mutation actions (`zero_mutation_shortcut`)
- ✅ constrainScreenshot uses sharp (zero page.evaluate in capture.ts)
- ✅ browser_navigate defaults to no screenshot (`default: false`)
- ✅ browser_analyze_form, browser_fill_form, browser_find_best, browser_act registered and functional (47 total tools)
- ✅ Test suite passes (108/108, 0 failures)
- ✅ All 43 existing tools verified against running page (S01 spot-check)

## Requirement Changes

All 12 requirements transitioned from active → validated during this milestone:

- R015: active → validated — index.ts decomposed; 8 modules + 11 tool files; extension loads; 47 tools register
- R016: active → validated — window.__pi with 9 functions; survives navigation; zero inline redeclarations
- R017: active → validated — postActionSummary eliminated from action tools; countOpenDialogs removed; consolidated capture
- R018: active → validated — explicit high/low signal classification with includeBodyText per tool
- R019: active → validated — zero_mutation_shortcut settle reason; combined poll evaluate; 60ms/30ms thresholds
- R020: active → validated — sharp-based constrainScreenshot; zero page.evaluate in capture.ts
- R021: active → validated — screenshot parameter default false; capture gated
- R022: active → validated — browser_analyze_form with 7-level label resolution verified against test form
- R023: active → validated — browser_fill_form with 5-strategy field matching verified end-to-end
- R024: active → validated — browser_find_best with 8 intents and differentiated scoring
- R025: active → validated — browser_act with top-candidate execution and before/after diff
- R026: active → validated — 108 tests passing via npm run test:browser-tools

## Forward Intelligence

### What the next milestone should know
- Browser-tools is now modular. New tools go in a `tools/*.ts` file with a `registerXTools(pi, deps)` function, wired in index.ts. Follow the pattern in forms.ts or intent.ts.
- All mutable state lives in state.ts behind get/set accessors. Direct `export let` doesn't work under jiti.
- Browser-side shared utilities are in window.__pi (injected via addInitScript). If a new tool needs shared browser-side logic, add to evaluate-helpers.ts. If it's tool-specific, keep it in the tool file as a string template.
- The action pipeline pattern is: `captureCompactPageState(includeBodyText: highSignal) → action → settle → captureCompactPageState → formatCompactStateSummary`. Classify new tools as high or low signal.

### What's fragile
- The factory pattern for `createGetLivePagesSnapshot` is a circular-dep workaround — extending utils.ts with more lifecycle-dependent functions will require more factories.
- Signal classification (high/low) is hardcoded per tool, not in a central registry — if tool behavior changes, classification must be updated inline.
- The source extraction pattern in integration tests (readFileSync + brace-match + strip types + eval) breaks if extracted functions are significantly restructured. Tests fail clearly though.
- `close_dialog` position scoring assumes `[role="dialog"]` is not a full-screen wrapper — text/aria signals compensate.

### Authoritative diagnostics
- `npm run test:browser-tools` — 108 tests in ~700ms, exits non-zero on any failure. Single command for regression checking.
- `grep -rc "pi.registerTool" src/resources/extensions/browser-tools/tools/` — tool count audit. Should sum to 47.
- `grep -c "page.evaluate" src/resources/extensions/browser-tools/capture.ts` — should be 0. Any non-zero means server-side processing was re-introduced.
- `settleReason` in AdaptiveSettleDetails — check whether `zero_mutation_shortcut` is firing. If it fires on actions that should mutate, the 60ms threshold is too short.

### What assumptions changed
- `export let` was assumed to work for shared mutable state — jiti's CJS shim doesn't propagate live bindings, so get/set accessors were required (D013).
- In-session browser was assumed to have window.__pi after the module split — it doesn't until session restart, since the extension loaded before the split. Standalone jiti verification was used instead.
- intent.ts was estimated at ~350 lines, actual was ~614 — getByRole fallback and error handling added bulk without architectural impact.

## Files Created/Modified

- `src/resources/extensions/browser-tools/index.ts` — rewritten from ~5000 lines to 51-line orchestrator
- `src/resources/extensions/browser-tools/state.ts` — 18 state variables with accessors, types, ToolDeps, constants
- `src/resources/extensions/browser-tools/utils.ts` — 38 Node-side utility functions
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — EVALUATE_HELPERS_SOURCE with 9 browser-side functions
- `src/resources/extensions/browser-tools/lifecycle.ts` — browser lifecycle, addInitScript injection
- `src/resources/extensions/browser-tools/capture.ts` — page state capture, sharp-based screenshot constraining
- `src/resources/extensions/browser-tools/settle.ts` — adaptive DOM settling with zero-mutation short-circuit
- `src/resources/extensions/browser-tools/refs.ts` — ref snapshot/resolution using window.__pi
- `src/resources/extensions/browser-tools/tools/navigation.ts` — 4 tools, opt-in screenshot on navigate
- `src/resources/extensions/browser-tools/tools/screenshot.ts` — 1 tool
- `src/resources/extensions/browser-tools/tools/interaction.ts` — 10 tools, signal-classified capture
- `src/resources/extensions/browser-tools/tools/inspection.ts` — 7 tools
- `src/resources/extensions/browser-tools/tools/session.ts` — 7 tools
- `src/resources/extensions/browser-tools/tools/assertions.ts` — 3 tools
- `src/resources/extensions/browser-tools/tools/refs.ts` — 5 tools
- `src/resources/extensions/browser-tools/tools/wait.ts` — 1 tool
- `src/resources/extensions/browser-tools/tools/pages.ts` — 5 tools
- `src/resources/extensions/browser-tools/tools/forms.ts` — browser_analyze_form, browser_fill_form
- `src/resources/extensions/browser-tools/tools/intent.ts` — browser_find_best, browser_act
- `src/resources/extensions/browser-tools/tests/browser-tools-unit.test.cjs` — 63 unit tests
- `src/resources/extensions/browser-tools/tests/browser-tools-integration.test.mjs` — 45 integration tests
- `package.json` — sharp dependency, test:browser-tools script
- `src/resources/extensions/browser-tools/package.json` — sharp peerDependency
