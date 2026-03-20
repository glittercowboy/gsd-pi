---
verdict: pass
remediation_round: 0
---

# Milestone Validation: M010

## Success Criteria Checklist

- [x] **Ghost milestone directories never become the active milestone in `deriveState()`**
  - Evidence: `isSubstantiveMilestone()` in guided-flow.ts:315 filters empty directories. It checks for ROADMAP.md, SUMMARY.md, or populated slices/ directory. CONTEXT.md alone is NOT sufficient. 77 regression tests pass, proving ghost filtering works.

- [x] **Doctor repair does not regress the active milestone**
  - Evidence: Doctor's `orphaned_milestone_directory` diagnostic (doctor.ts:1097) detects ghost directories and provides actionable file inventory. The rebuildState regression guard (doctor.ts:211) detects worktree branch vs derived milestone mismatch and warns.

- [x] **After doctor repair on damaged state, `/gsd auto` resumes on the correct milestone**
  - Evidence: ghost-milestone-regression.test.ts includes e2e test "End-to-end damaged-state recovery test" that proves: fixture setup with ghosts + real M010 → doctor checks emit warnings → deriveState() returns M010 as active → rebuildState writes M010 to STATE.md. 77/77 tests pass.

- [x] **Regression tests reproduce the observed user incident and prove it stays fixed**
  - Evidence: ghost-milestone-regression.test.ts expanded from 25 tests (S01) to 77 tests (S02), covering discovery, state derivation, doctor diagnostics, regression guard, and e2e scenarios. All pass.

## Slice Delivery Audit

| Slice | Claimed | Delivered | Status |
|-------|---------|-----------|--------|
| S01   | isSubstantiveMilestone() filters empty ghost directories, findMilestoneIds() returns only verified milestones, deriveState() never activates a ghost, passing regression test | Implemented: isSubstantiveMilestone checks for ROADMAP.md/SUMMARY.md/populated slices; findMilestoneIds filters using it; 25 tests passed | ✅ pass |
| S02   | Doctor ghost diagnostics with file inventory, rebuildState regression guard, e2e damaged-state test | Implemented: orphaned_milestone_directory includes directory contents; rebuildState compares branch vs derived milestone, warns to console and STATE.md; e2e test validates full path; 77 tests total | ✅ pass |

## Cross-Slice Integration

- **S01 → S02 boundary**: Verified. S02's doctor.ts and test additions build on S01's hardened `isSubstantiveMilestone` and `findMilestoneIds`. Test suite passes after both slices, confirming integration works.
- **Consumes/Produces alignment**: S01 produces the filtering functions; S02 consumes them for doctor diagnostics and regression guard. Boundary map matches implementation.

## Requirement Coverage

- M010 introduces no new requirements (hardens existing infrastructure per roadmap). No active requirements to cover.
- No orphan risks — the work addresses an observed incident, not a requirements gap.

## Verdict Rationale

All success criteria are met with concrete evidence:
1. Test results: 77/77 regression tests pass, 42/42 factcheck tests pass, 2/2 worktree tests pass
2. Implementation verified: isSubstantiveMilestone filters correctly, doctor diagnostics include file inventory, rebuildState has regression guard
3. E2E proof: damaged-state recovery test validates full path from ghost presence through doctor to correct active milestone

The key insight from the incident (D076) is codified: CONTEXT.md alone does NOT make a milestone substantive — only ROADMAP.md, SUMMARY.md, or populated slices/ do. This prevents doctor repair from creating skeleton directories that outrank real in-flight milestones.

The advisory regression guard (D077) is the right design choice — it surfaces the problem without making it worse by blocking STATE.md writes.

**Verdict: PASS** — Milestone M010 is complete.
