---
estimated_steps: 5
estimated_files: 3
---

# T01: Extract state, types, utilities, and evaluate-helpers modules

**Slice:** S01 — Module decomposition and shared evaluate utilities
**Milestone:** M002

## Description

Extract the foundation modules that all other browser-tools modules will import from. `state.ts` holds all 18 mutable state variables behind accessor functions (critical for jiti compatibility — ES module live bindings may not work). `utils.ts` holds Node-side utility functions. `evaluate-helpers.ts` exports a JS string constant for browser-side injection. Define the `ToolDeps` interface that tool registration functions will consume.

## Steps

1. Create `state.ts`: move all 18 mutable state variables (lines 62–202 of index.ts), their type/interface definitions, and the constants (ARTIFACT_ROOT, HAR_FILENAME). Export get/set accessor functions for each variable (getBrowser/setBrowser, getContext/setContext, etc.). Export `resetAllState()` that mirrors current `closeBrowser()`'s reset logic. Export the `pageRegistry` and `actionTimeline` instances (these are objects with internal state, not plain variables). Import `createPageRegistry`, `createActionTimeline`, `createBoundedLogPusher` from `./core.js`.

2. Create `utils.ts`: move `truncateText()`, `formatArtifactTimestamp()`, `ensureDir()`, `writeArtifactFile()`, `copyArtifactFile()`, `ensureSessionStartedAt()`, `ensureSessionArtifactDir()`, `buildSessionArtifactPath()`, `getActivePageMetadata()`, `getActiveFrameMetadata()`, `getSessionArtifactMetadata()`, `sanitizeArtifactName()`, `getLivePagesSnapshot()`, `resolveAccessibilityScope()`, `captureAccessibilityMarkdown()`, `isCriticalResourceType()`, `updatePendingCriticalRequests()`, `getPendingCriticalRequests()`, `verificationFromChecks()`, `verificationLine()`, `collectAssertionState()`, `formatAssertionText()`, `formatDiffText()`, `getUrlHash()`, `countOpenDialogs()`, `captureClickTargetState()`, `readInputLikeValue()`, `firstErrorLine()`, `beginTrackedAction()`, `finishTrackedAction()`, `getSinceTimestamp()`, `getConsoleEntriesSince()`, `getNetworkEntriesSince()`. These import state accessors from `./state.ts`. Functions that reference `browser`, `context`, `consoleLogs`, etc. use the accessor pattern.

3. Create `evaluate-helpers.ts`: export a single `EVALUATE_HELPERS_SOURCE` string constant containing an IIFE that attaches functions to `window.__pi`. The functions: `cssPath`, `simpleHash`, `isVisible`, `isEnabled`, `inferRole`, `accessibleName`, `isInteractiveEl`, `domPath`, `selectorHints`. Copy these verbatim from `buildRefSnapshot`'s evaluate callback (lines 1228–1430 of index.ts). Wrap in `(function() { window.__pi = window.__pi || {}; window.__pi.cssPath = ...; ... })()`. Ensure `simpleHash` uses the exact djb2 algorithm that matches `core.js`.

4. Define `ToolDeps` interface (in state.ts or a separate types file — decide based on import graph). This bundles the infrastructure functions that tool registration files need: `ensureBrowser`, `closeBrowser`, `getActivePage`, `getActiveTarget`, `getActivePageOrNull`, `captureCompactPageState`, `postActionSummary`, `constrainScreenshot`, `captureErrorScreenshot`, `getRecentErrors`, `settleAfterActionAdaptive`, `ensureMutationCounter`, `buildRefSnapshot`, `resolveRefTarget`, `parseRef`, `formatVersionedRef`, `staleRefGuidance`, `formatCompactStateSummary`, `beginTrackedAction`, `finishTrackedAction`, etc.

5. Verify all three modules load via jiti without errors. Check no circular dependencies exist (state.ts imports only from core.js and node stdlib; utils.ts imports from state.ts and core.js; evaluate-helpers.ts imports nothing).

## Must-Haves

- [ ] state.ts exports accessor functions for all 18 state variables, not raw `export let`
- [ ] state.ts exports `resetAllState()` that resets every variable to its initial value
- [ ] evaluate-helpers.ts `simpleHash` uses identical djb2 algorithm to core.js `computeContentHash`
- [ ] evaluate-helpers.ts covers all 9 functions: cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, domPath, selectorHints
- [ ] No circular imports between the three new modules
- [ ] ToolDeps interface defined and exported

## Verification

- `node -e "const jiti = require('@mariozechner/jiti')(...); jiti('./src/resources/extensions/browser-tools/state.ts'); console.log('state ok')"` — no error
- `node -e "const jiti = require('@mariozechner/jiti')(...); jiti('./src/resources/extensions/browser-tools/utils.ts'); console.log('utils ok')"` — no error
- `node -e "const jiti = require('@mariozechner/jiti')(...); const h = jiti('./src/resources/extensions/browser-tools/evaluate-helpers.ts'); console.log(h.EVALUATE_HELPERS_SOURCE.includes('cssPath'))"` — prints true
- grep evaluate-helpers.ts for all 9 function names

## Inputs

- `src/resources/extensions/browser-tools/index.ts` — lines 62–202 (state/types), lines 204–620 (helpers), lines 1228–1430 (browser-side utilities)
- `src/resources/extensions/browser-tools/core.js` — `computeContentHash` djb2 algorithm for hash invariant check

## Expected Output

- `src/resources/extensions/browser-tools/state.ts` — all state + types + accessors + resetAllState + ToolDeps interface
- `src/resources/extensions/browser-tools/utils.ts` — all Node-side utility functions
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — EVALUATE_HELPERS_SOURCE string constant
