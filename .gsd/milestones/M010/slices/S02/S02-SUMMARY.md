---
id: S02
parent: M010
milestone: M010
provides:
  - Doctor ghost milestone diagnostics with directory contents inventory and remediation guidance
  - rebuildState regression guard that detects branch/milestone mismatches and warns in STATE.md
  - End-to-end test proving full damaged-state → doctor → deriveState → rebuildState path
requires:
  - slice: S01
    provides: isSubstantiveMilestone() filtering, findMilestoneIds() returning only verified milestones, deriveState() that never promotes a ghost to active, passing ghost-milestone-regression.test.ts
affects:
  - M010 closeout (final slice)
key_files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - Chose to show up to 5 files with overflow indicator (+N more) for large directories in ghost diagnostic
  - Chose advisory regression guard (warn but write anyway) rather than blocking guard to preserve write semantics
  - Used numeric comparison of milestone IDs (M010 → 10) to detect regressions rather than string comparison
patterns_established:
  - Doctor diagnostics now include actionable file inventory for ghost milestones
  - Advisory guards that preserve write semantics while surfacing diagnostics in output files
  - End-to-end tests should test the full incident path: fixture setup → doctor → deriveState → rebuildState
observability_surfaces:
  - Doctor issues with code `orphaned_milestone_directory` include directory contents and remediation guidance
  - STATE.md contains `> ⚠️ **Regression Guard:**` comment when branch/milestone mismatch detected
  - Console warning: `rebuildState: derived active milestone {X} differs from worktree lineage {Y} — possible regression`
drill_down_paths:
  - .gsd/milestones/M010/slices/S02/tasks/T01-SUMMARY.md
  - .gsd/milestones/M010/slices/S02/tasks/T02-SUMMARY.md
  - .gsd/milestones/M010/slices/S02/tasks/T03-SUMMARY.md
duration: 55m
verification_result: passed
completed_at: 2026-03-20T04:45:00Z
---

# S02: Doctor lineage audit and STATE.md regression guard

**Milestone:** M010
**Written:** 2026-03-20

## What Happened

This slice completed the recovery and doctor state regression hardening for M010 by ensuring doctor repair cannot regress the active milestone and surfaces ghost milestones with actionable diagnostics.

### T01: Enhanced Doctor Ghost Milestone Diagnostics

The `orphaned_milestone_directory` diagnostic was enhanced to make ghost milestones actionable for users. Previously, the warning only stated that a milestone directory had no substantive content. Now the diagnostic:

1. **Lists directory contents**: Uses `readdirSync()` to inventory files in the ghost directory, showing up to 5 files with an overflow indicator (`+N more`) for larger directories, or explicitly states "Directory is empty" for empty ghosts.

2. **Provides remediation guidance**: Includes actionable text: "Remove this directory to clean up, or add a ROADMAP.md to make it a real milestone."

Three test cases cover empty ghost directories, ghost directories with files, and ghost directories with many files (truncation).

### T02: rebuildState Regression Guard

Added an advisory regression guard in `rebuildState()` that detects and warns when the derived active milestone differs from the worktree branch lineage:

1. **Detects milestone branch context**: Checks if the current git branch matches `milestone/<MID>` pattern
2. **Compares numeric milestone IDs**: Extracts numeric values (M010 → 10) and compares them
3. **Logs warning to console**: Outputs message like `rebuildState: derived active milestone M010 differs from worktree lineage M020 — possible regression`
4. **Writes diagnostic comment to STATE.md**: Includes a warning block: `> ⚠️ **Regression Guard:** Worktree branch implies milestone M020 but derived state shows M010 as active.`
5. **Preserves write semantics**: The guard is advisory, not blocking — STATE.md is always written

Three unit tests cover mismatch scenario, match scenario, and non-milestone branch.

### T03: End-to-End Damaged-State Recovery Test

Created a comprehensive e2e test that reproduces the observed user incident: ghost milestone directories (M001, M002 as empty, M003 with only CONTEXT.md) existing alongside a real in-flight milestone (M010 with ROADMAP). The test verifies:

1. **Fixture setup**: Creates incident state with ghosts and real M010
2. **Doctor checks**: Verifies ghost warnings are emitted for M001/M002/M003 but NOT for M010
3. **deriveState()**: Verifies M010 is returned as active despite ghost presence
4. **rebuildState()**: Verifies STATE.md shows M010 as active with no regression warning

## Verification

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` | 0 | ✅ pass (77 tests) | 1.4s |
| 2 | `npx tsx --test 'src/resources/extensions/gsd/tests/factcheck-*.test.ts'` | 0 | ✅ pass (42 tests) | 1.9s |

All tests pass with no regressions. The verification confirms:
- Ghost filtering works (ghosts excluded from state derivation)
- Doctor diagnostics surface ghosts with actionable file inventory
- rebuildState regression guard detects and warns about potential regressions
- End-to-end path from damaged state through doctor to correct active milestone works

## Deviation From Plan

None. Implementation followed the task plan exactly.

## Known Limitations

- The regression guard is advisory — it warns but does not block STATE.md writes. This preserves write semantics but means a truly regressed state could still be written. Future work could add a blocking mode if stronger guarantees are needed.
- The numeric comparison (M010 → 10) works for the current M-numbering scheme but would need adjustment if milestone IDs change format.

## Follow-ups

None. All S02 tasks completed and verified.

## Files Created/Modified

- `src/resources/extensions/gsd/doctor.ts` — Enhanced ghost milestone diagnostics with directory contents and remediation guidance; added regression guard in rebuildState
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — Added 9 new test cases (3 doctor diagnostics, 3 regression guard, 1 e2e, plus supporting assertions)

## Forward Intelligence

### What the next slice should know

- The ghost-milestone-regression.test.ts now has 77 passing tests covering discovery, state derivation, doctor diagnostics, regression guard, and e2e scenarios
- All observability surfaces are working: doctor output, STATE.md comments, and console warnings
- The M010 milestone is now fully hardened — S01 fixed deriveState, S02 fixed doctor and added regression guard

### What's fragile

- The advisory regression guard doesn't block writes — if deriveState returns a wrong milestone, STATE.md gets written anyway. The warning helps debugging but doesn't prevent damage.
- Numeric milestone ID comparison assumes M### format — milestone IDs like M010a or milestone groups would break the detection logic.

### Authoritative diagnostics

- Run `gsd doctor` to see ghost milestone warnings with file inventory
- Check STATE.md for `> ⚠️ **Regression Guard:**` comment block
- Look for console warning when branch implies later milestone than deriveState returns

### What assumptions changed

- Original assumption: ghost directories are always empty. Reality: they may contain metadata files (CONTEXT.md without ROADMAP.md) — the filtering handles this via isSubstantiveMilestone()
- Original assumption: rebuildState is a simple write. Reality: it now includes git branch inspection for regression detection
