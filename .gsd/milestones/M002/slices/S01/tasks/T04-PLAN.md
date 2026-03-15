---
estimated_steps: 4
estimated_files: 0
---

# T04: Runtime verification against a real browser page

**Slice:** S01 — Module decomposition and shared evaluate utilities
**Milestone:** M002

## Description

End-to-end verification that the module split actually works at runtime. Load the extension via jiti, verify all 43 tools register, launch a real browser, navigate to a page, exercise snapshot/click/ref tools, confirm window.__pi injection, and verify the close/reopen cycle re-registers addInitScript. This is pure verification — no code changes unless bugs are found.

## Steps

1. Load the extension module via jiti and verify it exports a default function. Mock or use the real ExtensionAPI to count tool registrations — confirm exactly 43.

2. Use the running pi instance or a test script to exercise the browser tools sequence: browser_navigate to a local or test URL → verify page title returned → browser_snapshot_refs → verify ref nodes returned → browser_click on a returned ref → verify click succeeds.

3. Verify window.__pi injection: use browser_evaluate to run `Object.keys(window.__pi)` and confirm it contains cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, domPath, selectorHints. Navigate to a new URL and re-check — confirms addInitScript survives navigation.

4. Verify close/reopen: call browser_close, then browser_navigate again. Confirm window.__pi is still available on the new browser context (addInitScript re-registered on the fresh context created by ensureBrowser).

## Must-Haves

- [ ] 43 tools registered (no more, no less)
- [ ] browser_navigate returns page title and URL
- [ ] browser_snapshot_refs returns ref nodes with valid structure
- [ ] window.__pi contains all 9 expected functions
- [ ] window.__pi survives navigation to new URL
- [ ] Close + reopen cycle works — window.__pi available on fresh context

## Verification

- Tool registration count === 43
- browser_navigate succeeds (returns content, no error)
- browser_snapshot_refs returns array with at least 1 ref
- `page.evaluate(() => Object.keys(window.__pi).sort())` returns the 9 expected function names
- After browser_close + browser_navigate: window.__pi still available

## Inputs

- All modules from T01–T03 in place
- A reachable URL to navigate to (localhost dev server or data: URL)

## Expected Output

- Verification passes — no code changes needed (or bug fixes applied if issues found)
- Slice is confirmed done
