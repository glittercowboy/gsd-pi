# S01: Hardened milestone discovery and deriveState ghost rejection — UAT

**Milestone:** M010
**Written:** 2026-03-20

## UAT Type

- UAT mode: artifact-driven (regression test suite)
- Why this mode is sufficient: The ghost-milestone-regression.test.ts provides comprehensive coverage of all ghost rejection scenarios. Running this test suite is the definitive proof that the slice works.

## Preconditions

- Node.js 22+ with npx available
- Project at `/home/ubuntulinuxqa2/repos/gsd-2`
- No special setup required - tests create temporary fixtures

## Smoke Test

```bash
cd /home/ubuntulinuxqa2/repos/gsd-2
npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts
```

**Expected:** All 25 tests pass with exit code 0.

## Test Cases

### 1. Ghost directories should not become active milestone

1. Create empty milestone directories M001 and M002 (no files)
2. Create real M005 with ROADMAP.md containing an incomplete slice
3. Add a plan with incomplete tasks to M005
4. Call `deriveState(basePath)`
5. **Expected:** `state.activeMilestone.id === 'M005'` — the real milestone is active, NOT the ghost M001

### 2. Ghost-only project should not activate any milestone

1. Create only empty milestone directories M001, M002, M003 (no files)
2. Call `deriveState(basePath)`
3. **Expected:** `state.activeMilestone === null` — no active milestone when all are ghosts

### 3. Mixed complete and ghost milestones

1. Create M001 with SUMMARY.md (completed milestone)
2. Create M002 as empty ghost directory
3. Create M003 with ROADMAP.md (active milestone)
4. Call `deriveState(basePath)`
5. **Expected:** M003 is active, NOT M002 (ghost)

### 4. CONTEXT-only milestone is substantive (queued milestone)

1. Create M001 with only M001-CONTEXT.md file
2. Call `isSubstantiveMilestone(basePath, 'M001')`
3. **Expected:** Returns `true` — CONTEXT-only milestones are valid queued items

### 5. SUMMARY-only milestone is substantive (completed milestone)

1. Create M002 with only M002-SUMMARY.md file
2. Call `isSubstantiveMilestone(basePath, 'M002')`
3. **Expected:** Returns `true` — SUMMARY means milestone completed

### 6. CONTEXT-DRAFT-only milestone is substantive (seeded milestone)

1. Create M003 with only M003-CONTEXT-DRAFT.md file
2. Call `isSubstantiveMilestone(basePath, 'M003')`
3. **Expected:** Returns `true` — DRAFT context is valid

### 7. Empty directory is NOT substantive (ghost)

1. Create M004 as empty directory (no files)
2. Call `isSubstantiveMilestone(basePath, 'M004')`
3. **Expected:** Returns `false` — empty = ghost, filtered out

### 8. Non-milestone file is NOT substantive

1. Create M005 with only notes.txt (not a milestone artifact)
2. Call `isSubstantiveMilestone(basePath, 'M005')`
3. **Expected:** Returns `false` — random files don't make a milestone

### 9. Populated slices directory is substantive

1. Create M006 with slices/S01/ subdirectory (no artifact files)
2. Call `isSubstantiveMilestone(basePath, 'M006')`
3. **Expected:** Returns `true` — has work-in-progress slices

### 10. Regression check: no factcheck test regressions

1. Run `npx tsx --test 'src/resources/extensions/gsd/tests/factcheck-*.test.ts'`
2. **Expected:** All 42 tests pass

## Edge Cases

### Edge Case: Ghost with depends_on frontmatter

- Create empty M001 directory
- Add a depends_on file (not a milestone artifact)
- **Expected:** `isSubstantiveMilestone` returns false — still a ghost

### Edge Case: Multiple ghosts alongside real milestone

- Create 10 empty ghost directories (M001-M010)
- Create M011 with ROADMAP.md
- **Expected:** Only M011 appears in `findMilestoneIds()` result

## Failure Signals

- Any test in ghost-milestone-regression.test.ts fails → ghost rejection not working
- `state.activeMilestone` is a ghost ID (empty directory) → derivation broken
- Registry contains ghost milestone with `status: 'active'` → bug in filtering
- factcheck tests fail → regression in unrelated area

## Not Proven By This UAT

- Doctor diagnostics for ghost milestones (deferred to S02)
- rebuildState regression guard (deferred to S02)
- End-to-end damaged-state → doctor → auto-resume (deferred to S02)

## Notes for Tester

- The test suite uses temporary directories (mkdtempSync) - no side effects
- Tests are fast (~1.2s total)
- All assertions have clear failure messages indicating which ghost incorrectly became active
- The implementation treats CONTEXT-only as substantive by design - this is correct because CONTEXT represents queued/seeded work, not empty ghosts
