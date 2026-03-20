---
id: M010
milestone: M010
provides:
  - isSubstantiveMilestone() filters empty ghost directories from milestone discovery
  - findMilestoneIds() returns only verified milestones (no ghosts)
  - deriveState() never activates a ghost milestone - always selects real ROADMAP/SUMMARY milestone
  - Doctor ghost milestone diagnostics with directory contents inventory and remediation guidance
  - rebuildState regression guard that detects branch/milestone mismatches and warns in STATE.md
  - End-to-end test proving full damaged-state → doctor → deriveState → rebuildState path
  - Passing ghost-milestone-regression.test.ts (77 tests, 0 failures)
requires: []
affects: []
key_files:
  - src/resources/extensions/gsd/guided-flow.ts (isSubstantiveMilestone, findMilestoneIds)
  - src/resources/extensions/gsd/auto.ts (syntax fix for test compilation)
  - src/resources/extensions/gsd/doctor.ts (enhanced ghost diagnostics, regression guard)
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - CONTEXT.md and CONTEXT-DRAFT.md ARE substantive - they represent queued/seeded milestones that are real work items, just not yet planned
  - Empty directories (no files, no slices/) ARE ghosts and filtered out
  - Only directories with ROADMAP.md, SUMMARY.md, or populated slices/ can become active milestones
  - Chose advisory regression guard (warn but write anyway) rather than blocking guard to preserve write semantics
  - Used numeric comparison of milestone IDs (M010 → 10) to detect regressions rather than string comparison
patterns_established:
  - Ghost milestone = empty directory with zero milestone artifacts
  - A substantive milestone must have at least one of: ROADMAP.md, SUMMARY.md, or populated slices/
  - findMilestoneIds filters using isSubstantiveMilestone before returning
  - Doctor diagnostics now include actionable file inventory for ghost milestones
  - Advisory guards preserve write semantics while surfacing diagnostics in output files
observability_surfaces:
  - Doctor issues with code orphaned_milestone_directory include directory contents and remediation guidance
  - STATE.md contains regression guard warning comments when branch/milestone mismatch detected
  - Console warning: rebuildState logs when derived active differs from worktree lineage
  - Test assertions clearly indicate which ghost milestone incorrectly won election
  - deriveState() registry entries expose status field - ghosts never have status='active'
drill_down_paths:
  - .gsd/milestones/M010/slices/S01/S01-SUMMARY.md
  - .gsd/milestones/M010/slices/S02/S02-SUMMARY.md
duration: 77m
verification_result: passed
completed_at: 2026-03-20T04:45:00Z
---

# M010: Recovery and Doctor State Regression Hardening

**Milestone discovery and doctor repair flows preserve real active-milestone lineage instead of fabricating or promoting earlier milestone IDs from ghost directories.**

## What Happened

M010 addressed a real live-use incident where damaged `.gsd/` state combined with doctor/recovery flows could fabricate earlier milestone arcs and redirect `/gsd auto` away from the user's actual in-flight sequence. The fix involved hardening milestone discovery to reject ghost directories and adding guardrails to doctor repair.

The milestone completed in two slices:

**S01 (22m):** Hardened milestone discovery and deriveState ghost rejection. Fixed a syntax error in auto.ts that was blocking test compilation. Verified that `isSubstantiveMilestone()` correctly distinguishes ghosts from queued milestones:
- Empty directories → filtered out (ghost)
- CONTEXT-only → returns TRUE (queued milestone, valid)
- CONTEXT-DRAFT-only → returns TRUE (queued milestone, valid)
- ROADMAP-only → returns TRUE (real milestone)
- SUMMARY-only → returns TRUE (completed milestone)
- Populated slices/ → returns TRUE (active work)

**S02 (55m):** Doctor lineage audit and STATE.md regression guard. Enhanced the `orphaned_milestone_directory` diagnostic to include directory contents inventory (up to 5 files shown, +N more for larger directories) plus remediation guidance. Added an advisory regression guard in `rebuildState()` that detects when the derived active milestone differs from the worktree branch lineage, logs a warning, and writes a diagnostic comment to STATE.md but preserves write semantics. Created a comprehensive e2e test that reproduces the full incident path: ghost directories alongside a real in-flight milestone, doctor diagnostics, deriveState returning the correct milestone, and rebuildState preserving it.

The key insight: CONTEXT.md and CONTEXT-DRAFT.md files represent **queued/seeded milestones** - they're real work items that haven't been planned yet and should remain discoverable. The actual ghost problem was **empty directories** (created by doctor repair or manual mkdir) that had no content at all.

## Cross-Slice Verification

| Success Criterion | Evidence |
|-------------------|----------|
| findMilestoneIds() excludes ghost directories | isSubstantiveMilestone() filters empty dirs, verified by 77 tests |
| deriveState() never elects a ghost as active | Regression test proves M010 wins over ghost M001/M002/M003 |
| Doctor detects ghost milestones with warnings | orphaned_milestone_directory diagnostic includes file inventory |
| Doctor rebuildState cannot regress active milestone | Regression guard detects branch/milestone mismatch, logs warning |
| ghost-milestone-regression.test.ts passes | 77/77 tests pass |
| No regressions in existing tests | 42/42 factcheck tests pass |

## Requirement Changes

M010 introduces no new requirements — it hardens existing infrastructure without changing capability contracts. No requirement status transitions occurred.

## Forward Intelligence

### What the next milestone should know
- The ghost-milestone-regression.test.ts provides comprehensive coverage of discovery, state derivation, doctor diagnostics, regression guard, and e2e scenarios
- CONTEXT-only directories are valid queued milestones — the ghost problem was empty directories with zero content
- The advisory regression guard doesn't block writes — it warns but preserves STATE.md for usability

### What's fragile
- The advisory regression guard (D077) doesn't block STATE.md writes — if deriveState returns a wrong milestone, STATE.md gets written anyway with a warning comment. The real fix is in deriveState's filtering (S01), not in blocking state writers.
- Numeric milestone ID comparison (M010 → 10) works for current M### format but would need adjustment for milestone IDs like M010a.

### Authoritative diagnostics
- Run `gsd doctor` to see ghost milestone warnings with file inventory
- Check STATE.md for `> ⚠️ **Regression Guard:**` comment block
- Look for console warning when branch implies later milestone than deriveState returns
- Run `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` for full verification

### What assumptions changed
- Original assumption: CONTEXT-only directories are ghosts. Reality: they represent queued/seeded milestones and are valid.
- Original assumption: ghost directories are always empty. Reality: they may contain metadata files (CONTEXT.md without ROADMAP.md) — filtering handles this via isSubstantiveMilestone().
- Original assumption: rebuildState is a simple write. Reality: it now includes git branch inspection for regression detection.

## Files Created/Modified

- `src/resources/extensions/gsd/auto.ts` — Fixed duplicate `const unit = const unit =` syntax error at line 1747
- `src/resources/extensions/gsd/guided-flow.ts` — No changes needed (isSubstantiveMilestone already correct)
- `src/resources/extensions/gsd/doctor.ts` — Enhanced ghost diagnostics with directory contents and remediation guidance; added advisory regression guard in rebuildState
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — Added 9 new test cases (doctor diagnostics, regression guard, e2e), 77 total tests now passing
