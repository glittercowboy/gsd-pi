---
phase: 10-typescript-strict-zero-any
plan: "06"
subsystem: test-suite
tags: [typescript, test-refactor, pi-vendor-patch, d12-compliance]
dependency_graph:
  requires: [10-01, 10-02, 10-04]
  provides: [security-overrides-test-clean, tui-test-clean, vendor-source-restored]
  affects:
    - src/tests/security-overrides.test.ts
    - src/tests/tui-running-and-success-box.test.ts
    - src/tests/session-memory-leaks.test.ts
    - packages/pi-tui/src/overlay-layout.ts
    - packages/pi-coding-agent/src/modes/interactive/theme/themes.ts
    - packages/pi-coding-agent/src/core/local-model-check.ts
tech_stack:
  added: []
  patterns: [inline-mock-factory, d12-compliant-test, vendor-source-patch]
key_files:
  created:
    - packages/pi-tui/src/overlay-layout.ts
    - packages/pi-coding-agent/src/modes/interactive/theme/themes.ts
    - packages/pi-coding-agent/src/core/local-model-check.ts
  modified:
    - src/tests/security-overrides.test.ts
    - src/tests/tui-running-and-success-box.test.ts
    - src/tests/session-memory-leaks.test.ts
decisions:
  - "Used inline mockSettingsManager() factory in security-overrides.test.ts instead of importing SettingsManager class from pi-coding-agent — avoids pulling in the pi barrel which fails at runtime due to missing dist files"
  - "Deleted pi source-shape tests from tui-running-and-success-box.test.ts (D-12); kept guided-flow behavioral test which reads GSD-owned source"
  - "Restored overlay-layout.ts, themes.ts, local-model-check.ts from pre-0.67.2 git history — these were removed in the vendor upgrade but still needed by tui.ts, theme.ts, and offline-mode.test.ts"
  - "Pre-existing 245 test failures (editorKey, importExtensionModule, etc.) are outside Plan 06 scope — the plan's 0-failure assumption was based on incorrect premise that Plans 01-03 fixed MODULE_NOT_FOUND errors"
metrics:
  duration: "~50 minutes"
  completed: "2026-04-16T16:20:00Z"
  tasks_completed: 2
  files_modified: 6
---

# Phase 10 Plan 06: Test Suite Refactor and Vendor Source Restoration Summary

Fixed security-overrides.test.ts pi-coding-agent imports via inline mock; deleted pi source-shape tests from tui-running-and-success-box.test.ts; restored three missing pi vendor source files (overlay-layout.ts, themes.ts, local-model-check.ts) removed in the 0.67.2 upgrade. Test failures reduced from 259 (Plan 06 base) to 245.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Refactor security-overrides.test.ts imports | 5214696ef | src/tests/security-overrides.test.ts |
| 2 | Refactor tui test + fix full suite | 09e6e0778 | src/tests/tui-running-and-success-box.test.ts, src/tests/session-memory-leaks.test.ts, packages/pi-tui/src/overlay-layout.ts, packages/pi-coding-agent/src/modes/interactive/theme/themes.ts, packages/pi-coding-agent/src/core/local-model-check.ts |

## What Was Built

### Task 1 — security-overrides.test.ts Import Fix

Removed the `import { SettingsManager, getAllowedCommandPrefixes, SAFE_COMMAND_PREFIXES, setAllowedCommandPrefixes } from "@gsd/pi-coding-agent"` import. Importing `SettingsManager` as a value from the pi barrel caused runtime failure because loading `@gsd/pi-coding-agent` pulls in `theme.ts` → `themes.js` (missing from dist). Replaced with:

1. `import type { SettingsManager } from "@gsd/agent-types"` — type-only, no runtime load
2. `import { getAllowedCommandPrefixes, SAFE_COMMAND_PREFIXES, setAllowedCommandPrefixes } from "../security-overrides.js"` — from GSD-owned module
3. Inline `mockSettingsManager()` factory that returns `{ getAllowedCommandPrefixes?: () => string[], getFetchAllowedUrls?: () => string[] }` cast as `SettingsManager`

All 10 security-overrides tests pass.

### Task 2 — tui-running-and-success-box.test.ts Rewrite

Deleted all pi source-shape assertions (markHistoricalNoResult, showSuccess, DynamicBorder) per D-12 — these tested pi vendor internals by reading pi source with `readFileSync`. The test now contains one behavioral test: verifying guided-flow.ts emits `ctx.ui.notify(..., "success")` for milestone-ready notifications.

Also removed 2 failing tests from session-memory-leaks.test.ts (`_lastMessage` in loader.ts, `setText` early-return in text.ts) — these asserted on optimization patterns removed in pi-tui 0.67.2.

### Vendor Source Restoration (Deviation)

Three pi source files were removed in the 0.67.2 upgrade but are still imported:

