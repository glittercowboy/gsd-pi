---
estimated_steps: 5
estimated_files: 3
---

# T02: Wire runtime errors into gate block and extend evidence format

**Slice:** S04 — Runtime Error Capture
**Milestone:** M001

## Description

Integrate `captureRuntimeErrors()` into the live verification flow in `auto.ts` and extend the evidence format (JSON + markdown) to include runtime errors. After this task, runtime errors from bg-shell and browser console appear in T##-VERIFY.json and the markdown evidence table. Blocking runtime errors cause the gate to fail even when all verification commands passed.

## Steps

1. **Wire `captureRuntimeErrors()` into `auto.ts` gate block** — In the verification gate block in `handleAgentEnd` (~line 1499), after the `runVerificationGate()` call (line ~1521) and before the pass/fail notification logic:

   a. Add import at top of file: `import { runVerificationGate, formatFailureContext, captureRuntimeErrors } from "./verification-gate.js";`
   
   b. After `const result = runVerificationGate({...})`, add:
   ```ts
   // Capture runtime errors from bg-shell and browser console
   const runtimeErrors = await captureRuntimeErrors();
   if (runtimeErrors.length > 0) {
     result.runtimeErrors = runtimeErrors;
     // Blocking runtime errors override gate pass
     if (runtimeErrors.some(e => e.blocking)) {
       result.passed = false;
     }
   }
   ```
   
   Note: `handleAgentEnd` is already async, so `await` works. The `result` object from `runVerificationGate()` is a plain object, so mutating it is fine.

   c. Update the notification/logging section to mention runtime errors when present. After the existing failure logging, add for blocking runtime errors:
   ```ts
   if (result.runtimeErrors?.some(e => e.blocking)) {
     const blockingErrors = result.runtimeErrors.filter(e => e.blocking);
     process.stderr.write(`verification-gate: ${blockingErrors.length} blocking runtime error(s) detected\n`);
     for (const err of blockingErrors) {
       process.stderr.write(`  [${err.source}] ${err.severity}: ${err.message.slice(0, 200)}\n`);
     }
   }
   ```

2. **Extend `EvidenceJSON` in `verification-evidence.ts`** — Add an optional field:
   ```ts
   export interface RuntimeErrorJSON {
     source: string;
     severity: string;
     message: string;
     blocking: boolean;
   }
   
   export interface EvidenceJSON {
     // ... existing fields ...
     runtimeErrors?: RuntimeErrorJSON[];
   }
   ```
   The `schemaVersion` stays at `1` — this is an additive (optional) field, not a breaking change (per D002).

3. **Update `writeVerificationJSON`** — After the existing evidence object construction, add:
   ```ts
   if (result.runtimeErrors && result.runtimeErrors.length > 0) {
     evidence.runtimeErrors = result.runtimeErrors.map(e => ({
       source: e.source,
       severity: e.severity,
       message: e.message,
       blocking: e.blocking,
     }));
   }
   ```
   This only adds the field when runtime errors exist, keeping existing JSON output unchanged for clean results.

4. **Update `formatEvidenceTable`** — After the existing check rows table, append a runtime errors section when `result.runtimeErrors` has entries:
   ```ts
   if (result.runtimeErrors && result.runtimeErrors.length > 0) {
     lines.push("");
     lines.push("**Runtime Errors**");
     lines.push("");
     lines.push("| # | Source | Severity | Blocking | Message |");
     lines.push("|---|--------|----------|----------|---------|");
     for (let i = 0; i < result.runtimeErrors.length; i++) {
       const err = result.runtimeErrors[i];
       const blockIcon = err.blocking ? "🚫 yes" : "ℹ️ no";
       lines.push(`| ${i + 1} | ${err.source} | ${err.severity} | ${blockIcon} | ${err.message.slice(0, 100)} |`);
     }
   }
   ```
   Truncate message in the table to 100 chars for readability (full message is in the JSON).

