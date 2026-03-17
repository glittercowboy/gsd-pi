---
estimated_steps: 6
estimated_files: 3
---

# T01: Implement RuntimeError type and captureRuntimeErrors function with tests

**Slice:** S04 — Runtime Error Capture
**Milestone:** M001

## Description

Build the core runtime error capture engine. Define the `RuntimeError` interface in `types.ts`, extend `VerificationResult` with an optional `runtimeErrors` field, and implement `captureRuntimeErrors()` in `verification-gate.ts`. The function uses dynamic `import()` to scan bg-shell's `processes` Map for crashed/failed processes and browser-tools' `getConsoleLogs()` for console errors/warnings. Severity classification follows D004.

This is the foundational logic — T02 wires it into the gate and evidence format.

## Steps

1. **Add `RuntimeError` interface to `types.ts`** — Insert after the `VerificationResult` interface (~line 67). Fields:
   ```ts
   export interface RuntimeError {
     source: "bg-shell" | "browser";
     severity: "crash" | "error" | "warning";
     message: string;
     blocking: boolean;
   }
   ```
   Add `runtimeErrors?: RuntimeError[]` as an optional field on `VerificationResult`. This must be optional so all existing code (tests, verification-gate.ts) continues to compile without changes.

2. **Implement `captureRuntimeErrors()` in `verification-gate.ts`** — Add an exported async function at the end of the file. The function:

   a. **Scans bg-shell processes** via dynamic import:
   ```ts
   try {
     const { processes } = await import("../bg-shell/process-manager.js");
     for (const [id, proc] of processes) {
       // status === "crashed" → blocking crash
       // !alive && exitCode !== 0 && exitCode !== null → blocking crash
       // signal is SIGABRT/SIGSEGV/SIGBUS → blocking crash
       // alive && recentErrors.length > 0 → non-blocking error (log only)
     }
   } catch { /* bg-shell not available — skip */ }
   ```
   
   For crashed/exited-with-error processes, build the message from the process label/id, exit code, signal, and up to 3 `recentErrors` lines. For alive processes with `recentErrors`, classify as severity "error", non-blocking.

   b. **Scans browser console logs** via dynamic import:
   ```ts
   try {
     const { getConsoleLogs } = await import("../browser-tools/state.js");
     const logs = getConsoleLogs();
     for (const entry of logs) {
       // type === "error" with text containing "Unhandled" or "UnhandledRejection" → blocking crash
       // type === "error" (general) → non-blocking error
       // type === "warning" with deprecation pattern → non-blocking warning
     }
   } catch { /* browser-tools not available — skip */ }
   ```
   
   Truncate browser console entry `text` to 500 characters. Deprecation detection: check for text containing "deprecated" (case-insensitive). Only capture `type === "warning"` entries that match the deprecation pattern (ignore non-deprecation warnings).

   c. Returns `RuntimeError[]`.

3. **Severity classification reference (D004):**
   | Signal | Severity | Blocking? |
   |--------|----------|-----------|
   | bg-shell `status === "crashed"` | crash | Yes |
   | bg-shell `!alive && exitCode !== 0 && exitCode !== null` | crash | Yes |
   | bg-shell `signal` is SIGABRT/SIGSEGV/SIGBUS | crash | Yes |
   | Browser console error with "Unhandled"/"UnhandledRejection" | crash | Yes |
   | Browser console `type === "error"` (general) | error | No |
   | Browser console `type === "warning"` with deprecation text | warning | No |
   | bg-shell `recentErrors[]` on alive processes | error | No |

