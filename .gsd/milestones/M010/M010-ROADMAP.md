# M010: Recovery and Doctor State Regression Hardening

**Vision:** Recovery and doctor flows preserve real active-milestone lineage instead of fabricating or promoting earlier milestone IDs from skeleton directories.

## Success Criteria

- Ghost milestone directories (empty or metadata-only) never become the active milestone in `deriveState()`.
- Doctor repair does not regress the active milestone by creating skeleton directories that outrank the real in-flight milestone.
- After doctor repair on damaged state, `/gsd auto` resumes on the correct milestone — the one with real worktree/branch lineage.
- Regression tests reproduce the observed user incident (ghost takeover) and prove it stays fixed.

## Key Risks / Unknowns

- Tightening `isSubstantiveMilestone` could mask legitimate milestones that happen to have minimal content — must ensure CONTEXT-only milestones (which are real queued milestones) remain discoverable.
- Doctor's `rebuildState` path could silently overwrite STATE.md with a regressed active milestone if `deriveState` itself returns the wrong answer — the fix must be in `deriveState`, not just doctor.

## Proof Strategy

- Ghost takeover regression → retire in S01 by proving `deriveState()` returns the real M005 (not ghost M001) when ghost directories exist alongside a real milestone.
- Doctor regression → retire in S02 by proving doctor repair + `deriveState()` + auto resume all agree on the correct milestone after damaged-state recovery.

## Verification Classes

- Contract verification: regression tests in `ghost-milestone-regression.test.ts` covering discovery, state derivation, and doctor diagnostics
- Integration verification: end-to-end test with damaged `.gsd/` state → doctor repair → `deriveState()` → correct active milestone
- Operational verification: none (no services)
- UAT / human verification: none

## Milestone Definition of Done

This milestone is complete only when all are true:

- `findMilestoneIds()` excludes ghost/metadata-only milestone directories
- `deriveState()` never elects a ghost milestone as active
- Doctor detects ghost milestones and surfaces them as warnings without promoting them
- Doctor `rebuildState` cannot regress the active milestone
- The existing `ghost-milestone-regression.test.ts` passes (currently failing)
- All existing GSD tests continue to pass (zero regressions)

## Requirement Coverage

- Covers: none (M010 introduces no new requirements — it hardens existing infrastructure)
- Orphan risks: none — the work addresses an observed incident, not a requirements gap

## Slices

- [x] **S01: Hardened milestone discovery and deriveState ghost rejection** `risk:high` `depends:[]`
  > After this: `findMilestoneIds()` filters ghost directories, `deriveState()` never activates a ghost milestone, and the existing regression test passes.
- [x] **S02: Doctor lineage audit and STATE.md regression guard** `risk:medium` `depends:[S01]`
  > After this: Doctor detects ghost milestones with actionable diagnostics, `rebuildState` cannot regress the active milestone, and an end-to-end damaged-state → doctor → auto-resume test passes.

## Boundary Map

### S01 → S02

Produces:
- `isSubstantiveMilestone()` with strengthened filtering (rejects metadata-only directories)
- `findMilestoneIds()` returning only verified milestones
- `deriveState()` that never promotes a ghost to active
- Passing `ghost-milestone-regression.test.ts`

Consumes:
- nothing (first slice)

### S02 consumes S01

Produces:
- Doctor `orphaned_milestone_directory` issue with enhanced diagnostics
- `rebuildState` regression guard (validates derived active milestone against worktree/branch lineage before writing)
- End-to-end integration test for damaged-state recovery

Consumes:
- S01's hardened `isSubstantiveMilestone` and `findMilestoneIds`
