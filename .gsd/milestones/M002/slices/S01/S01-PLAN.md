# S01: Module decomposition and shared evaluate utilities

**Goal:** Split browser-tools index.ts (~5000 lines) into focused modules with shared browser-side utilities injected via addInitScript — all 43 existing tools work identically after.
**Demo:** Extension loads via jiti, all 43 tools register, browser_navigate + browser_snapshot_refs + browser_click work against a real page, buildRefSnapshot/resolveRefTarget use window.__pi utilities instead of inline duplicates.

## Must-Haves

- All 18 mutable state variables live in state.ts with accessor/mutator functions
- Infrastructure functions (ensureBrowser, captureCompactPageState, settleAfterActionAdaptive, buildRefSnapshot, resolveRefTarget, etc.) live in dedicated modules
- 43 tool registrations distributed across 9 categorized files in tools/
- index.ts is a slim orchestrator (<50 lines) that imports and calls registration functions
- evaluate-helpers.ts exports a JS string constant defining window.__pi.{cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, domPath, selectorHints}
- ensureBrowser() injects evaluate-helpers via context.addInitScript()
- buildRefSnapshot and resolveRefTarget reference window.__pi.* instead of redeclaring utilities inline
- Extension loads via jiti at runtime — no build step failures
- All 43 tools register and are callable

## Proof Level

- This slice proves: operational + integration (module split works at runtime, tools register and execute)
- Real runtime required: yes (jiti loading, Playwright browser)
- Human/UAT required: no (spot-check is agent-executable)

## Verification

- `node -e "const jiti = require('@mariozechner/jiti')(...); const ext = jiti('src/resources/extensions/browser-tools/index.ts'); console.log(typeof ext.default)"` — extension loads without error
- Run browser_navigate to a test page, then browser_snapshot_refs, then browser_click on a ref — all succeed
- Verify window.__pi utilities are available: `page.evaluate(() => typeof window.__pi?.cssPath)` returns "function"
- Count registered tools === 43

## Integration Closure

- Upstream surfaces consumed: `core.js` (pure helpers), `@gsd/pi-coding-agent` (ExtensionAPI type, truncation utils)
- New wiring introduced in this slice: state.ts accessor pattern, ToolDeps interface, addInitScript injection in ensureBrowser()
- What remains before the milestone is truly usable end-to-end: S02 (performance), S03 (screenshot/sharp), S04 (form tools), S05 (intent tools), S06 (tests)

## Tasks

- [x] **T01: Extract state, types, utilities, and evaluate-helpers modules** `est:1h`
  - Why: Foundation — everything else imports from these. State accessors are the key risk (jiti mutable binding behavior). evaluate-helpers is a standalone string constant with no imports.
  - Files: `src/resources/extensions/browser-tools/state.ts`, `src/resources/extensions/browser-tools/utils.ts`, `src/resources/extensions/browser-tools/evaluate-helpers.ts`
  - Do: Extract all 18 mutable state variables + types into state.ts with get/set accessor functions and resetAllState(). Extract truncateText, artifact helpers, error formatting, accessibility helpers, assertion helpers, verification helpers into utils.ts. Write evaluate-helpers.ts as an exported string constant containing the browser-side JS for window.__pi utilities (cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, domPath, selectorHints). Define ToolDeps interface that tool registration functions will accept. Preserve the djb2 hash invariant — simpleHash must match core.js computeContentHash algorithm.
  - Verify: `node -e "..."` — state.ts, utils.ts, evaluate-helpers.ts all import without error via jiti
  - Done when: Three modules exist, export correct interfaces, and load via jiti without circular dependency errors