4. **Write unit tests in `tests/verification-gate.test.ts`** — Append new tests after existing ones. Since `captureRuntimeErrors()` uses dynamic `import()`, tests must mock the modules. Approach: use `node:test`'s `mock.module()` if available (Node 22+), or restructure the function to accept injected dependencies for testability. The pragmatic approach: make `captureRuntimeErrors` accept an optional `options` parameter with `getProcesses` and `getConsoleLogs` overrides for testing:

   ```ts
   export interface CaptureRuntimeErrorsOptions {
     getProcesses?: () => Map<string, unknown>;
     getConsoleLogs?: () => Array<{ type: string; text: string; timestamp: number; url: string }>;
   }
   ```

   When options are not provided, the function uses dynamic imports (production path). When provided, it uses the injected functions (test path). This avoids complex module mocking.

   Tests to write:
   - `captureRuntimeErrors: crashed bg-shell process → blocking crash error`
   - `captureRuntimeErrors: bg-shell non-zero exit + not alive → blocking crash error`
   - `captureRuntimeErrors: bg-shell SIGABRT/SIGSEGV/SIGBUS → blocking crash error`
   - `captureRuntimeErrors: alive bg-shell process with recentErrors → non-blocking error`
   - `captureRuntimeErrors: browser unhandled rejection → blocking crash error`
   - `captureRuntimeErrors: browser console.error (general) → non-blocking error`
   - `captureRuntimeErrors: browser deprecation warning → non-blocking warning`
   - `captureRuntimeErrors: no processes, no browser logs → empty array`
   - `captureRuntimeErrors: dynamic import failure → graceful empty array` (test by passing `getProcesses` that throws)
   - `captureRuntimeErrors: browser text truncated to 500 chars`

5. **Verify compilation** — Run `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` to confirm the file compiles.

6. **Run all verification-gate tests** — `npm run test:unit -- --test-name-pattern "verification-gate"` must pass (all 28 existing + ~10 new tests).

## Must-Haves

- [ ] `RuntimeError` interface in `types.ts` with `source`, `severity`, `message`, `blocking` fields
- [ ] `runtimeErrors?: RuntimeError[]` optional field on `VerificationResult` (backward compatible)
- [ ] `captureRuntimeErrors()` exported async function in `verification-gate.ts`
- [ ] Dynamic `import()` for bg-shell `processes` and browser-tools `getConsoleLogs` with try/catch fallback
- [ ] D004 severity classification implemented correctly for all 7 signal types
- [ ] Browser console `text` truncated to 500 chars
- [ ] Injectable dependencies for testability (options parameter with `getProcesses`/`getConsoleLogs`)
- [ ] 10+ new unit tests covering all severity classes and graceful degradation
- [ ] All existing verification-gate tests still pass (28 tests)

## Verification

- `npm run test:unit -- --test-name-pattern "verification-gate"` — all tests pass (28 existing + new)
- `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` — compiles cleanly
- `grep -n "RuntimeError" src/resources/extensions/gsd/types.ts` — shows interface and field on VerificationResult
- `grep -n "captureRuntimeErrors" src/resources/extensions/gsd/verification-gate.ts` — shows export

## Inputs

- `src/resources/extensions/gsd/types.ts` — existing `VerificationResult` interface (line ~61) to extend
- `src/resources/extensions/gsd/verification-gate.ts` — existing file to add `captureRuntimeErrors()` to
- `src/resources/extensions/gsd/tests/verification-gate.test.ts` — existing 28 tests to preserve; append new tests
- `src/resources/extensions/bg-shell/types.ts` — `BgProcess` interface reference (fields: `status`, `alive`, `exitCode`, `signal`, `recentErrors`, `label`, `id`)
- `src/resources/extensions/browser-tools/state.ts` — `ConsoleEntry` interface reference (fields: `type`, `text`, `timestamp`, `url`)

## Expected Output

- `src/resources/extensions/gsd/types.ts` — has `RuntimeError` interface and `runtimeErrors?` field on `VerificationResult`
- `src/resources/extensions/gsd/verification-gate.ts` — has `captureRuntimeErrors()` async function with dynamic imports and D004 classification
- `src/resources/extensions/gsd/tests/verification-gate.test.ts` — has ~10 new tests covering runtime error capture
