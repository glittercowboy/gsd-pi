---
id: T03
parent: S01
milestone: M002
provides:
  - 9 categorized tool files under tools/ with all 43 tool registrations
  - Slim index.ts orchestrator (47 lines, zero tool registrations)
key_files:
  - src/resources/extensions/browser-tools/tools/navigation.ts
  - src/resources/extensions/browser-tools/tools/screenshot.ts
  - src/resources/extensions/browser-tools/tools/interaction.ts
  - src/resources/extensions/browser-tools/tools/inspection.ts
  - src/resources/extensions/browser-tools/tools/session.ts
  - src/resources/extensions/browser-tools/tools/assertions.ts
  - src/resources/extensions/browser-tools/tools/refs.ts
  - src/resources/extensions/browser-tools/tools/wait.ts
  - src/resources/extensions/browser-tools/tools/pages.ts
  - src/resources/extensions/browser-tools/index.ts
key_decisions:
  - "Tool files import state accessors directly from ../state.ts for mutable state reads/writes (e.g. getConsoleLogs/setConsoleLogs) — not through ToolDeps"
  - "Tool files import core.js functions directly where needed (diffCompactStates, evaluateAssertionChecks, etc.) — ToolDeps carries only infrastructure functions that need lifecycle wiring"
  - "readFocusedDescriptor imported directly from settle.ts by interaction.ts (browser_key_press) — it's a pure function, no deps wiring needed"
  - "ensureDir imported from utils.ts by session.ts for debug bundle directory creation"
patterns_established:
  - "Each tool file exports a single registerXTools(pi, deps) function — consistent API for all 9 modules"
  - "Tool files never import from each other — only from state.ts, utils.ts, settle.ts, core.js, and external packages"
  - "Index.ts builds ToolDeps object once and passes to all 9 register functions — single wiring point"
observability_surfaces:
  - none
duration: ~25 minutes
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T03: Extract tool registrations into grouped files and create slim index.ts

**Moved all 43 tool registrations from monolithic index.ts into 9 categorized tool files under tools/, rewrote index.ts as a 47-line orchestrator.**

## What Happened

Extracted every tool registration from the ~5000-line monolithic index.ts into 9 focused files under `tools/`:
- navigation.ts (4): navigate, go_back, go_forward, reload
- screenshot.ts (1): screenshot
- interaction.ts (10): click, drag, type, upload_file, scroll, hover, key_press, select_option, set_checked, set_viewport
- inspection.ts (7): get_console_logs, get_network_logs, get_dialog_logs, evaluate, get_accessibility_tree, find, get_page_source
- session.ts (7): close, trace_start, trace_stop, export_har, timeline, session_summary, debug_bundle
- assertions.ts (3): assert, diff, batch
- refs.ts (5): snapshot_refs, get_ref, click_ref, hover_ref, fill_ref
- wait.ts (1): wait_for
- pages.ts (5): list_pages, switch_page, close_page, list_frames, select_frame

Each tool's execute function body is verbatim from the original. All closure variable accesses were converted to state accessor imports (getConsoleLogs/setConsoleLogs pattern) and all infrastructure function calls go through the deps parameter.

Index.ts was fully rewritten as a slim orchestrator that imports all 9 register functions, builds the ToolDeps object, and calls each register function. It also hooks session_shutdown.

## Verification

- `grep -rc "pi.registerTool" tools/` sums to 43 ✓
- `wc -l index.ts` = 47 (under 50) ✓
- `grep "pi.registerTool" index.ts` returns 0 matches ✓
- Extension loads via jiti without error ✓
- Mock registration test confirms all 43 tool names match expected set ✓

Slice-level checks:
- Extension loads via jiti: PASS ✓
- Registered tools === 43: PASS ✓
- Browser integration tests (navigate, snapshot_refs, click, window.__pi): deferred to T04 (requires running browser)

## Diagnostics

None — these are structural extraction files. The tools themselves retain all their original diagnostic behavior (error screenshots, verification summaries, etc.).

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/browser-tools/tools/navigation.ts` — 4 navigation tools (navigate, go_back, go_forward, reload)
- `src/resources/extensions/browser-tools/tools/screenshot.ts` — 1 screenshot tool
- `src/resources/extensions/browser-tools/tools/interaction.ts` — 10 interaction tools (click, drag, type, etc.)
- `src/resources/extensions/browser-tools/tools/inspection.ts` — 7 inspection tools (console logs, evaluate, find, etc.)
- `src/resources/extensions/browser-tools/tools/session.ts` — 7 session management tools (close, traces, HAR, etc.)
- `src/resources/extensions/browser-tools/tools/assertions.ts` — 3 assertion tools (assert, diff, batch)
- `src/resources/extensions/browser-tools/tools/refs.ts` — 5 ref management tools (snapshot, get, click, hover, fill)
- `src/resources/extensions/browser-tools/tools/wait.ts` — 1 wait tool
- `src/resources/extensions/browser-tools/tools/pages.ts` — 5 page/frame management tools
- `src/resources/extensions/browser-tools/index.ts` — Slim 47-line orchestrator (was ~5000 lines)