- [x] **T02: Extract infrastructure modules and wire addInitScript injection** `est:1.5h`
  - Why: Delivers R016 (shared evaluate utilities) and the infrastructure layer that all tool files depend on. This is where addInitScript injection lands and where buildRefSnapshot/resolveRefTarget stop redeclaring utilities.
  - Files: `src/resources/extensions/browser-tools/lifecycle.ts`, `src/resources/extensions/browser-tools/capture.ts`, `src/resources/extensions/browser-tools/settle.ts`, `src/resources/extensions/browser-tools/refs.ts`
  - Do: Extract ensureBrowser/closeBrowser/getActivePage/getActiveTarget/attachPageListeners into lifecycle.ts — add context.addInitScript(EVALUATE_HELPERS_SOURCE) right after browser.newContext(). Extract captureCompactPageState/postActionSummary/constrainScreenshot/captureErrorScreenshot/getRecentErrors into capture.ts. Extract settleAfterActionAdaptive/ensureMutationCounter/readMutationCounter/readFocusedDescriptor into settle.ts. Extract buildRefSnapshot/resolveRefTarget/parseRef/formatVersionedRef/staleRefGuidance into refs.ts — refactor the evaluate callbacks in buildRefSnapshot and resolveRefTarget to reference window.__pi.cssPath, window.__pi.simpleHash etc. instead of redeclaring them. All modules import state accessors from state.ts, never raw variables.
  - Verify: Modules load via jiti. buildRefSnapshot evaluate callback no longer contains function declarations for cssPath/simpleHash (grep confirms). lifecycle.ts contains addInitScript call.
  - Done when: Four infrastructure modules exist, lifecycle.ts injects evaluate-helpers, refs.ts uses window.__pi.*, all load without error

- [x] **T03: Extract tool registrations into grouped files and create slim index.ts** `est:1.5h`
  - Why: Delivers R015 (module decomposition). The 43 tool registrations move from a single 3400-line block into 9 categorized files. index.ts becomes a slim orchestrator.
  - Files: `src/resources/extensions/browser-tools/tools/navigation.ts`, `tools/screenshot.ts`, `tools/interaction.ts`, `tools/inspection.ts`, `tools/session.ts`, `tools/assertions.ts`, `tools/refs.ts`, `tools/wait.ts`, `tools/pages.ts`, `src/resources/extensions/browser-tools/index.ts`
  - Do: Create tools/ directory. Each file exports a register function (e.g. registerNavigationTools(pi, deps)) that takes ExtensionAPI and ToolDeps. Move tool registrations verbatim — no logic changes, just import wiring. browser_batch in assertions.ts needs imports for settleAfterActionAdaptive, parseRef, resolveRefTarget, collectAssertionState, etc. Write new index.ts (<50 lines): import all register functions, build ToolDeps object, call each register function, register session_shutdown hook.
  - Verify: Count pi.registerTool calls across all tool files === 43. Extension loads via jiti. index.ts is under 50 lines.
  - Done when: Old monolithic index.ts is replaced by slim orchestrator, 9 tool files exist with correct tool counts per category, extension loads

- [x] **T04: Runtime verification against a real browser page** `est:30m`
  - Why: The split is worthless if tools don't actually work. This task proves the operational contract by exercising the extension end-to-end.
  - Files: none (verification only)
  - Do: Load the extension, launch a browser, navigate to a page, take a snapshot, click a ref, verify window.__pi is injected. Check that buildRefSnapshot evaluate callback uses window.__pi (not inline declarations). Verify closeBrowser() resets all state. Verify re-launch after close works (addInitScript re-registered on new context).
  - Verify: browser_navigate succeeds, browser_snapshot_refs returns refs, browser_click_ref resolves and clicks, page.evaluate(() => Object.keys(window.__pi)) returns expected function names, close + re-open cycle works
  - Done when: All 43 tools register, navigate/snapshot/click work against a real page, window.__pi utilities are callable in evaluate context, close/reopen cycle passes

## Files Likely Touched

- `src/resources/extensions/browser-tools/index.ts` (rewritten to slim orchestrator)
- `src/resources/extensions/browser-tools/state.ts` (new)
- `src/resources/extensions/browser-tools/utils.ts` (new)
- `src/resources/extensions/browser-tools/evaluate-helpers.ts` (new)
- `src/resources/extensions/browser-tools/lifecycle.ts` (new)
- `src/resources/extensions/browser-tools/capture.ts` (new)
- `src/resources/extensions/browser-tools/settle.ts` (new)
- `src/resources/extensions/browser-tools/refs.ts` (new)
- `src/resources/extensions/browser-tools/tools/navigation.ts` (new)
- `src/resources/extensions/browser-tools/tools/screenshot.ts` (new)
- `src/resources/extensions/browser-tools/tools/interaction.ts` (new)
- `src/resources/extensions/browser-tools/tools/inspection.ts` (new)
- `src/resources/extensions/browser-tools/tools/session.ts` (new)
- `src/resources/extensions/browser-tools/tools/assertions.ts` (new)
- `src/resources/extensions/browser-tools/tools/refs.ts` (new)
- `src/resources/extensions/browser-tools/tools/wait.ts` (new)
- `src/resources/extensions/browser-tools/tools/pages.ts` (new)
