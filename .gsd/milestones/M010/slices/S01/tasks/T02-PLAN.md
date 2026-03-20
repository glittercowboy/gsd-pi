---
estimated_steps: 4
estimated_files: 2
---

# T02: Strengthen isSubstantiveMilestone to reject metadata-only skeletons

**Slice:** S01 — Hardened milestone discovery and deriveState ghost rejection
**Milestone:** M010

## Description

Refine `isSubstantiveMilestone` so that CONTEXT.md and CONTEXT-DRAFT.md alone do not qualify a directory as substantive. A milestone needs at least ROADMAP.md, SUMMARY.md, or a populated slices/ directory to enter the active-milestone election. CONTEXT-only directories represent queued/seeded milestones, not real in-flight work.

## Steps

1. In `guided-flow.ts`, modify `isSubstantiveMilestone` to remove `CONTEXT.md` and `CONTEXT-DRAFT.md` from the artifact files that qualify a milestone as substantive. Keep only ROADMAP.md and SUMMARY.md in the artifact check list.
2. Ensure the slices/ directory check remains (populated slices = substantive).
3. Add edge-case tests to `ghost-milestone-regression.test.ts`: CONTEXT-only dir → false, ROADMAP dir → true, SUMMARY-only dir → true, empty dir → false, slices dir → true.
4. Run the full regression test to confirm ghost M001/M002 (empty dirs) don't steal active status from real M005.

## Must-Haves

- [ ] `isSubstantiveMilestone` returns false for empty directories
- [ ] `isSubstantiveMilestone` returns false for CONTEXT-only directories
- [ ] `isSubstantiveMilestone` returns true for ROADMAP, SUMMARY, or slices directories
- [ ] `deriveState()` activates M005 when ghost M001/M002 exist

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — all pass

## Inputs

- `src/resources/extensions/gsd/guided-flow.ts` — `isSubstantiveMilestone` at line 315
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — existing regression test

## Expected Output

- `src/resources/extensions/gsd/guided-flow.ts` — hardened `isSubstantiveMilestone`
- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — edge-case coverage added
