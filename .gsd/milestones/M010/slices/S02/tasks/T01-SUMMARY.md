---
id: T01
parent: S02
milestone: M010
provides:
  - Enhanced ghost milestone diagnostic with directory contents inventory
  - Remediation guidance for orphaned milestone directories
key_files:
  - src/resources/extensions/gsd/doctor.ts
  - src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
key_decisions:
  - Chose to show up to 5 files with overflow indicator (+N more) for large directories
  - Included both removal and ROADMAP-creation guidance in the message
patterns_established:
  - Doctor diagnostics now include actionable file inventory for ghost milestones
observability_surfaces:
  - Doctor issues with code `orphaned_milestone_directory` now include directory contents inventory and remediation guidance
duration: 15m
verification_result: passed
completed_at: 2026-03-20T04:10:00Z
blocker_discovered: false
---

# T01: Enhance doctor ghost milestone diagnostics

**Enhanced orphaned_milestone_directory warnings with directory contents inventory and remediation guidance.**

## What Happened

The task improved the `orphaned_milestone_directory` diagnostic in `runGSDDoctor()` to make ghost milestones actionable for users. Previously, the warning only stated that a milestone directory had no substantive content and would be excluded from state derivation. Now the diagnostic:

1. **Lists directory contents**: Uses `readdirSync()` to inventory files in the ghost directory, showing up to 5 files with an overflow indicator (`+N more`) for larger directories, or explicitly states "Directory is empty" for empty ghosts.

2. **Provides remediation guidance**: Includes actionable text: "Remove this directory to clean up, or add a ROADMAP.md to make it a real milestone."

Three test cases were added to `ghost-milestone-regression.test.ts` covering:
- Empty ghost directories (verifies "Directory is empty" message)
- Ghost directories with files (verifies file listing)
- Ghost directories with many files (verifies truncation with overflow indicator)

## Verification

Ran the full test suite for ghost milestone regression tests, verifying all 45 tests pass including the 3 new doctor diagnostic tests. Also ran factcheck tests to confirm no regressions.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` | 0 | ✅ pass | 1.1s |
| 2 | `npx tsx --test 'src/resources/extensions/gsd/tests/factcheck-*.test.ts'` | 0 | ✅ pass | 1.5s |

## Diagnostics

To inspect the enhanced diagnostics after this change:
- Run `gsd doctor` on a project with ghost milestone directories
- Look for issues with code `orphaned_milestone_directory` in the output
- The message will now include either "Contents: file1.txt, file2.txt..." or "Directory is empty."
- The message ends with remediation guidance for cleanup or conversion to a real milestone.

## Deviations

None. Implementation followed the task plan exactly.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/doctor.ts` — Enhanced `orphaned_milestone_directory` diagnostic with directory contents inventory and remediation guidance
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — Added 3 test cases for doctor ghost milestone diagnostics (empty, with files, long file list)
