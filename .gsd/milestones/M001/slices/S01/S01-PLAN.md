# S01: Built-in Verification Gate

**Goal:** After execute-task completes, typecheck/lint/test runs automatically via a built-in gate. Task is blocked until commands pass. Evidence of pass/fail is logged to stdout.
**Demo:** Run `gsd auto` on a project with `typecheck`, `lint`, `test` scripts in package.json. After the agent finishes an execute-task, the verification gate fires automatically, runs all three commands, and prints "Verification gate: 3/3 checks passed" or blocks with failure details. User hooks still fire after the gate.

## Must-Haves

- `VerificationResult` and `VerificationCheck` interfaces defined in `types.ts`
- `verification_commands`, `verification_auto_fix`, `verification_max_retries` preference keys added, validated, and merged
- `runVerificationGate(basePath, unitId, cwd)` pure function in `verification-gate.ts` that discovers commands (preference → task plan verify → package.json scripts), runs them via `spawnSync`, and returns structured `VerificationResult`
- Gate fires only for `execute-task` unit type, after artifact verification, before post-unit hooks
- Gate blocks `handleAgentEnd` when any command fails (non-zero exit)
- Gate logs results to stdout via `ctx.ui.notify()` with pass/fail summary
- Graceful handling: missing package.json, no matching scripts, empty discovery → gate passes with 0 checks
- All existing GSD tests still pass

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (unit tests with temp dirs + spawnSync of echo/exit commands)
- Human/UAT required: no

## Verification

- `npm run test:unit -- --test-name-pattern "verification-gate"` — all unit tests for gate logic pass
- `npm run test:unit` — all existing tests still pass (no regressions)
- Tests cover: command discovery from preferences, from task plan verify field, from package.json scripts; execution with passing/failing commands; graceful empty discovery; preference validation for new keys

## Observability / Diagnostics

- Runtime signals: `ctx.ui.notify()` messages with pass/fail count; stderr structured output with per-command exit codes
- Inspection surfaces: `VerificationResult` returned from gate function; future T##-VERIFY.json (S02 scope)
- Failure visibility: per-command exit code, stdout, stderr captured in `VerificationCheck`; overall pass/fail in `VerificationResult`
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `TaskPlanEntry.verify` field (already parsed in `files.ts` line 463), `GSDPreferences` interface, `handleAgentEnd` in `auto.ts`
- New wiring introduced in this slice: synchronous gate call in `handleAgentEnd` after artifact verification block, before `checkPostUnitHooks`
- What remains before the milestone is truly usable end-to-end: S02 (evidence format), S03 (retry loop), S04 (runtime errors), S05 (npm audit)

## Tasks

- [x] **T01: Implement verification gate types, preferences, and core logic** `est:1h`
  - Why: This is the core deliverable — the pure function that discovers verification commands and runs them. Types and preferences are prerequisites that must exist for the gate to compile.
  - Files: `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/preferences.ts`, `src/resources/extensions/gsd/verification-gate.ts`
  - Do: Add `VerificationResult`/`VerificationCheck` interfaces to types.ts. Add 3 preference keys to GSDPreferences interface, KNOWN_PREFERENCE_KEYS, mergePreferences, and validatePreferences. Create verification-gate.ts with `runVerificationGate()` that discovers commands (preference → task plan verify → package.json) and runs them via `spawnSync`. Use `spawnSync` with `{ stdio: 'pipe', shell: true }` to capture output without throwing on non-zero exit.
  - Verify: `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` compiles without errors; `npm run test:unit -- --test-name-pattern "preferences-schema"` still passes
  - Done when: `verification-gate.ts` exports `runVerificationGate`, types compile, preferences validate — all without breaking existing tests

- [ ] **T02: Add unit tests for verification gate** `est:45m`
  - Why: The gate is the riskiest piece (process spawning, command discovery, exit code handling). Tests prove contract correctness before integration.
  - Files: `src/resources/extensions/gsd/tests/verification-gate.test.ts`
  - Do: Write tests covering: (1) discovery from explicit `verification_commands` preference, (2) discovery from task plan verify field, (3) discovery from package.json typecheck/lint/test scripts, (4) first-non-empty-wins precedence, (5) all commands pass → gate passes, (6) one command fails → gate fails with exit code + stderr, (7) missing package.json → 0 checks → pass, (8) empty scripts → 0 checks → pass, (9) preference validation for new keys. Use temp dirs with mock package.json files and real `spawnSync` of `echo` / `exit 1` commands.
  - Verify: `npm run test:unit -- --test-name-pattern "verification-gate"` — all tests pass
  - Done when: All 9+ test scenarios pass, covering discovery, execution, and edge cases

- [ ] **T03: Wire verification gate into auto.ts handleAgentEnd** `est:30m`
  - Why: The gate must fire automatically after execute-task without manual invocation. This is the integration that makes R001 real.
  - Files: `src/resources/extensions/gsd/auto.ts`
  - Do: Import `runVerificationGate` at top of auto.ts. In `handleAgentEnd`, after the `clearUnitRuntimeRecord` block for non-hook units (line ~1481) and before the DB dual-write block (line ~1489), add a conditional block: if `currentUnit.type === "execute-task"`, call `runVerificationGate(basePath, currentUnit.id, basePath)`, log results via `ctx.ui.notify()`. If gate fails, write a stderr warning. The gate must NOT fire for hook units, triage-captures, quick-task, or other unit types. Pass the loaded preferences (use `loadEffectiveGSDPreferences()`) and the current task plan's verify field (read from the task plan file via existing `parseSlicePlan` or `readTaskPlanEntry`).
  - Verify: `npm run test:unit` — all existing tests pass (gate code path only activates for execute-task in auto-mode, so no existing test triggers it); manual code review confirms insertion point is correct
  - Done when: Gate call is wired in handleAgentEnd, only fires for execute-task, logs pass/fail, does not break any existing test

## Files Likely Touched

- `src/resources/extensions/gsd/types.ts` — add VerificationResult, VerificationCheck interfaces
- `src/resources/extensions/gsd/preferences.ts` — add 3 preference keys to interface, KNOWN_PREFERENCE_KEYS, merge, validate
- `src/resources/extensions/gsd/verification-gate.ts` — new file, core gate logic
- `src/resources/extensions/gsd/auto.ts` — wire gate call into handleAgentEnd
- `src/resources/extensions/gsd/tests/verification-gate.test.ts` — new test file
