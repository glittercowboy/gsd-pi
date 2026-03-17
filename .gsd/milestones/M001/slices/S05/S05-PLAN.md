# S05: Dependency Security Scan

**Goal:** When package.json or a lockfile changes during a task, `npm audit` runs automatically as part of the verification gate. High/critical vulnerabilities appear as non-blocking warnings in verification evidence.
**Demo:** Run a task that modifies `package.json` → audit step fires, results appear in evidence JSON and markdown table. Run a task with no dependency changes → audit step is skipped. Audit warnings never cause the gate to fail.

## Must-Haves

- `runDependencyAudit(cwd, options?)` function using dependency injection for testability (D023 pattern)
- Git diff detection for package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb
- `npm audit --audit-level=moderate --json` execution with JSON stdout parsing
- `AuditWarning` interface on `VerificationResult` (optional field, same pattern as `runtimeErrors`)
- Non-blocking — audit warnings never set `result.passed = false`
- Graceful failure: non-git dirs, missing lockfile, npm audit errors all return empty warnings
- npm audit non-zero exit code treated as expected (vulnerabilities found), not as error
- Evidence JSON (`T##-VERIFY.json`) includes `auditWarnings` array when present
- Evidence markdown table includes "Audit Warnings" section when present
- Wired into `auto.ts` gate block after `captureRuntimeErrors()`

## Verification

- `npm run test:unit -- --test-name-pattern "dependency-audit"` — all new tests pass
- `npm run test:unit -- --test-name-pattern "verification-evidence"` — existing + new evidence tests pass
- `npm run test:unit` — full suite, no regressions
- `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` — compiles cleanly
- `npm run test:unit -- --test-name-pattern "dependency-audit.*empty array"` — graceful failure paths (non-git dir, invalid JSON, npm error) all return empty array without throwing

## Observability / Diagnostics

- Runtime signals: stderr line `verification-gate: N audit warning(s)` when warnings found, `verification-gate: npm audit skipped (no dependency changes)` when skipped
- Inspection surfaces: `auditWarnings` array in `T##-VERIFY.json`, "Audit Warnings" section in evidence markdown table
- Failure visibility: graceful degradation errors logged to stderr with `verification-gate: audit error —` prefix
- Redaction constraints: none (audit data is public advisory metadata)

## Integration Closure

- Upstream surfaces consumed: `VerificationResult` from `types.ts`, gate pipeline in `auto.ts` (~line 1530), `writeVerificationJSON`/`formatEvidenceTable` from `verification-evidence.ts`
- New wiring introduced in this slice: `runDependencyAudit()` call in `auto.ts` gate block, `auditWarnings` field on `VerificationResult`
- What remains before the milestone is truly usable end-to-end: nothing — S05 is the final slice in M001

## Tasks

- [x] **T01: Implement runDependencyAudit with types and unit tests** `est:30m`
  - Why: Core logic for git change detection, npm audit execution, and JSON parsing. This is the riskiest piece — needs graceful handling of non-git dirs, missing lockfiles, and npm audit's non-zero exit on vulnerabilities.
  - Files: `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/verification-gate.ts`, `src/resources/extensions/gsd/tests/verification-gate.test.ts`
  - Do: Add `AuditWarning` interface to types.ts. Add `auditWarnings?: AuditWarning[]` to `VerificationResult`. Implement `runDependencyAudit(cwd, options?)` in verification-gate.ts with injectable `gitDiff` and `npmAudit` dependencies (D023 pattern). Write unit tests covering: package.json change detected → audit runs, no changes → skipped, lockfile changes trigger audit, non-git dir → empty array, npm audit error → empty array, npm audit non-zero exit with valid JSON → parses vulnerabilities, empty vulnerabilities → empty array.
  - Verify: `npm run test:unit -- --test-name-pattern "dependency-audit"` passes, `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` compiles
  - Done when: `runDependencyAudit()` is exported, all dependency-audit tests pass, function handles all graceful-failure paths

- [ ] **T02: Wire audit into evidence formatting and auto.ts gate block** `est:25m`
  - Why: Connects the audit function to the verification pipeline — results appear in evidence JSON/markdown and the function is called during the gate.
  - Files: `src/resources/extensions/gsd/verification-evidence.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/tests/verification-evidence.test.ts`
  - Do: Add `AuditWarningJSON` interface and `auditWarnings?: AuditWarningJSON[]` to `EvidenceJSON`. Extend `writeVerificationJSON` to include audit warnings (same conditional pattern as runtimeErrors). Extend `formatEvidenceTable` to append "Audit Warnings" markdown section. Wire `runDependencyAudit(basePath)` call in auto.ts gate block after `captureRuntimeErrors()`, attach to `result.auditWarnings`. Add stderr logging for audit warnings. Add evidence tests for audit warning JSON persistence and markdown formatting.
  - Verify: `npm run test:unit -- --test-name-pattern "verification-evidence"` passes, `npm run test:unit` full suite passes with no new regressions
  - Done when: Evidence JSON includes auditWarnings, markdown table shows "Audit Warnings" section, auto.ts calls runDependencyAudit in the gate block, all tests pass

## Files Likely Touched

- `src/resources/extensions/gsd/types.ts`
- `src/resources/extensions/gsd/verification-gate.ts`
- `src/resources/extensions/gsd/verification-evidence.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/verification-gate.test.ts`
- `src/resources/extensions/gsd/tests/verification-evidence.test.ts`
