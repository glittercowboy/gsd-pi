---
id: S04
parent: M001
milestone: M001
provides:
  - RuntimeError interface with source/severity/message/blocking fields
  - captureRuntimeErrors() async function scanning bg-shell processes and browser console
  - D004 severity classification implemented — crashes block, warnings log
  - runtimeErrors optional field on VerificationResult
  - EvidenceJSON extended with optional runtimeErrors array
  - Markdown evidence table gains "Runtime Errors" section
  - Gate block in auto.ts overrides result.passed on blocking runtime errors
requires:
  - slice: S01
    provides: VerificationResult interface, runVerificationGate() function, gate block in auto.ts handleAgentEnd
  - slice: S02
    provides: EvidenceJSON interface, formatEvidenceTable(), writeVerificationJSON()
affects:
  - S05
key_files:
  - src/resources/extensions/gsd/types.ts
  - src/resources/extensions/gsd/verification-gate.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/verification-evidence.ts
  - src/resources/extensions/gsd/tests/verification-gate.test.ts
  - src/resources/extensions/gsd/tests/verification-evidence.test.ts
key_decisions:
  - Dependency injection via CaptureRuntimeErrorsOptions for testability instead of module mocking
  - Runtime errors omitted from JSON when absent or empty (clean output for passing tasks)
  - Message truncated to 100 chars in markdown table, full text preserved in JSON
  - Additive optional field keeps schemaVersion at 1 (per D002)
patterns_established:
  - Dynamic import with try/catch for optional extension dependencies (bg-shell, browser-tools)
  - Injectable getProcesses/getConsoleLogs overrides for unit testing async capture functions
  - Conditionally mutating the gate result object after capture (result.runtimeErrors = ...; result.passed = false)
observability_surfaces:
  - RuntimeError[] return value from captureRuntimeErrors() with source/severity/message/blocking per error
  - T##-VERIFY.json gains optional runtimeErrors array (present only when errors exist)
  - Markdown evidence table gains "Runtime Errors" section with Source/Severity/Blocking/Message columns
  - stderr line "verification-gate: N blocking runtime error(s) detected" during auto-mode
drill_down_paths:
  - .gsd/milestones/M001/slices/S04/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S04/tasks/T02-SUMMARY.md
duration: 30m
verification_result: passed
completed_at: 2026-03-17
---

# S04: Runtime Error Capture

**Server crashes and unhandled rejections from bg-shell processes now block the verification gate; browser console.error and deprecation warnings are logged in evidence without blocking**

## What Happened

T01 defined the `RuntimeError` interface in `types.ts` (source, severity, message, blocking) and implemented `captureRuntimeErrors()` in `verification-gate.ts`. The function dynamically imports bg-shell's process registry and browser-tools' console log API, classifying errors per D004: bg-shell crashes/non-zero exits and browser unhandled rejections are blocking (crash severity); browser console.error is non-blocking (error severity); browser deprecation warnings are non-blocking (warning severity). The function gracefully returns `[]` when either extension is unavailable, using try/catch around dynamic imports. A dependency injection pattern (`CaptureRuntimeErrorsOptions`) enables testing without complex module mocking. 14 unit tests cover all 7 severity classes, graceful degradation, text truncation to 500 chars, and mixed-source scenarios.

T02 wired `captureRuntimeErrors()` into the live verification flow. In `auto.ts` handleAgentEnd, after `runVerificationGate()` completes, runtime errors are captured and merged into the result. Any blocking runtime error overrides `result.passed = false` — a crashed dev server now fails the gate even when all typecheck/lint/test commands passed. Blocking errors are logged to stderr with source and count. The evidence format was extended: `EvidenceJSON` gained an optional `runtimeErrors` array (omitted when empty, keeping output clean for passing tasks), and `formatEvidenceTable()` appends a "Runtime Errors" section with Source/Severity/Blocking/Message columns. Messages are truncated to 100 chars in the table but preserved in full in JSON. 6 additional tests cover JSON inclusion/omission, markdown rendering, and message truncation.

## Verification

- `npm run test:unit -- --test-name-pattern "verification-gate"` — all 42 tests pass (28 existing + 14 new runtime error tests)
- `npm run test:unit -- --test-name-pattern "verification-evidence"` — all 20 tests pass (14 existing + 6 new runtime error evidence tests)
- `npm run test:unit` — 1088 pass, 8 fail (all 8 pre-existing: chokidar/octokit missing packages, not related to this slice)
- `grep -n "captureRuntimeErrors" auto.ts` — 1 import (line 23) + 1 call site (line 1530)
- `grep -n "runtimeErrors" types.ts` — RuntimeError interface (line 61) + field on VerificationResult (line 74)
- `grep -n "runtimeErrors" verification-evidence.ts` — RuntimeErrorJSON interface, EvidenceJSON field, writeVerificationJSON conditional write, formatEvidenceTable section rendering

