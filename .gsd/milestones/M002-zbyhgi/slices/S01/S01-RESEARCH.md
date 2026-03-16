# S01: Module Decomposition and Shared Evaluate Utilities — Research

**Date:** 2026-03-12

## Summary

The browser-tools extension is a single 4989-line `index.ts` with one `export default` function containing 43 `pi.registerTool()` calls. All shared state lives in module-level `let`/`const` declarations (browser, context, pageRegistry, logs, refs, timeline, traces, artifacts — 18 variables total). Helper functions (~60) sit between imports and the export, referencing this state via closure. The extension is loaded at runtime by `jiti` (a JIT TypeScript transpiler), not compiled by tsc (tsconfig excludes `src/resources/`). This means the module split needs to work with jiti's module resolution, and "build succeeds" means "jiti can load all modules at runtime."

The biggest win from R016 (shared evaluate utilities) is deduplicating `buildRefSnapshot` (~276 lines) and `resolveRefTarget` (~112 lines), which share identical copies of `cssPath` and `simpleHash`. `buildRefSnapshot` also defines `isVisible`, `isEnabled`, `inferRole`, `accessibleName`, `isInteractiveEl`, `domPath`, `selectorHints`, `matchesMode`, `computeNearestHeading`, and `computeFormOwnership` — all inlined inside a single `page.evaluate` callback. `browser_find` has overlapping but not identical role-mapping logic. `captureCompactPageState` has inline visibility checking. Injecting shared utilities via `context.addInitScript` under `window.__pi` is the right approach: it runs on every new page and survives navigation, the `__pi` prefix already has precedent (`__piMutationCounter`), and the functions are small enough that injection overhead is negligible.

The critical risk is the shared mutable state. All 43 tools close over 18 module-level variables. The decomposition must create a `state.ts` module that exports accessor functions (not raw variables) so that all tool modules reference the same singleton state. The existing `core.js` pattern (pure functions, no Playwright dependency, no state) is a good model for what works.

## Recommendation

**Approach: state module + infrastructure modules + tool group files + evaluate-helpers injection**

1. **`state.ts`** — All 18 mutable state variables + their types + accessor/mutator functions. Single source of truth.
2. **`lifecycle.ts`** — `ensureBrowser()`, `closeBrowser()`, `getActivePage()`, `getActiveTarget()`, `attachPageListeners()`. Imports state accessors.
3. **`capture.ts`** — `captureCompactPageState()`, `postActionSummary()`, `constrainScreenshot()`, `captureErrorScreenshot()`, `getRecentErrors()`, `formatCompactStateSummary()`. Imports state + lifecycle.
4. **`settle.ts`** — `settleAfterActionAdaptive()`, `ensureMutationCounter()`, `readMutationCounter()`, `readFocusedDescriptor()`. Imports state.
5. **`refs.ts`** — `buildRefSnapshot()`, `resolveRefTarget()`, `parseRef()`, `formatVersionedRef()`, `staleRefGuidance()`, ref state management. Imports state.
6. **`utils.ts`** — `truncateText()`, artifact helpers, error formatting, accessibility helpers, assertion helpers, diff helpers, verification helpers. Imports state.
7. **`evaluate-helpers.ts`** — Exports a string constant of browser-side JavaScript to inject via `context.addInitScript()`. Defines `window.__pi.cssPath`, `window.__pi.simpleHash`, `window.__pi.isVisible`, `window.__pi.isEnabled`, `window.__pi.inferRole`, `window.__pi.accessibleName`, `window.__pi.isInteractiveEl`, `window.__pi.domPath`, `window.__pi.selectorHints`.
8. **`tools/`** directory with tool registration files grouped by category:
   - `tools/navigation.ts` — navigate, go_back, go_forward, reload (4 tools)
   - `tools/screenshot.ts` — screenshot (1 tool)
   - `tools/interaction.ts` — click, drag, type, upload_file, scroll, hover, key_press, select_option, set_checked, set_viewport (10 tools)
   - `tools/inspection.ts` — get_console_logs, get_network_logs, get_dialog_logs, evaluate, get_page_source, get_accessibility_tree, find (7 tools)
   - `tools/session.ts` — close, trace_start, trace_stop, export_har, timeline, session_summary, debug_bundle (7 tools)
   - `tools/assertions.ts` — assert, diff, batch (3 tools)
   - `tools/refs.ts` — snapshot_refs, get_ref, click_ref, hover_ref, fill_ref (5 tools)
   - `tools/wait.ts` — wait_for (1 tool)
   - `tools/pages.ts` — list_pages, switch_page, close_page, list_frames, select_frame (5 tools)
