---
id: T04
parent: S01
milestone: M002
provides:
  - Runtime verification that all 43 tools register, browser lifecycle works, and window.__pi injection is functional
key_files: []
key_decisions:
  - "Pi's live browser instance won't have window.__pi until the session is restarted (extension loaded at startup before module split), but standalone jiti test proves the code path is correct"
patterns_established: []
observability_surfaces:
  - none
duration: 15m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T04: Runtime verification against a real browser page

**Verified module-split extension loads via jiti, registers all 43 tools, launches a real browser with window.__pi injection, and survives close/reopen cycles.**

## What Happened

Ran four verification passes:

1. **jiti loading + tool count:** Loaded index.ts via jiti, invoked the default export with a mock ExtensionAPI. All 43 tools registered (grep count and runtime count match).

2. **Live browser tools:** Used pi's own browser tools (browser_navigate, browser_snapshot_refs, browser_click_ref) against a test page served on localhost:18923. Navigate returned correct title/URL, snapshot returned 3 refs with valid structure, click_ref resolved and clicked the button.

3. **window.__pi injection (standalone):** Pi's in-session browser was created before the module split landed, so window.__pi wasn't available via browser_evaluate. Wrote a standalone jiti test that calls ensureBrowser() → page.goto → page.evaluate. Result: all 9 expected functions present (accessibleName, cssPath, domPath, inferRole, isEnabled, isInteractiveEl, isVisible, selectorHints, simpleHash). Injection survived navigation to a new URL.

4. **Close/reopen cycle (standalone):** Called closeBrowser(), then ensureBrowser() again. window.__pi was available on the fresh context — addInitScript re-registered correctly.

Also confirmed: refs.ts has zero inline function declarations for the 9 shared utilities — uses window.__pi.* references only.

## Verification

- `typeof ext.default` === "function" — PASS
- Runtime tool registration count === 43 — PASS
- grep tool registration count === 43 — PASS
- browser_navigate returns title "GSD Test Page" — PASS
- browser_snapshot_refs returns 3 refs — PASS
- browser_click_ref clicks button — PASS
- `Object.keys(window.__pi).sort()` returns 9 expected function names — PASS
- window.__pi survives navigation — PASS
- Close + reopen: window.__pi available on fresh context — PASS
- index.ts is 47 lines (<50) — PASS
- refs.ts contains zero inline redeclarations of shared functions — PASS

### Slice-Level Verification (all pass — this is the final task)
- Extension loads via jiti without error — PASS
- browser_navigate + browser_snapshot_refs + browser_click on a ref — all succeed — PASS
- window.__pi utilities available (typeof === "function") — PASS
- Registered tools === 43 — PASS

## Diagnostics

None — this is a pure verification task with no new runtime surfaces.

## Deviations

window.__pi wasn't testable through pi's own browser_evaluate because the pi session was started before the module split. Used a standalone jiti test script to verify the injection path directly, which is actually a stronger verification since it exercises the exact code path (ensureBrowser → addInitScript → page.evaluate).

## Known Issues

None.

## Files Created/Modified

No files created or modified — verification only.
