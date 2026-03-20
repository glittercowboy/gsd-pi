---
estimated_steps: 3
estimated_files: 1
---

# T03: Verify deriveState ghost rejection end-to-end

**Slice:** S01 — Hardened milestone discovery and deriveState ghost rejection
**Milestone:** M010

## Description

Run the full ghost-milestone-regression test suite and add any missing edge cases. Verify that `deriveState()` correctly skips ghost directories and activates the real in-flight milestone. Add a test for the CONTEXT-only ghost scenario (doctor creates a CONTEXT.md during repair but no ROADMAP).

## Steps

1. Run `ghost-milestone-regression.test.ts` and verify all existing tests pass with the T02 fix.
2. Add a test case: ghost milestone with CONTEXT.md (simulating doctor repair skeleton) alongside a real milestone with ROADMAP — deriveState must activate the real milestone.
3. Add a test case: ghost milestone with CONTEXT.md + `depends_on` frontmatter — should not enter the milestone sequence at all.

## Must-Haves

- [ ] All ghost-milestone-regression tests pass
- [ ] CONTEXT-only ghost scenario tested
- [ ] No regressions in other GSD tests

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — all pass
- `npx tsx --test src/resources/extensions/gsd/tests/factcheck-*.test.ts` — still passes

## Inputs

- T02's hardened `isSubstantiveMilestone`

## Observability Impact

- **Signals change:** No runtime logging changes — test assertions provide the verification signal
- **Inspection:** Future agents can inspect test output to see which milestone was elected active; failures clearly indicate ghost milestone ID that incorrectly won election
- **Failure state:** Test failures expose the ghost milestone ID in assertion messages (e.g., "activeMilestone is M005 (real), not M001 (ghost)")

## Expected Output

- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — comprehensive edge-case coverage
