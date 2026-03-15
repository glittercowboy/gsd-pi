---
id: T01
parent: S07
milestone: M001
provides:
  - Full lifecycle integration test crossing 4 module boundaries (gsd-db, md-importer, context-store, db-writer)
  - Edge case integration tests covering empty project, partial migration, and fallback mode
key_files:
  - src/resources/extensions/gsd/tests/integration-lifecycle.test.ts
  - src/resources/extensions/gsd/tests/integration-edge.test.ts
key_decisions:
  - Used file-backed DB (not :memory:) in lifecycle test for WAL fidelity match with production
  - Duplicated fixture generators from token-savings.test.ts since they are file-scoped
patterns_established:
  - Integration test pattern: realistic temp directory → migrateFromMarkdown → scoped queries → format → savings validation → re-import → write-back → round-trip
  - Edge case coverage pattern: empty project / partial migration / fallback mode via _resetProvider
observability_surfaces:
  - Test assertion summaries printed to stdout (Results: N passed, M failed)
  - Migration stderr logs (gsd-migrate: imported N decisions, N requirements, N artifacts) visible in test output
duration: 12m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T01: Full lifecycle integration test + edge case tests

**Created 83 integration assertions across 2 test files proving full M001 subsystem composition and 3 edge cases**

## What Happened

Created `integration-lifecycle.test.ts` (50 assertions) and `integration-edge.test.ts` (33 assertions) that prove end-to-end composition of the M001 memory-db subsystem.

The lifecycle test exercises the complete pipeline: realistic markdown fixtures on disk (14 decisions across 2 milestones, 12 requirements across 5 slices, plus a roadmap artifact) → `openDatabase` with file-backed path → `migrateFromMarkdown` → scoped `queryDecisions`/`queryRequirements` → `formatDecisionsForPrompt`/`formatRequirementsForPrompt` → token savings validation (42.4% savings, ≥30% required) → content change re-import (append decision, re-migrate, verify count increased) → `saveDecisionToDb` write-back → `parseDecisionsTable` round-trip verification → DB consistency check.

The edge case test covers three scenarios: (1) empty project — 0 imports, empty queries, empty format output, no crash; (2) partial migration — DECISIONS.md only, requirements queries return empty gracefully; (3) fallback mode — `_resetProvider` disables DB, queries degrade to empty arrays, re-open restores full functionality.

Both tests use real module imports (no mocks), file-backed DBs, and temp directories matching production behavior.

## Verification

- `npm run test:unit -- --test-name-pattern "integration-lifecycle"` — 50 assertions passed ✓
- `npm run test:unit -- --test-name-pattern "integration-edge"` — 33 assertions passed ✓
- `npm run test:unit` — 293 tests pass, 0 fail, 0 regressions ✓
- `npx tsc --noEmit` — clean compilation ✓
- Token savings: 42.4% (≥30% threshold met) ✓
- Combined assertions: 83 (≥60 threshold met) ✓

### Slice-level verification status (T01 is first of 2 tasks):
- [x] `npm run test:unit -- --test-name-pattern "integration-lifecycle"` — passes with ≥40 assertions (50)
- [x] `npm run test:unit -- --test-name-pattern "integration-edge"` — passes with ≥20 assertions (33)
- [x] `npm run test:unit` — 293 pass, 0 regressions (≥291 threshold met)
- [x] `npx tsc --noEmit` — clean
- [ ] R001 and R019 show `status: validated` — deferred to T02

## Diagnostics

Run `npm run test:unit -- --test-name-pattern "integration-lifecycle|integration-edge"` to re-verify. Test output includes assertion counts and token savings percentages. Failed assertions print expected vs actual values with the specific module boundary that broke.

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — new, ~230 LOC, 50 assertions covering full lifecycle pipeline
- `src/resources/extensions/gsd/tests/integration-edge.test.ts` — new, ~175 LOC, 33 assertions covering 3 edge cases
- `.gsd/milestones/M001/slices/S07/S07-PLAN.md` — added Observability / Diagnostics section, marked T01 done
- `.gsd/milestones/M001/slices/S07/tasks/T01-PLAN.md` — added Observability Impact section
