# M010 — Research: Recovery and Doctor State Regression Hardening

## Summary

The current GSD state derivation pipeline relies heavily on file existence (e.g., `deriveState` checking for artifacts) and directory naming conventions in `.gsd/milestones/`. Under damaged or "recovery" scenarios—where stale milestones are partially deleted or metadata-only folders remain—`findMilestoneIds` and `deriveState` may erroneously identify ghost or legacy milestones as active.

I recommend a dual-layer strategy:
1. **Structural Hardening:** Strengthen `findMilestoneIds` by incorporating `isSubstantiveMilestone` at the discovery level, ensuring only verifiable, content-rich milestones enter the sequence.
2. **Doctor Integrity Guards:** Enhance `doctor` to perform a "lineage audit," confirming that the active milestone's sequence is physically contiguous with the filesystem-based worktree lineage, preventing the scheduler from "jumping" back to a metadata-only directory that was incorrectly promoted.

## Recommendation

We will prioritize two slices:
- **S01: Hardened Milestone Discovery.** Refactor `findMilestoneIds` to strictly enforce directory "substantiveness" (checked against a manifest of valid artifacts).
- **S02: Doctor Lineage Audit.** Extend `doctor` to flag and optionally scrub non-contiguous milestone directories that lack structural proof of progression.

This approach builds on the existing `isSubstantiveMilestone` primitive but elevates it from an advisory filter to a structural requirement.

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/guided-flow.ts` — Location of `findMilestoneIds` and `isSubstantiveMilestone`. Needs tight filtering logic.
- `src/resources/extensions/gsd/state.ts` — `deriveState` logic that determines milestone phases. Needs updated "active" election logic to favor lineage over arbitrary sequences.
- `src/resources/extensions/gsd/doctor.ts` — Contains the repair logic. Needs new `audit_lineage` and `scrub_ghost_milestone` issue codes.

### Build Order

1. **S01 (Discovery Hardening):** Modify `findMilestoneIds` to return only verified milestones. This unblocks `deriveState` so it can reliably iterate over clean sets.
2. **S02 (Doctor Integrity):** Add logic to detect and offer repair (or auto-fix) for milestone directories clearly outside the current branch/worktree progression.

### Verification Approach

- **Regression Tests:** Create a fixture with a "ghost" milestone directory (empty, no content) that currently traps the scheduler, and verify S01 filtering resolves it.
- **Doctor Tests:** Create a test case where a milestone directory exists but is orphaned from current worktrees; verify `doctor` flags it correctly.

## Constraints

- Recovery must favor real lineage signals over sequence-only reconstruction.
- Diagnostics must be explicit, not silent/hidden.
- Regressions tests must model failed recovery paths, not just synthetic happy paths.

## Open Risks

- Tightening `findMilestoneIds` could accidentally mask mis-migrated historical milestones. We must provide a way for `doctor` to opt-in or manually recover "misplaced" content.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Git/Worktrees | `development-harness` | Available |
| GSD Doctor | `plugin-creator` | Available (Linting/Audit) |
| Bash | `bash-development` | Available |
