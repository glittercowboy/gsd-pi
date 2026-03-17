---
id: T01
parent: S01
milestone: M001
provides:
  - VerificationCheck and VerificationResult interfaces in types.ts
  - verification_commands, verification_auto_fix, verification_max_retries preference keys (validated, merged)
  - discoverCommands() and runVerificationGate() functions in verification-gate.ts
key_files:
  - src/resources/extensions/gsd/types.ts
  - src/resources/extensions/gsd/preferences.ts
  - src/resources/extensions/gsd/verification-gate.ts
  - src/resources/extensions/gsd/tests/verification-gate.test.ts
key_decisions:
  - D003 discovery order implemented: preference → task-plan → package-json → none (first-non-empty-wins)
patterns_established:
  - spawnSync with { shell: true, stdio: 'pipe', encoding: 'utf-8' } for subprocess capture
  - 10KB stdout/stderr truncation to prevent unbounded memory in VerificationCheck results
  - Preference validation follows existing pattern (type checks, push to errors array, set on validated object)
observability_surfaces:
  - VerificationResult.passed — top-level gate pass/fail signal
  - VerificationResult.discoverySource — which discovery path activated
  - VerificationCheck.exitCode/stdout/stderr — per-command diagnostics
  - Preference validation errors surfaced in LoadedGSDPreferences.warnings
duration: 15m
verification_result: passed
completed_at: 2026-03-16
blocker_discovered: false
---

# T01: Implement verification gate types, preferences, and core logic

**Added VerificationCheck/VerificationResult types, 3 preference keys, and discoverCommands/runVerificationGate pure functions with 19 passing tests**

## What Happened

1. Added `VerificationCheck` and `VerificationResult` interfaces to `types.ts` after the `TaskPlanEntry` interface, in a new "Verification Gate" section.

2. Added three preference keys to `preferences.ts` in all four required locations:
   - `KNOWN_PREFERENCE_KEYS` set: added `verification_commands`, `verification_auto_fix`, `verification_max_retries`
   - `GSDPreferences` interface: added optional typed fields
   - `mergePreferences()`: used `mergeStringLists` for commands, nullish coalescing for others
   - `validatePreferences()`: added a new "Verification Preferences" validation section with type checks (array of strings, boolean, non-negative number with floor)

3. Created `verification-gate.ts` exporting two functions:
   - `discoverCommands()` — first-non-empty-wins discovery per D003: preference commands → task plan verify (split on `&&`) → package.json scripts (`typecheck`, `lint`, `test`) → none
   - `runVerificationGate()` — discovers commands, runs each via `spawnSync`, handles errors (exit 127 for spawn failures, exit 1 for signal kills), truncates stdout/stderr to 10KB

4. Created `verification-gate.test.ts` with 19 tests covering discovery (8 tests), execution (5 tests), and preference validation (6 tests).

## Verification

- `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` — compiles without error (clean exit)
- `npm run test:unit -- --test-name-pattern "verification-gate"` — 19/19 tests pass
- `npm run test:unit -- --test-name-pattern "preferences"` — all existing preferences tests still pass (0 failures in preferences test suites)
- Code review: `discoverCommands` follows D003 order; `runVerificationGate` uses `spawnSync` not `execSync`

### Slice-level verification (partial — T01 is intermediate):
- ✅ `npm run test:unit -- --test-name-pattern "verification-gate"` — all unit tests pass
- ⏳ `npm run test:unit` — all existing tests still pass (8 pre-existing failures in file-watcher and github-client tests are unrelated to this change)

## Diagnostics

- Inspect `VerificationResult.checks` for per-command exit codes, stdout, stderr, and duration
- Call `discoverCommands({ cwd })` to preview what commands the gate would run without executing
- `VerificationResult.discoverySource` tells which discovery path activated ("preference" | "task-plan" | "package-json" | "none")
- Invalid preference values produce validation errors in `LoadedGSDPreferences.warnings`

## Deviations

None — implementation follows the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — added VerificationCheck and VerificationResult interfaces
- `src/resources/extensions/gsd/preferences.ts` — added 3 verification preference keys to KNOWN_PREFERENCE_KEYS, GSDPreferences, mergePreferences, validatePreferences
- `src/resources/extensions/gsd/verification-gate.ts` — new file with discoverCommands() and runVerificationGate()
- `src/resources/extensions/gsd/tests/verification-gate.test.ts` — new file with 19 unit tests
- `.gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md` — added Observability Impact section
