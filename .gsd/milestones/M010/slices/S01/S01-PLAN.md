# S01: Hardened milestone discovery and deriveState ghost rejection

**Goal:** Ensure `findMilestoneIds()` and `deriveState()` never treat ghost/metadata-only milestone directories as real milestones.
**Demo:** The existing `ghost-milestone-regression.test.ts` passes, proving ghost M001/M002 directories don't steal active status from real M005.

## Must-Haves

- `isSubstantiveMilestone` rejects directories that contain only a CONTEXT.md with no ROADMAP, no slices, and no SUMMARY (metadata-only skeleton)
- `findMilestoneIds` returns only verified milestones via the strengthened filter
- `deriveState` correctly activates the real in-flight milestone when ghosts exist
- The auto.ts syntax error (duplicate `const unit =` at line 1747) is fixed so tests can run

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` passes all assertions
- `npx tsx --test src/resources/extensions/gsd/tests/factcheck-*.test.ts` still passes (no regressions)
- **Failure-path check:** When ghost rejection fails, test output shows which ghost milestone incorrectly became active (e.g., "AssertionError: activeMilestone is M005 (real), not M001 (ghost)")

## Tasks

- [x] **T01: Fix auto.ts syntax error blocking test suite** `est:5m`
  - Why: The duplicate `const unit = const unit =` at line 1747 prevents any test that transitively imports auto.ts from compiling. This was fixed in M009 on main but is still present in this worktree.
  - Files: `src/resources/extensions/gsd/auto.ts`
  - Do: Replace the duplicated line with the correct single declaration and call.
  - Verify: `npx tsx -e "import './src/resources/extensions/gsd/auto.ts'"` exits without error
  - Done when: auto.ts compiles cleanly

- [x] **T02: Strengthen isSubstantiveMilestone to reject metadata-only skeletons** `est:30m`
  - Why: Currently, a directory with only a CONTEXT.md (created by doctor repair or manual mkdir + context write) passes the substantiveness check, allowing it to enter the milestone sequence and potentially become active.
  - Files: `src/resources/extensions/gsd/guided-flow.ts`, `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts`
  - Do: Refine `isSubstantiveMilestone` so that CONTEXT.md and CONTEXT-DRAFT.md alone are not sufficient to qualify as substantive. A milestone must have at least one of: ROADMAP.md, SUMMARY.md, or a populated slices/ directory. CONTEXT files indicate the milestone is *queued* but should not make it eligible for active election by `deriveState` when it has no planning artifacts. Add test cases for: empty dir, CONTEXT-only dir, ROADMAP dir, slices dir, SUMMARY-only dir.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — isSubstantiveMilestone edge cases pass
  - Done when: `isSubstantiveMilestone` returns false for empty and CONTEXT-only directories, true for ROADMAP/SUMMARY/slices directories

- [x] **T03: Verify deriveState ghost rejection end-to-end** `est:20m`
  - Why: With T02's filter fix, `deriveState()` should now skip ghosts and activate the real milestone. The existing regression test covers this scenario but needs to pass.
  - Files: `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts`
  - Do: Run the full regression test. If additional edge cases are needed (e.g., ghost with CONTEXT.md + depends_on), add them. Ensure the "Ghost directories should not steal active milestone status" test proves M005 is active, not M001.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — all tests pass
  - Done when: All ghost-milestone-regression tests pass with zero failures

## Observability / Diagnostics

- **Runtime signals:** `isSubstantiveMilestone` logs rejection reason at debug level when excluding a directory (e.g., "M001 excluded: no substantive artifacts, only CONTEXT.md")
- **Inspection surfaces:** `deriveState()` returns registry entries with `status` field; ghost milestones should not appear with `status: 'active'`
- **Failure visibility:** When deriveState elects a ghost milestone, test assertions fail with clear message indicating which ghost became active
- **Redaction:** No sensitive data involved — milestone IDs and file paths are safe to log

## Files Likely Touched

- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/guided-flow.ts`
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts`
