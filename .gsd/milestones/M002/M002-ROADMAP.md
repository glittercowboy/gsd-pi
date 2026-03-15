# M002: Browser Tools Performance & Intelligence

**Vision:** Transform browser-tools from a monolithic 5000-line file into a modular, faster, and smarter browser automation layer. Reduce per-action latency through consolidated state capture and faster settling. Replace fragile canvas screenshot resizing with sharp. Add form intelligence, intent-ranked retrieval, and semantic action tools that collapse common multi-call patterns into single tool calls.

## Success Criteria

- All 43 existing browser tools work identically after module decomposition
- Per-action latency reduced by consolidating state capture evaluate calls
- settleAfterActionAdaptive short-circuits on zero-mutation actions
- constrainScreenshot uses sharp in Node, not page canvas
- browser_navigate returns no screenshot by default
- browser_analyze_form returns field inventory for any standard HTML form
- browser_fill_form fills fields by label/name/placeholder mapping
- browser_find_best returns scored candidates for semantic intents
- browser_act executes common micro-tasks in one call
- Test suite covers shared utilities, heuristics, and new tools

## Key Risks / Unknowns

- Module split regression — 43 tools sharing mutable module-level state must all survive decomposition
- addInitScript behavior — injected utilities must be available in all evaluate contexts, survive navigation, not collide with page globals
- Form label association — real-world forms use diverse patterns; the heuristic mapper must handle common cases robustly

## Proof Strategy

- Module split regression → retire in S01 by proving build succeeds and all existing tools register/execute with the new structure
- addInitScript behavior → retire in S01 by proving shared utilities are callable from evaluate callbacks after navigation
- Form label association → retire in S04 by proving browser_analyze_form and browser_fill_form work on a real multi-field form

## Verification Classes

- Contract verification: unit tests for heuristic scoring, utility functions, form analysis logic, screenshot resizing
- Integration verification: existing tools register and execute against a real browser page after module split
- Operational verification: build succeeds, extension loads, sharp dependency resolves
- UAT / human verification: spot-check new tools against real web forms and pages

## Milestone Definition of Done

This milestone is complete only when all are true:

- index.ts is decomposed into focused modules; build succeeds
- Shared browser-side utilities are injected once and used by buildRefSnapshot, resolveRefTarget, and new tools
- Action tools use consolidated state capture (fewer evaluate calls than before)
- Low-signal actions skip body text capture
- Settle short-circuits on zero-mutation actions
- constrainScreenshot uses sharp
- browser_navigate defaults to no screenshot
- browser_analyze_form, browser_fill_form, browser_find_best, and browser_act are registered and functional
- Test suite passes
- All 43 existing tools verified against a running page (spot-check)

## Requirement Coverage

- Covers: R015, R016, R017, R018, R019, R020, R021, R022, R023, R024, R025, R026
- Partially covers: none
- Leaves for later: R027 (browser reuse — deferred)
- Orphan risks: none

## Slices

- [x] **S01: Module decomposition and shared evaluate utilities** `risk:high` `depends:[]`
  > After this: all 43 existing browser tools work identically with the new module structure; shared browser-side utilities (cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName) are injected once via addInitScript and used by buildRefSnapshot and resolveRefTarget — verified by build success and spot-check against a real page.

- [x] **S02: Action pipeline performance** `risk:medium` `depends:[S01]`
  > After this: captureCompactPageState and postActionSummary are consolidated into fewer evaluate calls per action; settleAfterActionAdaptive short-circuits on zero-mutation actions; low-signal actions (scroll, hover, Tab) skip body text capture — verified by build success and behavioral spot-check.

- [x] **S03: Screenshot pipeline** `risk:low` `depends:[S01]`
  > After this: constrainScreenshot uses sharp instead of canvas; browser_navigate returns no screenshot by default with an explicit parameter to opt in — verified by build success and running browser_navigate to confirm no screenshot in response.

- [x] **S04: Form intelligence** `risk:medium` `depends:[S01]`
  > After this: browser_analyze_form returns field inventory (labels, types, required, values, validation) for any form; browser_fill_form fills fields by label/name/placeholder mapping and optionally submits — verified by running both tools against a real multi-field form.

- [x] **S05: Intent-ranked retrieval and semantic actions** `risk:medium` `depends:[S01]`
  > After this: browser_find_best returns scored candidates for intents like "submit form", "close dialog", "primary CTA"; browser_act executes common micro-tasks in one call — verified by running both tools against real pages.

- [x] **S06: Test coverage** `risk:low` `depends:[S01,S02,S03,S04,S05]`
  > After this: test suite covers shared browser-side utilities, settle logic, screenshot resizing, form analysis heuristics, intent scoring, and semantic action resolution — verified by test runner passing.

## Boundary Map

### S01 → S02

Produces:
- `browser-tools/state.ts` — shared mutable state module (browser, context, pageRegistry, logs, refs, timeline, session state) with accessor functions
- `browser-tools/utils.ts` — shared Node-side utilities (truncateText, artifact helpers, error formatting)
- `browser-tools/lifecycle.ts` — ensureBrowser(), closeBrowser(), getActivePage(), getActiveTarget(), attachPageListeners()
- `browser-tools/capture.ts` — captureCompactPageState(), postActionSummary(), constrainScreenshot(), captureErrorScreenshot(), getRecentErrors()
- `browser-tools/settle.ts` — settleAfterActionAdaptive(), ensureMutationCounter(), readMutationCounter(), readFocusedDescriptor()
- `browser-tools/refs.ts` — buildRefSnapshot(), resolveRefTarget(), parseRef(), ref state management
- `browser-tools/evaluate-helpers.ts` — browser-side utility source injected via addInitScript (cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName)
- `browser-tools/tools/` — tool registration files grouped by category

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- `browser-tools/capture.ts` — constrainScreenshot() as a separate function that S03 will replace internals of

Consumes:
- nothing (first slice)

### S01 → S04

Produces:
- `browser-tools/evaluate-helpers.ts` — shared browser-side utilities that form tools will reference
- `browser-tools/lifecycle.ts` — ensureBrowser(), getActiveTarget()
- `browser-tools/state.ts` — action timeline, page state accessors

Consumes:
- nothing (first slice)

### S01 → S05

Produces:
- `browser-tools/evaluate-helpers.ts` — shared browser-side utilities that intent tools will reference
- `browser-tools/refs.ts` — buildRefSnapshot() for element inventory
- `browser-tools/lifecycle.ts` — ensureBrowser(), getActiveTarget()

Consumes:
- nothing (first slice)

### S02 → S06

Produces:
- Consolidated captureCompactPageState + postActionSummary logic (testable)
- Modified settleAfterActionAdaptive with zero-mutation short-circuit (testable)
- Action signal classification (high/low) for body text capture (testable)

Consumes from S01:
- Module structure, shared state, evaluate helpers

### S03 → S06

Produces:
- sharp-based constrainScreenshot (testable with buffer fixtures)

Consumes from S01:
- capture.ts module structure

### S04 → S05

Produces:
- Form analysis evaluate logic (field inventory, label mapping) that browser_act reuses for "submit form" intent

Consumes from S01:
- evaluate-helpers.ts, lifecycle.ts, state.ts

### S04 → S06

Produces:
- Form label association heuristics (testable)
- Field inventory logic (testable)

Consumes from S01:
- Module structure

### S05 → S06

Produces:
- Intent scoring heuristics (testable)
- Semantic action resolution logic (testable)

Consumes from S01:
- Module structure, refs, evaluate helpers

Consumes from S04:
- Form analysis logic for "submit form" intent