9. **`index.ts`** — Slim orchestrator: imports all tool registration functions, calls them with `pi`, registers shutdown hook.

Each `tools/*.ts` file exports a function like `export function registerNavigationTools(pi: ExtensionAPI, deps: ToolDeps)` where `ToolDeps` bundles the infrastructure functions that tools need (ensureBrowser, getActiveTarget, captureCompactPageState, etc.). This avoids each tool file importing 15+ functions individually and makes the dependency explicit.

**Why `context.addInitScript` over per-page evaluate:**
- Runs automatically on every new page (popups, target="_blank", window.open)
- Survives navigation — no need to re-inject after `page.goto()`
- Runs before page scripts — no collision risk with late injection
- D010 already decided this approach

**Why accessor functions instead of re-exporting `let` variables:**
- ES module `export let x` creates a live binding, but jiti may not preserve this correctly for mutable state
- Accessor functions (`getBrowser()`, `setBrowser()`) are guaranteed to work regardless of module bundler behavior
- More explicit about mutation points — easier to grep for state changes

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Action timeline management | `core.js` `createActionTimeline()` | Already extracted, pure functions, proven |
| Page registry | `core.js` `createPageRegistry()` | Already extracted, proven |
| Log management | `core.js` `createBoundedLogPusher()` | Already extracted, proven |
| State diffing | `core.js` `diffCompactStates()` | Already extracted, proven |
| Assertion evaluation | `core.js` `evaluateAssertionChecks()` | Already extracted, proven |
| Batch step execution | `core.js` `runBatchSteps()` | Already extracted, proven |
| Snapshot mode config | `core.js` `getSnapshotModeConfig()` | Already extracted, proven |
| TypeBox schema types | `@sinclair/typebox` | Already used for all tool parameter schemas |

## Existing Code and Patterns

- `core.js` (~1057 lines) — Pure logic helpers with no Playwright dependency. Exports 20+ functions. Pattern to follow: stateless, testable, no side effects.
- `index.ts` lines 62–202 — All 18 mutable state variables + 11 type/interface definitions. These move to `state.ts`.
- `index.ts` lines 204–1610 — ~60 helper functions. These distribute across lifecycle/capture/settle/refs/utils modules based on their concerns.
- `index.ts` lines 1614–4989 — 43 tool registrations inside a single default export function. These distribute across 9 tool group files.
- `index.ts` `ensureBrowser()` (line 326) — The natural place to inject `addInitScript` is right after `browser.newContext()`, before any pages are created. The context-level init script applies to all pages automatically.
- `index.ts` `buildRefSnapshot()` (line 1221) — Canonical versions of browser-side utilities. The functions inlined here become the `window.__pi` utilities.
- `index.ts` `resolveRefTarget()` (line 1498) — Duplicates `cssPath` and `simpleHash` from `buildRefSnapshot`. After injection, these become `window.__pi.cssPath(el)` and `window.__pi.simpleHash(str)`.
- `package.json` `"pi": { "extensions": ["./index.ts"] }` — Entry point stays the same. The slim index.ts imports everything else.

## Constraints

