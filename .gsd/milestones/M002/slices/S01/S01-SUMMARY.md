---
id: S01
parent: M002
milestone: M002
provides:
  - state.ts with 18 mutable state variables behind get/set accessors, all type interfaces, ToolDeps, resetAllState(), constants
  - utils.ts with 38 Node-side utility functions (artifact helpers, action tracking, assertion/verification, ref parsing, error summaries, compact state formatting)
  - evaluate-helpers.ts with EVALUATE_HELPERS_SOURCE string constant containing 9 browser-side functions under window.__pi namespace
  - lifecycle.ts with ensureBrowser (addInitScript injection), closeBrowser (resetAllState), attachPageListeners, getActivePage, getActiveTarget
  - capture.ts with captureCompactPageState, postActionSummary, constrainScreenshot, captureErrorScreenshot
  - settle.ts with settleAfterActionAdaptive, ensureMutationCounter, readMutationCounter, readFocusedDescriptor
  - refs.ts with buildRefSnapshot and resolveRefTarget using window.__pi.* (zero inline redeclarations)
  - 9 categorized tool files under tools/ with all 43 tool registrations
  - Slim index.ts orchestrator (47 lines, zero tool registrations)
requires:
  - slice: none
    provides: first slice
affects:
  - S02
  - S03
  - S04
  - S05
  - S06
key_files:
  - src/resources/extensions/browser-tools/index.ts
  - src/resources/extensions/browser-tools/state.ts
  - src/resources/extensions/browser-tools/utils.ts
  - src/resources/extensions/browser-tools/evaluate-helpers.ts
  - src/resources/extensions/browser-tools/lifecycle.ts
  - src/resources/extensions/browser-tools/capture.ts
  - src/resources/extensions/browser-tools/settle.ts
  - src/resources/extensions/browser-tools/refs.ts
  - src/resources/extensions/browser-tools/tools/navigation.ts
  - src/resources/extensions/browser-tools/tools/screenshot.ts
  - src/resources/extensions/browser-tools/tools/interaction.ts
  - src/resources/extensions/browser-tools/tools/inspection.ts
  - src/resources/extensions/browser-tools/tools/session.ts
  - src/resources/extensions/browser-tools/tools/assertions.ts
  - src/resources/extensions/browser-tools/tools/refs.ts
  - src/resources/extensions/browser-tools/tools/wait.ts
  - src/resources/extensions/browser-tools/tools/pages.ts
key_decisions:
  - "All mutable state behind get/set accessors (not export let) for jiti CJS compatibility (D013)"
  - "ToolDeps interface in state.ts alongside types it references (D014)"
  - "Factory pattern for lifecycle-dependent utils — createGetLivePagesSnapshot(ensureBrowser) avoids circular deps (D015)"
  - "evaluate-helpers uses ES5-compatible var/function syntax since it executes in browser context via addInitScript"
  - "Infrastructure modules import from state.ts and utils.ts only — never from each other — preventing circular deps"
  - "Browser-side evaluate callbacks destructure window.__pi at entry; only non-shared helpers remain inline"
  - "Tool files import state accessors directly from state.ts, core.js functions directly — ToolDeps carries only infrastructure needing lifecycle wiring"
  - "Each tool file exports a single registerXTools(pi, deps) function — consistent API"
  - "collectAssertionState takes captureCompactPageState as parameter to avoid premature circular dependency"
patterns_established:
  - "Accessor pattern for all mutable state: getX()/setX() in state.ts, imported by consumers"
  - "Factory pattern for functions needing lifecycle deps"
  - "ToolDeps interface as contract between tool registration files and infrastructure"
  - "registerXTools(pi, deps) as the standard tool registration function signature"
  - "Tool files never import from each other — only from state.ts, utils.ts, settle.ts, core.js, and external packages"
  - "Index.ts builds ToolDeps once and passes to all register functions — single wiring point"
observability_surfaces:
  - none
drill_down_paths:
  - .gsd/milestones/M002/slices/S01/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S01/tasks/T02-SUMMARY.md
  - .gsd/milestones/M002/slices/S01/tasks/T03-SUMMARY.md
  - .gsd/milestones/M002/slices/S01/tasks/T04-SUMMARY.md
duration: ~1.5h
verification_result: passed
completed_at: 2026-03-12
---

# S01: Module decomposition and shared evaluate utilities

**Split the monolithic ~5000-line browser-tools index.ts into 8 focused modules + 9 categorized tool files, with shared browser-side utilities injected via addInitScript — all 43 tools register and work identically.**

## What Happened

**T01** extracted the foundation: state.ts (18 mutable state variables with get/set accessors, all type interfaces, ToolDeps), utils.ts (38 Node-side utility functions), and evaluate-helpers.ts (EVALUATE_HELPERS_SOURCE string constant with 9 browser-side functions under window.__pi). The accessor pattern was chosen over `export let` because jiti's CJS shim doesn't reliably propagate ES module live bindings.

**T02** extracted four infrastructure modules: lifecycle.ts (ensureBrowser with addInitScript injection, closeBrowser via resetAllState), capture.ts (page state capture, screenshot constraining), settle.ts (adaptive DOM settling), and refs.ts (buildRefSnapshot/resolveRefTarget refactored to use window.__pi.* instead of redeclaring ~100 lines of utility functions inline). The import graph has no cycles.

**T03** moved all 43 tool registrations from the monolith into 9 categorized files under tools/ (navigation:4, screenshot:1, interaction:10, inspection:7, session:7, assertions:3, refs:5, wait:1, pages:5). Index.ts was rewritten as a 47-line orchestrator that imports register functions, builds ToolDeps, and wires everything.

