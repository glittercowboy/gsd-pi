# S04: Runtime Error Capture

**Goal:** Server crashes and unhandled rejections from bg-shell processes appear in verification evidence and block the gate. Console.error and deprecation warnings are logged in evidence but do not block.
**Demo:** After a task completes, the verification gate scans bg-shell processes for crashes (blocking) and browser console for errors/warnings (non-blocking). A crashed bg-shell process fails the gate even if all verification commands passed. Browser console.error entries appear in the evidence table/JSON but don't block.

## Must-Haves

- `RuntimeError` interface defined in `types.ts` with `source`, `severity`, `message`, `blocking` fields
- `captureRuntimeErrors()` async function in `verification-gate.ts` that scans bg-shell processes and browser console logs
- Dynamic `import()` for bg-shell and browser-tools modules — graceful degradation when extensions unavailable
- Severity classification per D004: bg-shell crashes/non-zero exits → blocking; browser unhandled rejections → blocking; browser console.error → non-blocking; browser deprecation warnings → non-blocking
- `VerificationResult` extended with optional `runtimeErrors?: RuntimeError[]` field
- Gate in `auto.ts` calls `captureRuntimeErrors()` and flips `result.passed = false` if any blocking runtime error exists
- `EvidenceJSON` extended with optional `runtimeErrors` array; `formatEvidenceTable` renders runtime error rows
- Browser console entry `text` truncated to 500 chars to prevent unbounded evidence size
- Unit tests for `captureRuntimeErrors()` covering all severity classes and graceful degradation
- All existing tests still pass

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (mocked bg-shell/browser-tools singletons suffice for contract tests)
- Human/UAT required: no

## Verification

- `npm run test:unit -- --test-name-pattern "verification-gate"` — all existing + new runtime error capture tests pass
- `npm run test:unit -- --test-name-pattern "verification-evidence"` — all existing + new runtime error evidence tests pass
- `npm run test:unit` — no new failures introduced (baseline: 1045 pass, 8 pre-existing failures)
- `grep -n "captureRuntimeErrors" src/resources/extensions/gsd/auto.ts` — shows 1 import + 1 call site
- `grep -n "runtimeErrors" src/resources/extensions/gsd/types.ts` — shows RuntimeError interface + field on VerificationResult

## Observability / Diagnostics

- Runtime signals: `runtimeErrors` array in `VerificationResult` with per-error `source`, `severity`, `message`, `blocking` fields
- Inspection surfaces: `T##-VERIFY.json` gains optional `runtimeErrors` array; markdown evidence table gains "Runtime Errors" section
- Failure visibility: blocking runtime errors flip `result.passed = false` and surface in stderr + `ctx.ui.notify()` in auto.ts
- Redaction constraints: bg-shell `recentErrors` may contain environment info; truncation at 200 chars/line (already enforced by bg-shell) limits exposure

## Integration Closure

- Upstream surfaces consumed: `VerificationResult` from `types.ts` (S01), `EvidenceJSON`/`formatEvidenceTable`/`writeVerificationJSON` from `verification-evidence.ts` (S02), gate block in `auto.ts` (S01/S03)
- New wiring introduced in this slice: `captureRuntimeErrors()` call inserted after `runVerificationGate()` in `auto.ts` handleAgentEnd; result merged into `VerificationResult` before evidence writing and retry evaluation
- What remains before the milestone is truly usable end-to-end: S05 (dependency security scan)

## Tasks

- [ ] **T01: Implement RuntimeError type and captureRuntimeErrors function with tests** `est:30m`
  - Why: Core logic for scanning bg-shell processes and browser console logs, classifying errors by severity (D004), and returning structured results. This is the self-contained capture engine that T02 wires into the gate.
  - Files: `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/verification-gate.ts`, `src/resources/extensions/gsd/tests/verification-gate.test.ts`
  - Do: (1) Add `RuntimeError` interface to types.ts with `source: "bg-shell" | "browser"`, `severity: "crash" | "error" | "warning"`, `message: string`, `blocking: boolean`. (2) Add optional `runtimeErrors?: RuntimeError[]` to `VerificationResult`. (3) Implement `captureRuntimeErrors()` in verification-gate.ts using dynamic `import()` for bg-shell `processes` Map and browser-tools `getConsoleLogs()`. (4) Apply D004 severity classification. (5) Truncate browser console text to 500 chars. (6) Write unit tests mocking the module singletons for all severity classes + graceful degradation when imports fail.
  - Verify: `npm run test:unit -- --test-name-pattern "verification-gate"` — all tests pass including new runtime error tests
  - Done when: `captureRuntimeErrors()` is exported, tested for all 7 severity classes from D004, and gracefully returns `[]` when bg-shell/browser-tools are unavailable

- [ ] **T02: Wire runtime errors into gate block and extend evidence format** `est:25m`
  - Why: Integrates the capture function into the live verification flow — calling it from auto.ts, merging results into the gate's pass/fail decision, and persisting runtime errors in both JSON and markdown evidence.
  - Files: `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/verification-evidence.ts`, `src/resources/extensions/gsd/tests/verification-evidence.test.ts`
  - Do: (1) In auto.ts gate block, after `runVerificationGate()` call (~line 1521), add `const runtimeErrors = await captureRuntimeErrors()`. (2) Merge: `result.runtimeErrors = runtimeErrors`. (3) If any `runtimeErrors` has `blocking: true`, set `result.passed = false`. (4) Extend `EvidenceJSON` with optional `runtimeErrors?: { source: string; severity: string; message: string; blocking: boolean }[]`. (5) Update `writeVerificationJSON` to include runtime errors when present. (6) Update `formatEvidenceTable` to append a "Runtime Errors" section with source/severity/message/blocking columns when `result.runtimeErrors` has entries. (7) Add tests for the new evidence fields and table formatting.
  - Verify: `npm run test:unit -- --test-name-pattern "verification-evidence"` — all tests pass; `grep -n "captureRuntimeErrors" src/resources/extensions/gsd/auto.ts` — shows import + call site
  - Done when: Runtime errors appear in T##-VERIFY.json and markdown evidence table; blocking runtime errors cause `result.passed = false` in auto.ts gate evaluation

## Files Likely Touched

- `src/resources/extensions/gsd/types.ts`
- `src/resources/extensions/gsd/verification-gate.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/verification-evidence.ts`
- `src/resources/extensions/gsd/tests/verification-gate.test.ts`
- `src/resources/extensions/gsd/tests/verification-evidence.test.ts`
