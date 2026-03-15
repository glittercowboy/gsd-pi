---
estimated_steps: 3
estimated_files: 0
---

# T02: Full regression pass and assembly readiness confirmation

**Slice:** S07 — End-to-end web assembly proof
**Milestone:** M001

## Description

Run the entire test suite and build to confirm S07's new assembled test hasn't broken anything and the system is ready for the user's live manual UAT. This is a verification-only task — no code changes unless a real regression is found.

## Steps

1. Run all contract tests: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-bridge-contract.test.ts src/tests/web-onboarding-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/web-continuity-contract.test.ts src/tests/web-workflow-controls-contract.test.ts`

2. Run all integration tests: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/integration/web-mode-assembled.test.ts src/tests/integration/web-mode-runtime.test.ts src/tests/integration/web-mode-onboarding.test.ts`

3. Run `npm run build:web-host` and confirm standalone host stages successfully.

## Must-Haves

- [ ] All contract tests pass (bridge, onboarding, live-interaction, continuity, workflow-controls)
- [ ] All integration tests pass (assembled, runtime, onboarding)
- [ ] `npm run build:web-host` succeeds with standalone host staged

## Verification

- All test commands exit 0 with no test failures
- `npm run build:web-host` exits 0

## Inputs

- `src/tests/integration/web-mode-assembled.test.ts` — the new T01 test that must pass alongside existing tests
- All S01–S06 contract and integration tests

## Expected Output

- No files modified (unless a regression is found and fixed)
- Confirmed green test suite + successful build = system ready for user's live UAT

## Observability Impact

- Signals confirmed by this task: contract test health, integration test health, and `build:web-host` standalone staging success
- Future agents inspect this task by rerunning the exact verification commands and reading the generated task summary for pass/fail status plus any failing command output called out there
- Failure state becomes visible as a non-zero exit from a specific regression/build command, narrowing breakage to the contract suite, the integration suite, the assembled route-level proof, or the standalone host build pipeline
