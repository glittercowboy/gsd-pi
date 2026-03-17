---
id: T01
parent: S05
milestone: M001
provides:
  - "AuditWarning interface in types.ts"
  - "runDependencyAudit(cwd, options?) function in verification-gate.ts"
  - "auditWarnings optional field on VerificationResult"
key_files:
  - "src/resources/extensions/gsd/types.ts"
  - "src/resources/extensions/gsd/verification-gate.ts"
  - "src/resources/extensions/gsd/tests/verification-gate.test.ts"
key_decisions: []
patterns_established:
  - "DependencyAuditOptions injectable deps pattern (mirrors CaptureRuntimeErrorsOptions from S04)"
  - "Top-level-only file matching via basename + path equality check"
observability_surfaces:
  - "runDependencyAudit() returns structured AuditWarning[] — empty array on any error path"
duration: "15m"
verification_result: passed
completed_at: "2026-03-17"
blocker_discovered: false
---

# T01: Implement runDependencyAudit with types and unit tests

**Added AuditWarning type, runDependencyAudit() with git diff detection and npm audit JSON parsing, plus 12 unit tests covering all happy/error paths**

## What Happened

Added `AuditWarning` interface to `types.ts` with 5 fields (name, severity, title, url, fixAvailable) and added `auditWarnings?: AuditWarning[]` optional field to `VerificationResult`. Implemented `runDependencyAudit(cwd, options?)` in `verification-gate.ts` with `DependencyAuditOptions` for dependency injection (D023 pattern) — injectable `gitDiff` and `npmAudit` functions with real defaults using `spawnSync`. The function detects top-level dependency file changes via git diff, runs npm audit with JSON output, and parses vulnerabilities into `AuditWarning[]`. All error paths return empty array without throwing. Non-zero npm audit exit codes are treated as expected behavior (vulnerabilities found). Subdirectory package.json files are excluded via basename + path equality check.

## Verification

- `npx --yes tsx src/resources/extensions/gsd/verification-gate.ts` — compiles cleanly (no output)
- `npm run test:unit -- --test-name-pattern "dependency-audit"` — all 12 new tests pass
- `npm run test:unit -- --test-name-pattern "verification-gate"` — all 28 existing tests still pass
- `npm run test:unit -- --test-name-pattern "dependency-audit.*empty array"` — graceful failure path tests pass
- Slice-level: `dependency-audit` tests pass, `verification-gate` tests pass, compile clean. `verification-evidence` tests not yet applicable (T02 scope). Full suite has 8 pre-existing failures (chokidar, @octokit/rest missing packages — unrelated).

## Diagnostics

- Call `runDependencyAudit(cwd)` directly to get `AuditWarning[]` — returns empty array on all error paths (non-git dir, missing lockfile, invalid JSON, npm not found)
- Inject custom `gitDiff`/`npmAudit` via `DependencyAuditOptions` for testing or alternate package managers
- `result.auditWarnings` on `VerificationResult` will be populated by T02 wiring in auto.ts

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — Added `AuditWarning` interface and `auditWarnings` field on `VerificationResult`
- `src/resources/extensions/gsd/verification-gate.ts` — Added `DependencyAuditOptions`, `defaultGitDiff`, `defaultNpmAudit`, and `runDependencyAudit()` function
- `src/resources/extensions/gsd/tests/verification-gate.test.ts` — Added 12 `dependency-audit:` test cases covering all lockfile types, graceful failures, JSON parsing, and subdirectory exclusion
- `.gsd/milestones/M001/slices/S05/S05-PLAN.md` — Added failure-path diagnostic verification step, marked T01 done