- **jiti module resolution** — Extensions load via `@mariozechner/jiti`, not tsc. Relative `.ts` imports work. But jiti has quirks: circular imports may cause issues, re-exported mutable bindings may not work. Use accessor functions for state.
- **`src/resources/` excluded from tsc** — No compile-time type checking for extension files. Type errors only surface at runtime (or in IDE). Extra care needed during the split.
- **`initResources()` syncs entire directory** — `cpSync(bundledExtensionsDir, destExtensions, { recursive: true, force: true })` copies everything. New files in `src/resources/extensions/browser-tools/` automatically sync to `~/.gsd/agent/extensions/browser-tools/`. No package.json changes needed (entry point stays `./index.ts`).
- **No build step for extensions** — package.json `scripts.test` references `node --test tests/*.test.mjs` but the tests directory doesn't exist. Verification is runtime-only.
- **context.addInitScript ordering** — "The order of evaluation of multiple scripts is not defined" per Playwright docs. We only add one init script, so this isn't a problem. But if S02+ adds more, ordering can't be relied on.
- **Global namespace collision** — `window.__pi` must not conflict with any page's own JavaScript. The `__pi` prefix is unusual enough. All injected functions go under `window.__pi.*`.
- **Existing `__piMutationCounter`** — The mutation observer in `ensureMutationCounter` uses `window.__piMutationCounter` (not namespaced under `__pi`). Should migrate to `window.__pi.mutationCounter` during the split for consistency, but this is optional.
- **43 tools must maintain exact API** — No parameter changes, no return format changes. All existing tools must behave identically.

## Common Pitfalls

- **Circular imports between state.ts and lifecycle.ts** — `closeBrowser()` resets state, `ensureBrowser()` sets state. Both need state accessors. Solution: state.ts has zero imports from other browser-tools modules. lifecycle.ts imports state.ts. No cycles.
- **Forgetting to inject init script for new pages created via `context.on("page")`** — Not a problem: `context.addInitScript` applies to ALL pages in the context automatically, including popups. That's the whole point of context-level vs page-level.
- **evaluate callbacks can't reference Node-side closures** — This is already handled correctly (evaluate params are serialized). But when refactoring, ensure no accidental references to Node-side variables leak into evaluate callbacks.
- **Stale `~/.gsd/agent/extensions/browser-tools/`** — After adding new files, the old synced copy may have stale state if gsd isn't relaunched. The `cpSync` with `force: true` handles this, but during dev you need to restart gsd.
- **Tool registration order** — `browser_batch` internally calls other tools' logic (click, type, assert, etc.). After the split, batch needs access to these functions. Solution: batch imports the relevant infrastructure functions, not the registered tool objects.
- **State reset on `closeBrowser()`** — Must reset ALL state variables. Currently `closeBrowser()` explicitly resets each one. After the split, state.ts should have a `resetAllState()` function that closeBrowser calls.

## Open Risks

- **jiti mutable state binding behavior** — Uncertain whether jiti handles ES module live bindings correctly for `export let`. Mitigated by using accessor functions, but needs runtime verification. If accessors don't work either (unlikely), fallback is a shared state object.
- **evaluate-helpers.ts injection timing edge case** — If `ensureBrowser()` is called, then the browser crashes and is re-created, the init script must be re-registered on the new context. Currently `closeBrowser()` nulls the context and `ensureBrowser()` creates fresh — so a fresh `addInitScript` call happens. Verify this path works.
- **browser_batch internal tool dispatch** — batch currently calls tool implementations inline (long switch/case in `runBatchSteps`). After the split, these implementations need to be importable functions, not closures inside the export default. This may require extracting tool action functions separately from tool registration.
- **core.js vs new module overlap** — `core.js` has `computeContentHash` and `computeStructuralSignature` that use the same djb2 algorithm as `simpleHash` in the evaluate callbacks. The browser-side `simpleHash` must continue to match `core.js`'s hash. Document this invariant clearly.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | `github/awesome-copilot@playwright-generate-test` | available — not relevant (test authoring skill, not internal refactoring) |
| Playwright | `microsoft/playwright-cli@playwright-cli` | available — not relevant (CLI usage, not API refactoring) |

No skills are relevant to this slice. The work is internal module restructuring, not framework usage.

## Sources

- Playwright `addInitScript` API: `context.addInitScript` runs after document creation, before page scripts, on every page in context. Returns Disposable. (source: [Playwright docs via Context7](https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browsercontext.md))
- Extension loading: jiti-based, scans `pi.extensions` array in package.json, no build step. (source: `src/resource-loader.ts`, `node_modules/@gsd/pi-coding-agent/dist/core/extensions/loader.js`)
- Resource sync: `cpSync(bundledExtensionsDir, destExtensions, { recursive: true, force: true })` on every launch. (source: `src/resource-loader.ts` `initResources()`)
