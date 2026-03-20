---
estimated_steps: 3
estimated_files: 1
---

# T01: Enhance doctor ghost milestone diagnostics

**Slice:** S02 — Doctor lineage audit and STATE.md regression guard
**Milestone:** M010

## Description

Improve the `orphaned_milestone_directory` warning in doctor to include a contents inventory and remediation guidance, making ghost milestones actionable for users.

## Steps

1. In `doctor.ts`, where `orphaned_milestone_directory` issues are pushed, read the directory contents with `readdirSync` and list the files present.
2. Include remediation guidance in the message: "Remove this directory to clean up, or add a ROADMAP.md to make it a real milestone."
3. Add a test case in `ghost-milestone-regression.test.ts` that runs doctor checks on a fixture with ghost directories and verifies the diagnostic message includes file listing and guidance.

## Must-Haves

- [ ] Doctor ghost milestone warning includes directory contents
- [ ] Doctor ghost milestone warning includes remediation guidance

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — doctor diagnostics test passes

## Inputs

- S01's hardened `isSubstantiveMilestone` (ghost detection works correctly)
- `src/resources/extensions/gsd/doctor.ts` — existing ghost milestone detection at ~line 1046

## Expected Output

- `src/resources/extensions/gsd/doctor.ts` — enhanced diagnostic messages
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — doctor diagnostic test
