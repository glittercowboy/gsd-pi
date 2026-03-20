# S02: Doctor lineage audit and STATE.md regression guard

**Goal:** Ensure doctor repair cannot regress the active milestone and surfaces ghost milestones with actionable diagnostics.
**Demo:** After doctor repairs damaged state, `deriveState()` and auto-resume agree on the correct milestone. An end-to-end test proves the full damaged-state → doctor → correct-active-milestone path.

## Must-Haves

- Doctor's ghost milestone diagnostic includes actionable guidance (what the directory contains, why it's excluded)
- `rebuildState` validates derived state before writing — if the derived active milestone doesn't match worktree/branch lineage, warn instead of silently regressing
- End-to-end test: create damaged state with ghost directories → run doctor → verify active milestone is correct

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — all pass including doctor integration tests
- `npx tsx --test src/resources/extensions/gsd/tests/factcheck-*.test.ts` — no regressions
- **Failure state inspection:** After running `rebuildState` with a simulated branch/active mismatch, STATE.md contains a regression guard warning comment. Test verifies the warning is present in the output file.

## Observability / Diagnostics

- Runtime signals: doctor issues with code `orphaned_milestone_directory` now include directory contents inventory
- Inspection surfaces: `STATE.md` after doctor repair shows correct active milestone
- Failure visibility: if `rebuildState` detects a potential regression, it logs a warning with the old vs new active milestone

## Tasks

- [x] **T01: Enhance doctor ghost milestone diagnostics** `est:20m`
  - Why: The current `orphaned_milestone_directory` warning is informational but doesn't tell the user what's in the directory or what to do about it. Enhanced diagnostics make ghost milestones actionable.
  - Files: `src/resources/extensions/gsd/doctor.ts`
  - Do: When doctor detects a non-substantive milestone directory, inventory its contents (list files present) and include that in the issue message. Add guidance: "This directory can be safely removed, or add a ROADMAP.md to make it a real milestone."
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — doctor diagnostic tests pass
  - Done when: Doctor ghost milestone warnings include directory contents and remediation guidance

- [x] **T02: Add rebuildState regression guard** `est:25m`
  - Why: If `deriveState()` returns a wrong active milestone (e.g., due to an edge case not caught by S01), `rebuildState` should not silently write that regression into STATE.md. A guard prevents the worst outcome.
  - Files: `src/resources/extensions/gsd/doctor.ts`, `src/resources/extensions/gsd/state.ts`
  - Do: In `rebuildState`, after calling `deriveState()`, check if the current worktree's branch name implies a specific milestone (e.g., `milestone/M010` → M010). If the derived active milestone is a different, earlier milestone, log a warning and include the mismatch in the STATE.md output as a diagnostic comment. Do not block the write — the guard is advisory, not blocking.
  - Verify: Unit test with a worktree on `milestone/M010` where deriveState returns M001 as active — warning is logged
  - Done when: `rebuildState` detects and warns about active-milestone regression relative to worktree lineage

- [x] **T03: End-to-end damaged-state recovery test** `est:30m`
  - Why: Proves the full incident path stays fixed: damaged state with ghost directories → doctor repair → deriveState → correct active milestone.
  - Files: `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts`
  - Do: Create a test fixture that simulates the observed user incident: ghost M001/M002 directories + real M010 with ROADMAP and incomplete slices. Run doctor checks, verify ghost warnings are emitted. Call `deriveState()`, verify M010 is active. Call `rebuildState()`, verify STATE.md shows M010 as active.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — end-to-end test passes
  - Done when: Full damaged-state → doctor → correct-active-milestone path tested and passing

## Files Likely Touched

- `src/resources/extensions/gsd/doctor.ts`
- `src/resources/extensions/gsd/state.ts`
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts`