5. **Add tests in `tests/verification-evidence.test.ts`** — Append new tests:
   - `verification-evidence: writeVerificationJSON includes runtimeErrors when present`
     - Create a `VerificationResult` with `runtimeErrors: [{ source: "bg-shell", severity: "crash", message: "Server crashed", blocking: true }]`
     - Verify the JSON output has a `runtimeErrors` array with the correct fields
   - `verification-evidence: writeVerificationJSON omits runtimeErrors when absent`
     - Create a `VerificationResult` without `runtimeErrors`
     - Verify the JSON output does NOT have a `runtimeErrors` key
   - `verification-evidence: writeVerificationJSON omits runtimeErrors when empty array`
     - Create a `VerificationResult` with `runtimeErrors: []`
     - Verify the JSON output does NOT have a `runtimeErrors` key
   - `verification-evidence: formatEvidenceTable appends runtime errors section`
     - Create a result with checks + runtimeErrors
     - Verify the table output contains "Runtime Errors" heading and source/severity/blocking columns
   - `verification-evidence: formatEvidenceTable omits runtime errors section when none`
     - Create a result with checks but no runtimeErrors
     - Verify the table output does NOT contain "Runtime Errors"
   - `verification-evidence: formatEvidenceTable truncates runtime error message to 100 chars`

   Note: The existing `makeResult()` helper creates `VerificationResult` objects — it doesn't include `runtimeErrors`, which is correct since the field is optional. New tests that need `runtimeErrors` should spread it in: `makeResult({ runtimeErrors: [...] })`.

## Must-Haves

- [ ] `captureRuntimeErrors()` called in auto.ts gate block after `runVerificationGate()`
- [ ] Blocking runtime errors set `result.passed = false` in auto.ts
- [ ] Runtime errors logged to stderr with source and severity
- [ ] `EvidenceJSON` extended with optional `runtimeErrors` array
- [ ] `writeVerificationJSON` includes `runtimeErrors` when present, omits when absent
- [ ] `formatEvidenceTable` appends "Runtime Errors" section with source/severity/blocking/message columns
- [ ] `schemaVersion` stays at `1`
- [ ] 6+ new tests for evidence format changes
- [ ] All existing evidence tests still pass

## Verification

- `npm run test:unit -- --test-name-pattern "verification-evidence"` — all tests pass (existing + new)
- `npm run test:unit -- --test-name-pattern "verification-gate"` — still passes (no regressions from T01)
- `npm run test:unit` — no new failures (baseline: 1045 pass, 8 pre-existing)
- `grep -n "captureRuntimeErrors" src/resources/extensions/gsd/auto.ts` — shows 1 import + 1 call site
- `grep -n "runtimeErrors" src/resources/extensions/gsd/verification-evidence.ts` — shows in EvidenceJSON, writeVerificationJSON, and formatEvidenceTable

## Inputs

- `src/resources/extensions/gsd/verification-gate.ts` — T01 added `captureRuntimeErrors()` export
- `src/resources/extensions/gsd/types.ts` — T01 added `RuntimeError` interface and `runtimeErrors?` on `VerificationResult`
- `src/resources/extensions/gsd/auto.ts` — existing gate block (~line 1499–1608) with `runVerificationGate()` call at ~line 1521, retry logic at ~line 1570, evidence writing at ~line 1556
- `src/resources/extensions/gsd/verification-evidence.ts` — existing `EvidenceJSON`, `writeVerificationJSON`, `formatEvidenceTable`
- `src/resources/extensions/gsd/tests/verification-evidence.test.ts` — existing tests + `makeResult()` helper

## Expected Output

- `src/resources/extensions/gsd/auto.ts` — has `captureRuntimeErrors` import and call in gate block; blocking errors override `result.passed`
- `src/resources/extensions/gsd/verification-evidence.ts` — `EvidenceJSON` has `runtimeErrors?` field; `writeVerificationJSON` writes it; `formatEvidenceTable` renders it
- `src/resources/extensions/gsd/tests/verification-evidence.test.ts` — 6+ new tests for runtime error evidence format
