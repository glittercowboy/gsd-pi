---
estimated_steps: 4
estimated_files: 10
---

# T03: Extract tool registrations into grouped files and create slim index.ts

**Slice:** S01 — Module decomposition and shared evaluate utilities
**Milestone:** M002

## Description

Move all 43 tool registrations from the monolithic export default function into 9 categorized tool files under `tools/`. Each file exports a single registration function. Rewrite `index.ts` as a slim orchestrator that imports everything and wires it together. This is the largest task by line count but the most mechanical — tool implementations don't change, only their location and import sources.

## Steps

1. Create `tools/` directory and 9 tool files. Each exports a function like `export function registerNavigationTools(pi: ExtensionAPI, deps: ToolDeps)`. Tool categorization per research:
   - `navigation.ts` — browser_navigate, browser_go_back, browser_go_forward, browser_reload (4 tools)
   - `screenshot.ts` — browser_screenshot (1 tool)
   - `interaction.ts` — browser_click, browser_drag, browser_type, browser_upload_file, browser_scroll, browser_hover, browser_key_press, browser_select_option, browser_set_checked, browser_set_viewport (10 tools)
   - `inspection.ts` — browser_get_console_logs, browser_get_network_logs, browser_get_dialog_logs, browser_evaluate, browser_get_page_source, browser_get_accessibility_tree, browser_find (7 tools)
   - `session.ts` — browser_close, browser_trace_start, browser_trace_stop, browser_export_har, browser_timeline, browser_session_summary, browser_debug_bundle (7 tools)
   - `assertions.ts` — browser_assert, browser_diff, browser_batch (3 tools)
   - `tools/refs.ts` — browser_snapshot_refs, browser_get_ref, browser_click_ref, browser_hover_ref, browser_fill_ref (5 tools)
   - `wait.ts` — browser_wait_for (1 tool)
   - `pages.ts` — browser_list_pages, browser_switch_page, browser_close_page, browser_list_frames, browser_select_frame (5 tools)

2. For each tool, the execute function body stays verbatim. Replace direct function calls (ensureBrowser, captureCompactPageState, etc.) with `deps.ensureBrowser()`, `deps.captureCompactPageState()`, etc. Replace direct state variable access (consoleLogs, currentRefMap, etc.) with state accessor calls imported from `../state.ts`.

3. Handle `browser_batch` carefully — its `executeStep` closure calls `settleAfterActionAdaptive`, `parseRef`, `resolveRefTarget`, `collectAssertionState`, `evaluateAssertionChecks`, and accesses `consoleLogs` directly. All of these come through deps or state imports. The `validateWaitParams`, `parseThreshold`, `meetsThreshold`, `includesNeedle`, `createRegionStableScript` come from core.js imports.

4. Rewrite `index.ts` as slim orchestrator: import all 9 register functions, import infrastructure modules, build the ToolDeps object, call each register function, register the `session_shutdown` hook. Target: under 50 lines. The old index.ts content is fully replaced.

## Must-Haves

- [ ] Exactly 43 pi.registerTool calls across all 9 tool files (count must match)
- [ ] index.ts is under 50 lines and contains zero tool registrations
- [ ] browser_batch internal step execution works — all infrastructure functions accessible via deps/imports
- [ ] No tool parameter schemas or return formats changed
- [ ] Extension loads via jiti and all tools register

## Verification

- `grep -rc "pi.registerTool" src/resources/extensions/browser-tools/tools/` sums to 43
- `wc -l src/resources/extensions/browser-tools/index.ts` is under 50
- `grep "pi.registerTool" src/resources/extensions/browser-tools/index.ts` returns no matches
- Extension loads via jiti without error

## Inputs

- `src/resources/extensions/browser-tools/state.ts` — state accessors (from T01)
- `src/resources/extensions/browser-tools/utils.ts` — utility functions (from T01)
- `src/resources/extensions/browser-tools/lifecycle.ts` — browser lifecycle (from T02)
- `src/resources/extensions/browser-tools/capture.ts` — state capture (from T02)
- `src/resources/extensions/browser-tools/settle.ts` — DOM settle (from T02)
- `src/resources/extensions/browser-tools/refs.ts` — ref management (from T02)
- `src/resources/extensions/browser-tools/index.ts` — source tool registrations to extract (lines 1614–4989)

## Expected Output

- `src/resources/extensions/browser-tools/tools/navigation.ts` (4 tools)
- `src/resources/extensions/browser-tools/tools/screenshot.ts` (1 tool)
- `src/resources/extensions/browser-tools/tools/interaction.ts` (10 tools)
- `src/resources/extensions/browser-tools/tools/inspection.ts` (7 tools)
- `src/resources/extensions/browser-tools/tools/session.ts` (7 tools)
- `src/resources/extensions/browser-tools/tools/assertions.ts` (3 tools)
- `src/resources/extensions/browser-tools/tools/refs.ts` (5 tools)
- `src/resources/extensions/browser-tools/tools/wait.ts` (1 tool)
- `src/resources/extensions/browser-tools/tools/pages.ts` (5 tools)
- `src/resources/extensions/browser-tools/index.ts` — slim orchestrator (<50 lines)
