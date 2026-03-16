---
estimated_steps: 5
estimated_files: 4
---

# T02: Extract infrastructure modules and wire addInitScript injection

**Slice:** S01 — Module decomposition and shared evaluate utilities
**Milestone:** M002-zbyhgi

## Description

Extract the four infrastructure modules (lifecycle, capture, settle, refs) that sit between state/utils and the tool registration layer. The key deliverable beyond mechanical extraction: `lifecycle.ts` injects `EVALUATE_HELPERS_SOURCE` via `context.addInitScript()` in `ensureBrowser()`, and `refs.ts` refactors `buildRefSnapshot`/`resolveRefTarget` evaluate callbacks to reference `window.__pi.*` instead of redeclaring utilities inline. This retires the R016 risk (shared browser-side evaluate utilities).

## Steps

1. Create `lifecycle.ts`: move `ensureBrowser()`, `closeBrowser()`, `getActivePage()`, `getActiveTarget()`, `getActivePageOrNull()`, `attachPageListeners()` from index.ts. Import state accessors from `./state.ts`. Import `EVALUATE_HELPERS_SOURCE` from `./evaluate-helpers.ts`. In `ensureBrowser()`, add `context.addInitScript(EVALUATE_HELPERS_SOURCE)` immediately after `browser.newContext()` and before `context.newPage()`. `closeBrowser()` calls `resetAllState()` from state.ts instead of resetting variables individually.

2. Create `capture.ts`: move `captureCompactPageState()`, `formatCompactStateSummary()`, `postActionSummary()`, `constrainScreenshot()`, `captureErrorScreenshot()`, `getRecentErrors()` from index.ts. Import from `./state.ts` and `./lifecycle.ts` as needed.

3. Create `settle.ts`: move `settleAfterActionAdaptive()`, `ensureMutationCounter()`, `readMutationCounter()`, `readFocusedDescriptor()` from index.ts. Import from `./state.ts`.

4. Create `refs.ts`: move `buildRefSnapshot()`, `resolveRefTarget()`, `parseRef()`, `formatVersionedRef()`, `staleRefGuidance()` from index.ts. **Refactor `buildRefSnapshot`'s evaluate callback:** remove the inline function declarations for `cssPath`, `simpleHash`, `isVisible`, `isEnabled`, `inferRole`, `accessibleName`, `isInteractiveEl`, `domPath`, `selectorHints`, `matchesMode`, `computeNearestHeading`, `computeFormOwnership` — replace with `window.__pi.cssPath(el)`, `window.__pi.simpleHash(str)`, etc. for the 9 injected functions. Keep `matchesMode`, `computeNearestHeading`, `computeFormOwnership` inline (they're not shared/duplicated). **Refactor `resolveRefTarget`'s evaluate callback:** remove inline `cssPath` and `simpleHash` declarations, replace with `window.__pi.cssPath` and `window.__pi.simpleHash`.

5. Verify all four modules load via jiti. Grep `buildRefSnapshot` and `resolveRefTarget` to confirm zero inline declarations of `cssPath` or `simpleHash`. Verify `lifecycle.ts` contains the `addInitScript` call.

## Must-Haves

- [ ] lifecycle.ts calls `context.addInitScript(EVALUATE_HELPERS_SOURCE)` after `browser.newContext()` and before `context.newPage()`
- [ ] closeBrowser() in lifecycle.ts calls resetAllState() from state.ts
- [ ] buildRefSnapshot evaluate callback uses window.__pi.cssPath, window.__pi.simpleHash, etc. — zero inline redeclarations of the 9 shared functions
- [ ] resolveRefTarget evaluate callback uses window.__pi.cssPath and window.__pi.simpleHash — zero inline redeclarations
- [ ] No circular imports between infrastructure modules (lifecycle→state, capture→state+lifecycle, settle→state, refs→state)

## Verification

- `grep -c "function cssPath\|function simpleHash" src/resources/extensions/browser-tools/refs.ts` returns 0
- `grep "addInitScript" src/resources/extensions/browser-tools/lifecycle.ts` returns a match
- `grep "resetAllState" src/resources/extensions/browser-tools/lifecycle.ts` returns a match
- All four modules load via jiti without error

## Inputs

- `src/resources/extensions/browser-tools/state.ts` — state accessors (from T01)
- `src/resources/extensions/browser-tools/utils.ts` — utility functions (from T01)
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — EVALUATE_HELPERS_SOURCE (from T01)
- `src/resources/extensions/browser-tools/index.ts` — source functions to extract

## Expected Output

- `src/resources/extensions/browser-tools/lifecycle.ts` — browser lifecycle with addInitScript injection
- `src/resources/extensions/browser-tools/capture.ts` — page state capture functions
- `src/resources/extensions/browser-tools/settle.ts` — DOM settle logic
- `src/resources/extensions/browser-tools/refs.ts` — ref snapshot/resolution using window.__pi.*
