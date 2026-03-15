---
id: T02
parent: S01
milestone: M002
provides:
  - lifecycle.ts with ensureBrowser (addInitScript injection), closeBrowser (resetAllState), attachPageListeners, getActivePage, getActiveTarget, getActivePageOrNull
  - capture.ts with captureCompactPageState, postActionSummary, constrainScreenshot, captureErrorScreenshot
  - settle.ts with settleAfterActionAdaptive, ensureMutationCounter, readMutationCounter, readFocusedDescriptor
  - refs.ts with buildRefSnapshot (window.__pi.*), resolveRefTarget (window.__pi.*)
key_files:
  - src/resources/extensions/browser-tools/lifecycle.ts
  - src/resources/extensions/browser-tools/capture.ts
  - src/resources/extensions/browser-tools/settle.ts
  - src/resources/extensions/browser-tools/refs.ts
key_decisions:
  - "attachPageListeners reads log arrays via getConsoleLogs()/getNetworkLogs()/getDialogLogs() at call time — logPusher pushes into the returned array references, so late-binding works correctly"
  - "refs.ts buildRefSnapshot/resolveRefTarget reference window.__pi.* by destructuring const pi = (window as any).__pi at evaluate entry — avoids repetitive window.__pi. prefix"
  - "closeBrowser() calls resetAllState() from state.ts instead of manually resetting each variable"
patterns_established:
  - "Infrastructure modules import from state.ts (accessors) and utils.ts (Node helpers) — never from each other, preventing circular deps"
  - "Browser-side evaluate callbacks reference injected window.__pi.* for the 9 shared functions; only non-shared helpers (matchesMode, computeNearestHeading, computeFormOwnership) remain inline"
observability_surfaces:
  - none
duration: ~15min
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Extract infrastructure modules and wire addInitScript injection

**Created lifecycle.ts, capture.ts, settle.ts, refs.ts — lifecycle injects EVALUATE_HELPERS_SOURCE via addInitScript, refs uses window.__pi.* with zero inline redeclarations of shared functions.**

## What Happened

Extracted four infrastructure modules from index.ts:

1. **lifecycle.ts** — `ensureBrowser()` now calls `context.addInitScript(EVALUATE_HELPERS_SOURCE)` after `browser.newContext()` and before `context.newPage()`. `closeBrowser()` delegates to `resetAllState()`. Includes `attachPageListeners`, `getActivePage`, `getActiveTarget`, `getActivePageOrNull`.

2. **capture.ts** — `captureCompactPageState`, `postActionSummary`, `constrainScreenshot`, `captureErrorScreenshot`. Imports `formatCompactStateSummary` from utils.ts (already extracted in T01).

3. **settle.ts** — `settleAfterActionAdaptive`, `ensureMutationCounter`, `readMutationCounter`, `readFocusedDescriptor`. Imports `getPendingCriticalRequests` from utils.ts.

4. **refs.ts** — `buildRefSnapshot` and `resolveRefTarget` now use `window.__pi.cssPath`, `window.__pi.simpleHash`, etc. for all 9 injected functions. Three helpers stay inline: `matchesMode`, `computeNearestHeading`, `computeFormOwnership` (not shared/duplicated). Zero inline redeclarations of the shared functions.

Import graph has no cycles: lifecycle→{core, state, utils, evaluate-helpers}, capture→{state, utils}, settle→{state, utils}, refs→{state, core}.

## Verification

- `grep -c "function cssPath\|function simpleHash" refs.ts` → **0** (zero inline redeclarations)
- `grep "addInitScript" lifecycle.ts` → match on `context.addInitScript(EVALUATE_HELPERS_SOURCE)`
- `grep "resetAllState" lifecycle.ts` → match on import and call in `closeBrowser()`
- All four modules load via jiti without error, exporting expected functions
- Full extension `index.ts` still loads via jiti with `typeof ext.default === "function"`

### Slice-level verification (partial — expected for T02):
- ✅ Extension loads via jiti (`typeof ext.default` is `"function"`)
- ⏳ Browser runtime tests (browser_navigate, browser_snapshot_refs, browser_click) — requires index.ts to be rewired to use these modules (T03+)
- ⏳ `window.__pi` availability verification — requires runtime browser launch (T03+)
- ⏳ Tool count === 43 — requires full integration (T03+)

## Diagnostics

None — these are pure extraction modules with no runtime observability surfaces.

## Deviations

- `getRecentErrors` and `formatCompactStateSummary` were already in utils.ts from T01, so capture.ts imports them rather than re-extracting. capture.ts only contains the functions that were still in index.ts.
- `parseRef`, `formatVersionedRef`, `staleRefGuidance` were already in utils.ts from T01, so refs.ts only contains `buildRefSnapshot` and `resolveRefTarget`.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/lifecycle.ts` — browser lifecycle with addInitScript injection, closeBrowser via resetAllState
- `src/resources/extensions/browser-tools/capture.ts` — page state capture, screenshot constraining, error screenshots
- `src/resources/extensions/browser-tools/settle.ts` — adaptive DOM settling with mutation counter polling
- `src/resources/extensions/browser-tools/refs.ts` — ref snapshot/resolution using window.__pi.* utilities
