---
id: T01
parent: S01
milestone: M002
provides:
  - state.ts with 18 state variables behind accessor functions + resetAllState + ToolDeps interface
  - utils.ts with all Node-side utility functions (35+ exports)
  - evaluate-helpers.ts with EVALUATE_HELPERS_SOURCE string constant (9 browser-side functions)
key_files:
  - src/resources/extensions/browser-tools/state.ts
  - src/resources/extensions/browser-tools/utils.ts
  - src/resources/extensions/browser-tools/evaluate-helpers.ts
key_decisions:
  - All mutable state behind get/set accessors (not export let) for jiti CJS compatibility
  - pageRegistry and actionTimeline exported as both named instances and via getter functions since they are objects with internal state
  - collectAssertionState takes captureCompactPageState as a parameter to avoid circular dependency (captureCompactPageState lives in index.ts and will move to capture.ts in T02)
  - getLivePagesSnapshot uses factory pattern (createGetLivePagesSnapshot) to accept ensureBrowser without circular import
  - evaluate-helpers uses ES5-compatible var/function syntax since it executes in browser context via addInitScript
  - captureAccessibilityMarkdown takes target as explicit parameter instead of pulling from state internally
patterns_established:
  - Accessor pattern for all mutable state: getX()/setX() in state.ts, imported by consumers
  - Factory pattern for functions that need lifecycle deps: createGetLivePagesSnapshot(ensureBrowser)
  - ToolDeps interface as the contract between tool registration files and infrastructure
observability_surfaces:
  - none
duration: 25m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Extract state, types, utilities, and evaluate-helpers modules

**Created three foundation modules (state.ts, utils.ts, evaluate-helpers.ts) with accessor-based state, 38+ utility exports, and a browser-side IIFE with 9 functions — all load via jiti with no circular dependencies.**

## What Happened

Extracted all 18 mutable state variables from index.ts into state.ts with get/set accessor functions. This avoids relying on ES module live bindings which don't work reliably under jiti's CJS shim. Also defined all type interfaces (ConsoleEntry, NetworkEntry, CompactPageState, RefNode, etc.), constants (ARTIFACT_ROOT, HAR_FILENAME), and the ToolDeps interface that tool registration functions will consume in T03.

Moved 38 Node-side utility functions into utils.ts. These include artifact helpers, action tracking, assertion/verification helpers, ref parsing, error summaries, and compact state formatting. All functions import state via accessor functions from state.ts.

Created evaluate-helpers.ts as a single exported string constant containing an IIFE that attaches 9 utility functions to `window.__pi`. The simpleHash function uses the identical djb2 algorithm as core.js's computeContentHash — verified by running both against "hello world" and confirming identical output (23f8e89f).

## Verification

- `state.ts` loads via jiti: ✅ — 38 exports verified present
- `utils.ts` loads via jiti: ✅ — 38 exports verified present
- `evaluate-helpers.ts` loads via jiti: ✅ — EVALUATE_HELPERS_SOURCE includes all 9 function names
- djb2 hash invariant: ✅ — simpleHash("hello world") === computeContentHash("hello world") === "23f8e89f"
- No `export let` in state.ts: ✅ — 35 accessor functions, 0 raw exports
- resetAllState() resets all variables: ✅ — verified set/reset cycle
- No circular imports: ✅ — state→core.js only, utils→state+core, evaluate-helpers→nothing
- ToolDeps interface exported: ✅
- Extension index.ts still loads: ✅ — `typeof ext.default === "function"`

### Slice-level checks (partial — T01 is intermediate)
- Extension loads via jiti: ✅ PASS
- Browser navigate/snapshot/click: N/A (T04)
- window.__pi utilities available: N/A (T02)
- 43 tools register: N/A (T03)

## Diagnostics

None — these are pure module extraction files with no runtime observability surfaces.

## Deviations

- `collectAssertionState` takes `captureCompactPageState` as a parameter instead of importing it directly, since that function still lives in index.ts and will move to capture.ts in T02. This avoids a premature circular dependency.
- `getLivePagesSnapshot` uses a factory pattern (`createGetLivePagesSnapshot`) that accepts `ensureBrowser` as an argument, for the same reason.
- `captureAccessibilityMarkdown` takes an explicit `target` parameter rather than calling `getActiveTarget()` internally, to keep utils.ts free of lifecycle dependencies.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/state.ts` — new: 18 state variables with accessors, all type interfaces, ToolDeps, resetAllState(), constants
- `src/resources/extensions/browser-tools/utils.ts` — new: 38 Node-side utility functions using state accessors
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — new: EVALUATE_HELPERS_SOURCE string constant with 9 browser-side functions
