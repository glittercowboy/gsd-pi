---
estimated_steps: 4
estimated_files: 1
---

# T03: End-to-end damaged-state recovery test

**Slice:** S02 — Doctor lineage audit and STATE.md regression guard
**Milestone:** M010

## Description

Create a comprehensive end-to-end test that reproduces the observed user incident: ghost milestone directories exist alongside a real in-flight milestone. Run doctor → deriveState → rebuildState and verify the correct milestone stays active throughout.

## Steps

1. Create a fixture: ghost M001/M002 (empty dirs), ghost M003 (CONTEXT.md only), real M010 with ROADMAP and incomplete slices.
2. Call doctor checks — verify ghost warnings are emitted for M001, M002, M003 but not M010.
3. Call `deriveState()` — verify M010 is the active milestone.
4. Call `rebuildState()` — read STATE.md and verify it shows M010 as active.

## Must-Haves

- [ ] Full incident path tested end-to-end
- [ ] Doctor warnings emitted for ghosts only
- [ ] deriveState returns correct active milestone
- [ ] STATE.md reflects correct active milestone after rebuild

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — e2e test passes

## Inputs

- S01's hardened discovery (ghost filtering works)
- S02/T01's enhanced doctor diagnostics
- S02/T02's rebuildState guard

## Expected Output

- `src/resources/extensions/gsd/tests/ghost-milestone-regression.test.ts` — end-to-end damaged-state recovery test

## Observability Impact

- **What signals change:** The end-to-end test validates the full incident recovery path, proving that ghost directories don't pollute state derivation and doctor diagnostics surface them correctly.
- **How to inspect:** Run the e2e test and observe that doctor emits ghost warnings for M001/M002/M003 only, deriveState returns M010 as active, and STATE.md shows M010 after rebuild.
- **Failure visibility:** If the test fails, the assertion message will indicate which step in the path broke: ghost detection, state derivation, or STATE.md content.