## Requirements Advanced

- R006 — Runtime error capture fully implemented. bg-shell process scanning detects crashed status, non-zero exits, fatal signals (SIGABRT/SIGSEGV/SIGBUS), and alive processes with recentErrors. Browser console scanning captures errors and warnings. Both sources feed into verification evidence.
- R007 — Severity classification fully implemented per D004. Crashes and unhandled rejections block the gate. Console.error and deprecation warnings logged in evidence without blocking. Gate override logic in auto.ts flips `result.passed = false` on any blocking error.

## Requirements Validated

- R006 — Contract tests prove bg-shell crash detection (crashed status, non-zero exit, fatal signal, recentErrors) and browser console capture (errors, warnings, unhandled rejections). Integration point in auto.ts confirmed via grep. Graceful degradation when extensions unavailable tested.
- R007 — Contract tests prove severity classification: 7 distinct severity classes tested. Blocking behavior (crash/unhandled rejection → blocks) and non-blocking behavior (console.error/deprecation → logs only) verified in unit tests. Gate override in auto.ts confirmed.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

- T01 added 14 tests instead of planned 10 — extra coverage for case-insensitive UnhandledRejection detection, non-deprecation warning filtering, recentErrors truncation to 3, and mixed source scenarios. No negative impact.

## Known Limitations

- Runtime error capture depends on bg-shell and browser-tools extensions being loaded — when unavailable, `captureRuntimeErrors()` silently returns `[]` (by design, for graceful degradation, but means no capture in extension-less environments)
- bg-shell `recentErrors` are limited to the 3 most recent per process (bg-shell's own limit) — earlier errors in a long-running process may be missed
- Browser console text is truncated to 500 chars per entry — very long stack traces in console will be clipped in evidence

## Follow-ups

- none

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — Added RuntimeError interface and optional runtimeErrors field on VerificationResult
- `src/resources/extensions/gsd/verification-gate.ts` — Added captureRuntimeErrors() async function, CaptureRuntimeErrorsOptions interface, buildBgShellMessage helper
- `src/resources/extensions/gsd/auto.ts` — Added captureRuntimeErrors import, call after runVerificationGate(), blocking error override, stderr logging
- `src/resources/extensions/gsd/verification-evidence.ts` — Added RuntimeErrorJSON interface, runtimeErrors on EvidenceJSON, conditional write in writeVerificationJSON, Runtime Errors section in formatEvidenceTable
- `src/resources/extensions/gsd/tests/verification-gate.test.ts` — Added 14 new unit tests for runtime error capture
- `src/resources/extensions/gsd/tests/verification-evidence.test.ts` — Added 6 new tests for runtime error evidence format

## Forward Intelligence

### What the next slice should know
- The verification gate pipeline in auto.ts now has three stages: (1) `runVerificationGate()` runs commands, (2) `captureRuntimeErrors()` scans bg-shell/browser, (3) evidence is written. S05's npm audit step should slot into this pipeline between stages 1 and 2, or as an additional capture step alongside stage 2. The result object is mutated in-place — S05 can add fields the same way S04 added `runtimeErrors`.
- `VerificationResult` is now extended twice (S02 added evidence fields, S04 added runtimeErrors). S05 should add audit results as another optional field following the same pattern.
- `EvidenceJSON` schema version remains 1 — additive optional fields don't require a version bump per D002.

### What's fragile
- The dynamic import pattern in `captureRuntimeErrors()` uses `import("../bg-shell/index.js")` — if bg-shell's module structure changes, the import path will break silently (returns `[]` instead of erroring). This is by-design graceful degradation but means broken imports won't surface as test failures unless specifically tested.
- The gate override in auto.ts (~line 1534) mutates `result.passed` directly. Multiple capture stages all mutating the same boolean works now but could get confusing if more stages are added.

### Authoritative diagnostics
- `T##-VERIFY.json` `runtimeErrors` array — present only when runtime errors were captured, absent for clean runs. `jq '.runtimeErrors[] | select(.blocking)' *-VERIFY.json` finds blocking errors across tasks.
- stderr during auto-mode: `verification-gate: N blocking runtime error(s) detected` confirms the gate override fired.

### What assumptions changed
- Assumed bg-shell module mocking would be needed — instead, dependency injection via options parameter was cleaner and more testable (CaptureRuntimeErrorsOptions pattern). This pattern should be reused for any future capture functions.