**T04** verified end-to-end: extension loads via jiti, all 43 tools register, browser_navigate/browser_snapshot_refs/browser_click_ref work against a real page, window.__pi injection delivers all 9 expected functions, and a close/reopen cycle re-registers addInitScript correctly.

## Verification

- Extension loads via jiti (`typeof ext.default` === "function") — PASS
- Registered tool count === 43 — PASS
- index.ts is 47 lines (under 50 requirement) — PASS
- Zero `pi.registerTool` calls in index.ts — PASS
- Zero inline redeclarations of shared functions in refs.ts — PASS
- addInitScript(EVALUATE_HELPERS_SOURCE) present in lifecycle.ts — PASS
- EVALUATE_HELPERS_SOURCE contains all 9 expected functions — PASS
- window.__pi namespace used — PASS
- browser_navigate returns correct title/URL against test page — PASS
- browser_snapshot_refs returns refs with valid structure — PASS
- browser_click_ref resolves and clicks — PASS
- `Object.keys(window.__pi).sort()` returns 9 expected function names — PASS
- window.__pi survives navigation — PASS
- Close + reopen cycle: window.__pi available on fresh context — PASS
- djb2 hash invariant: simpleHash matches computeContentHash — PASS

## Requirements Advanced

- R015 (Module decomposition) — index.ts decomposed into 8 modules + 9 tool files; build succeeds; all 43 tools register and execute
- R016 (Shared browser-side evaluate utilities) — 9 functions injected once via addInitScript under window.__pi; buildRefSnapshot and resolveRefTarget reference them instead of redeclaring inline

## Requirements Validated

- R015 — Proved by: extension loads via jiti, 43 tools register, browser navigate/snapshot/click work against real page, index.ts is 47-line orchestrator
- R016 — Proved by: window.__pi contains all 9 functions, survives navigation, refs.ts has zero inline redeclarations of shared functions, close/reopen re-injects correctly

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- `collectAssertionState` takes `captureCompactPageState` as a parameter instead of importing it directly — avoids circular dependency since the function was still mid-extraction.
- `getLivePagesSnapshot` uses a factory pattern (`createGetLivePagesSnapshot`) for the same reason.
- `captureAccessibilityMarkdown` takes explicit `target` parameter to keep utils.ts free of lifecycle dependencies.
- window.__pi injection couldn't be verified through pi's own browser_evaluate (session started before module split), so a standalone jiti test exercised the exact code path — actually a stronger verification.

## Known Limitations

- Pi's in-session browser doesn't have window.__pi until the session is restarted (extension loaded at startup before split landed). Next session will pick it up automatically.
- Three helpers in refs.ts remain inline (matchesMode, computeNearestHeading, computeFormOwnership) — they're not duplicated elsewhere, so deduplication isn't needed.

## Follow-ups

- none

## Files Created/Modified

- `src/resources/extensions/browser-tools/index.ts` — rewritten from ~5000 lines to 47-line orchestrator
- `src/resources/extensions/browser-tools/state.ts` — new: 18 state variables with accessors, types, ToolDeps, constants
- `src/resources/extensions/browser-tools/utils.ts` — new: 38 Node-side utility functions
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` — new: EVALUATE_HELPERS_SOURCE with 9 browser-side functions
- `src/resources/extensions/browser-tools/lifecycle.ts` — new: browser lifecycle with addInitScript injection
- `src/resources/extensions/browser-tools/capture.ts` — new: page state capture, screenshot constraining
- `src/resources/extensions/browser-tools/settle.ts` — new: adaptive DOM settling
- `src/resources/extensions/browser-tools/refs.ts` — new: ref snapshot/resolution using window.__pi.*
- `src/resources/extensions/browser-tools/tools/navigation.ts` — new: 4 navigation tools
- `src/resources/extensions/browser-tools/tools/screenshot.ts` — new: 1 screenshot tool
- `src/resources/extensions/browser-tools/tools/interaction.ts` — new: 10 interaction tools
- `src/resources/extensions/browser-tools/tools/inspection.ts` — new: 7 inspection tools
- `src/resources/extensions/browser-tools/tools/session.ts` — new: 7 session management tools
- `src/resources/extensions/browser-tools/tools/assertions.ts` — new: 3 assertion tools
- `src/resources/extensions/browser-tools/tools/refs.ts` — new: 5 ref management tools
- `src/resources/extensions/browser-tools/tools/wait.ts` — new: 1 wait tool
- `src/resources/extensions/browser-tools/tools/pages.ts` — new: 5 page/frame management tools

## Forward Intelligence

### What the next slice should know
- All infrastructure functions are now importable from dedicated modules — no need to touch index.ts for S02-S05 work
- ToolDeps is the contract: tool files get captureCompactPageState, postActionSummary, settleAfterActionAdaptive, etc. via deps parameter
- State accessors (getX/setX) are the only way to read/write mutable state — direct variable access doesn't work under jiti

### What's fragile
- The factory pattern for `createGetLivePagesSnapshot` is a workaround for circular deps — if lifecycle.ts gets more utilities that utils.ts needs, this pattern will need extending
- Tool files import state accessors directly — if a new state variable is added, the accessor must be added to state.ts and all consumers updated

### Authoritative diagnostics
- `node /tmp/gsd-verify-s01.cjs` — loads extension via jiti and counts registered tools. If this breaks, the module split has regressed.
- `grep -c "function cssPath\|function simpleHash" refs.ts` — must be 0. If nonzero, inline redeclarations have been re-added.

### What assumptions changed
- Original assumption: `export let` would work for shared mutable state. Actual: jiti's CJS shim doesn't propagate live bindings, so get/set accessors were required.
- Original assumption: window.__pi could be verified through pi's own browser. Actual: the in-session browser was created before the split, so standalone jiti testing was necessary (and stronger).