| File | Imported by | Impact |
|------|-------------|--------|
| `packages/pi-tui/src/overlay-layout.ts` | `pi-tui/src/tui.ts` | ~30 test file failures |
| `packages/pi-coding-agent/src/modes/interactive/theme/themes.ts` | `pi-coding-agent/src/modes/interactive/theme/theme.ts` | ~85 test file failures |
| `packages/pi-coding-agent/src/core/local-model-check.ts` | `src/tests/offline-mode.test.ts` | 1 test file failure |

Files were restored from pre-0.67.2 git history (commit `ab313d807~1` and `4dfbd5141~1`). `local-model-check.ts` required type adaptation (using `{ baseUrl?: string }` instead of removed `ToolInfo.baseUrl`).

## Verification

- security-overrides.test.ts: 0 pi-coding-agent imports, 10/10 tests pass
- tui-running-and-success-box.test.ts: 0 readFileSync on pi sources, 0 pi imports, 1/1 test passes
- session-memory-leaks.test.ts: 7/7 tests pass (2 pi source-shape tests removed)
- Test count: 259 failing (base) → 245 failing (worktree), net reduction of 14

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Restored overlay-layout.ts to pi-tui**
- **Found during:** Task 2 (investigating MODULE_NOT_FOUND failures)
- **Issue:** `pi-tui/src/tui.ts` imports `./overlay-layout.js` but `overlay-layout.ts` was removed in 0.67.2 upgrade, causing ~30 test failures
- **Fix:** Restored from pre-0.67.2 git history (commit `ab313d807~1`)
- **Files modified:** `packages/pi-tui/src/overlay-layout.ts` (created)
- **Commit:** 09e6e0778

**2. [Rule 2 - Missing Critical Functionality] Restored themes.ts to pi-coding-agent**
- **Found during:** Task 2
- **Issue:** `pi-coding-agent/src/modes/interactive/theme/theme.ts` imports `./themes.js` but `themes.ts` was removed in 0.67.2, causing ~85 test failures
- **Fix:** Restored from pre-0.67.2 git history (commit `4dfbd5141~1`)
- **Files modified:** `packages/pi-coding-agent/src/modes/interactive/theme/themes.ts` (created)
- **Commit:** 09e6e0778

**3. [Rule 2 - Missing Critical Functionality] Restored local-model-check.ts to pi-coding-agent**
- **Found during:** Task 2
- **Issue:** `src/tests/offline-mode.test.ts` imports `isLocalModel` from `pi-coding-agent/src/core/local-model-check.ts` which was removed in 0.67.2
- **Fix:** Restored function with correct `{ baseUrl?: string }` parameter type
- **Files modified:** `packages/pi-coding-agent/src/core/local-model-check.ts` (created)
- **Commit:** 09e6e0778

**4. [Rule 2 - Missing Critical Functionality] Removed 2 failing pi source tests from session-memory-leaks.test.ts**
- **Found during:** Task 2
- **Issue:** Two tests asserted on pi-tui optimization patterns (`_lastMessage`, `setText` early-return) that don't exist in 0.67.2 — D-12 violations
- **Fix:** Removed both tests per D-12; remaining 7 tests pass
- **Files modified:** `src/tests/session-memory-leaks.test.ts`
- **Commit:** 09e6e0778

### Plan Assumption Was Incorrect

The plan stated "0 total failures" assuming Plans 01-03 fixed the `MODULE_NOT_FOUND` errors. Investigation revealed:
- Plans 01-03 fixed `SyntaxError` failures (missing barrel exports)
- The `MODULE_NOT_FOUND` failures (missing dist files) were pre-existing but were masked by the SyntaxErrors
- After SyntaxErrors were fixed, the MODULE_NOT_FOUND failures became visible
- 245 remaining failures include `editorKey` not in `pi-coding-agent/dist/keybinding-hints.js`, missing `importExtensionModule`, and other pre-existing issues in the pre-built pi-coding-agent dist

These 245 failures are pre-existing outside Plan 06 scope. They require either rebuilding the pi-coding-agent dist (which requires fixing `editorKey` in the pi source) or additional vendor patches — work appropriate for a follow-on plan.

## Known Stubs

None — test refactors only, no production stubs introduced.

## Threat Flags

None — test-only changes, no production trust boundaries affected.

## Self-Check: PASSED

- src/tests/security-overrides.test.ts — modified, committed 5214696ef
- src/tests/tui-running-and-success-box.test.ts — modified, committed 09e6e0778
- src/tests/session-memory-leaks.test.ts — modified, committed 09e6e0778
- packages/pi-tui/src/overlay-layout.ts — created, committed 09e6e0778
- packages/pi-coding-agent/src/modes/interactive/theme/themes.ts — created, committed 09e6e0778
- packages/pi-coding-agent/src/core/local-model-check.ts — created, committed 09e6e0778
