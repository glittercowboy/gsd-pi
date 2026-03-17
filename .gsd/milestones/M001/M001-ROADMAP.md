# M001: Verification Enforcement

**Vision:** No task completes without machine-readable verification evidence. The verification gate is mandatory infrastructure, not optional behavior.

## Success Criteria

- Every execute-task completion triggers the verification gate automatically
- Verification commands are discovered from preferences, task plan verify field, and package.json scripts
- Task summaries contain structured verification evidence tables
- T##-VERIFY.json artifacts are written alongside every task summary
- Failed verification triggers up to 2 auto-fix retry cycles with failure context injection
- Server crashes and unhandled rejections from bg-shell fail the gate
- Browser console.error and deprecation warnings are logged in evidence but do not block
- npm audit runs conditionally when package.json or lockfile changes, with warnings in evidence (non-blocking)
- All existing GSD tests still pass

## Key Risks / Unknowns

- Built-in hook integration — making a mandatory gate that coexists with user-configured hooks without hook-on-hook chains
- Verification command discovery — handling missing scripts, monorepos, non-npm projects
- Runtime error capture timing — bg-shell output race conditions with async server output
- Auto-fix retry integration — using existing retry_on mechanism vs custom retry path

## Proof Strategy

- Built-in hook architecture → retire in S01 by proving the gate fires after execute-task without triggering user hooks
- Command discovery → retire in S01 by proving commands are found from preferences and package.json
- Auto-fix retry → retire in S03 by proving 2 retry cycles with failure context injection
- Runtime error capture → retire in S04 by proving bg-shell crash detection and browser console capture

## Verification Classes

- Contract verification: unit tests for gate logic, command discovery, evidence parsing, retry loop, error classification
- Integration verification: auto-mode lifecycle tests confirm gate fires in correct sequence
- Operational verification: none (no services to manage)
- UAT / human verification: manual auto-mode run on a real project to confirm evidence appears

## Milestone Definition of Done

This milestone is complete only when all are true:

- Verification gate fires after every execute-task completion
- Commands discovered from preferences + package.json
- Evidence table present in every task summary
- T##-VERIFY.json written alongside every summary
- Auto-fix retry loop works (2 cycles)
- Runtime error capture works (crashes block, warnings log)
- npm audit conditional scan works
- All existing tests pass
- Success criteria re-checked against live auto-mode behavior

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008
- Partially covers: none
- Leaves for later: R009–R019
- Orphan risks: none

## Slices

- [x] **S01: Built-in Verification Gate** `risk:high` `depends:[]`
  > After this: After execute-task completes, typecheck/lint/test runs automatically via a built-in gate. Task is blocked until commands pass. Evidence of pass/fail is logged to stdout.

- [x] **S02: Structured Evidence Format** `risk:medium` `depends:[S01]`
  > After this: Task summaries contain a canonical verification evidence table. T##-VERIFY.json files are written alongside summaries with machine-queryable results. Observability validator rejects summaries without evidence blocks.

- [x] **S03: Auto-Fix Retry Loop** `risk:medium` `depends:[S01]`
  > After this: When verification commands fail, the agent gets 2 auto-fix attempts with failure context injected. After 2 failures, the gate fails and surfaces for human review. Retry count visible in evidence.

- [x] **S04: Runtime Error Capture** `risk:medium` `depends:[S01]`
  > After this: Server crashes and unhandled rejections from bg-shell processes appear in verification evidence and block the gate. Console.error and deprecation warnings are logged in evidence but do not block.

- [ ] **S05: Dependency Security Scan** `risk:low` `depends:[S01]`
  > After this: When package.json or lockfile changes during a task, npm audit runs automatically. High/critical vulnerabilities appear as warnings in the verification evidence. Non-blocking — the gate does not fail on audit warnings.

## Boundary Map

### S01 → S02

Produces:
- `verification-gate.ts` → `runVerificationGate(basePath, unitId, cwd)` returning `VerificationResult` (commands run, exit codes, stdout/stderr per command)
- `types.ts` → `VerificationResult`, `VerificationCheck` interfaces
- `preferences.ts` → `verification_commands`, `verification_auto_fix`, `verification_max_retries` preference keys
- Integration point in `auto.ts` handleAgentEnd that calls the gate before user hooks

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- `verification-gate.ts` → `runVerificationGate()` with pass/fail result that S03 wraps in a retry loop
- `types.ts` → `VerificationResult` with structured failure info for injection into retry prompts

Consumes:
- nothing (first slice)

### S01 → S04

Produces:
- `verification-gate.ts` → extensible `VerificationResult` that S04 adds runtime error fields to

Consumes:
- nothing (first slice)

### S01 → S05

Produces:
- `verification-gate.ts` → extensible gate pipeline that S05 adds a conditional npm audit step to

Consumes:
- nothing (first slice)

### S02 → (terminal)

Produces:
- `verification-evidence.ts` → `writeVerificationEvidence(result, summaryPath)` writing both markdown section and JSON artifact
- `observability-validator.ts` → evidence block validation rules
- Updated `templates/task-summary.md` with evidence section

Consumes from S01:
- `verification-gate.ts` → `VerificationResult` (data source for evidence writing)

### S03 → (terminal)

Produces:
- Retry loop integration in `auto.ts` or `verification-gate.ts` → re-dispatches execute-task with failure context up to `verification_max_retries` times

Consumes from S01:
- `verification-gate.ts` → `VerificationResult` with failure details for retry context injection
- `preferences.ts` → `verification_max_retries` preference

### S04 → (terminal)

Produces:
- Runtime error capture in `verification-gate.ts` → `captureRuntimeErrors(basePath)` checking bg-shell output and browser console
- Severity classification: crashes/unhandled rejections = blocking, console.error/deprecation = non-blocking

Consumes from S01:
- `verification-gate.ts` → `VerificationResult` extended with `runtimeErrors` field

### S05 → (terminal)

Produces:
- Conditional npm audit step in verification pipeline → runs when git diff detects package.json/lockfile changes
- Audit results as non-blocking warnings in `VerificationResult`

Consumes from S01:
- `verification-gate.ts` → gate pipeline extension point
