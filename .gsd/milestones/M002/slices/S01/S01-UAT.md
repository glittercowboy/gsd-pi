# S01: Module decomposition and shared evaluate utilities — UAT

**Milestone:** M002
**Written:** 2026-03-12

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This is a pure structural refactoring — no user-facing behavior changed. All verification is against build success, tool registration counts, and runtime code paths. No human judgment needed.

## Preconditions

- Node.js available with `@mariozechner/jiti` installed
- Repository is at the post-split state (index.ts is the 47-line orchestrator)

## Smoke Test

Run `node /tmp/gsd-verify-s01.cjs` (or equivalent jiti load of index.ts) — should print `typeof ext.default: function` and `Registered tools count: 43`.

## Test Cases

### 1. Extension loads via jiti

1. Load `src/resources/extensions/browser-tools/index.ts` through jiti
2. **Expected:** `typeof ext.default` === `"function"`, no errors

### 2. All 43 tools register

1. Call `ext.default(mockPi)` with a mock that captures `registerTool` calls
2. Count registered tool names
3. **Expected:** Exactly 43 tools registered

### 3. Index.ts is a slim orchestrator

1. `wc -l src/resources/extensions/browser-tools/index.ts`
2. `grep -c "pi.registerTool" src/resources/extensions/browser-tools/index.ts`
3. **Expected:** Under 50 lines, zero registerTool calls in index.ts

### 4. Tool distribution across 9 files

1. `grep -rc "pi.registerTool" src/resources/extensions/browser-tools/tools/`
2. **Expected:** Sum is 43 across 9 files (navigation:4, screenshot:1, interaction:10, inspection:7, session:7, assertions:3, refs:5, wait:1, pages:5)

### 5. No inline redeclarations of shared functions in refs.ts

1. `grep -c "function cssPath\|function simpleHash\|function isVisible\|function isEnabled\|function inferRole\|function accessibleName" src/resources/extensions/browser-tools/refs.ts`
2. **Expected:** 0

### 6. addInitScript injection wired in lifecycle.ts

1. `grep "addInitScript" src/resources/extensions/browser-tools/lifecycle.ts`
2. **Expected:** Contains `context.addInitScript(EVALUATE_HELPERS_SOURCE)`

### 7. EVALUATE_HELPERS_SOURCE contains all 9 functions

1. Load evaluate-helpers.ts, check EVALUATE_HELPERS_SOURCE includes: cssPath, simpleHash, isVisible, isEnabled, inferRole, accessibleName, isInteractiveEl, domPath, selectorHints
2. **Expected:** All 9 present

### 8. Browser tools work against a real page

1. Start pi with the split extension loaded
2. Run browser_navigate to any page
3. Run browser_snapshot_refs
4. Run browser_click_ref on a returned ref
5. **Expected:** All three succeed without error

## Edge Cases

### Close/reopen cycle

1. Call closeBrowser()
2. Call ensureBrowser() again
3. Check window.__pi is available on the new context
4. **Expected:** addInitScript re-registers on fresh context, window.__pi available

## Failure Signals

- `typeof ext.default` !== "function" — module split broke the export
- Tool count !== 43 — tools lost during extraction
- Any `require` or `import` error during jiti load — circular dependency or missing export
- window.__pi missing after ensureBrowser — addInitScript not wired
- browser_navigate/snapshot_refs/click_ref failing — tool wiring broken

## Requirements Proved By This UAT

- R015 — Module decomposition verified by build success, tool count, slim index
- R016 — Shared evaluate utilities verified by addInitScript presence, window.__pi injection, zero inline redeclarations

## Not Proven By This UAT

- Performance improvements (S02)
- sharp-based screenshot resizing (S03)
- Form intelligence tools (S04)
- Intent-ranked retrieval and semantic actions (S05)
- Test coverage (S06)

## Notes for Tester

All test cases are agent-executable — no human gut check needed. This is a structural refactoring with no visible behavior change. The key risk was module split regression, which is fully covered by the tool count and runtime verification.
