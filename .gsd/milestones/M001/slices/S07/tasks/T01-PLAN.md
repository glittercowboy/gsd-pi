---
estimated_steps: 6
estimated_files: 4
---

# T01: Full lifecycle integration test + edge case tests

**Slice:** S07 — Integration Verification + Polish
**Milestone:** M001

## Description

Create two integration test files that prove the full M001 subsystem composition works end-to-end. The lifecycle test exercises the complete pipeline: realistic markdown fixtures on disk → `migrateFromMarkdown` → scoped DB queries → formatted prompt output → token savings validation → re-import after content changes → structured tool write-back → DB consistency verification. The edge case tests cover three scenarios with only per-module coverage today: empty project, partial migration, and fallback mode.

Both tests use real module imports (no mocks) with file-backed DBs and temp directories to match production behavior.

## Steps

1. Create `integration-lifecycle.test.ts`:
   - Set up temp directory with realistic `.gsd/` structure: DECISIONS.md with 12+ decisions across 2 milestones, REQUIREMENTS.md with 10+ requirements across 3 slices, and a hierarchy artifact (roadmap or plan file).
   - Duplicate fixture generators from token-savings.test.ts (they're file-scoped, can't import).
   - Open a file-backed DB → call `migrateFromMarkdown(basePath)` → verify import counts.
   - Query decisions scoped to one milestone → verify filtered count < total count.
   - Query requirements scoped to one slice → verify filtered count < total count.
   - Format scoped queries → verify output is non-empty and smaller than raw file content (≥30% savings).
   - Simulate content change: append a new decision row to DECISIONS.md, call `migrateFromMarkdown` again → verify DB row count increased.
   - Call `saveDecisionToDb` with a new decision → query back → verify round-trip.
   - Close DB, clean up.

2. Create `integration-edge.test.ts`:
   - **Empty project scenario**: create temp dir with empty `.gsd/` → `migrateFromMarkdown` → verify 0 imports → open DB → query decisions/requirements → verify empty arrays → format → verify empty strings.
   - **Partial migration scenario**: create temp dir with only DECISIONS.md (no REQUIREMENTS.md) → `migrateFromMarkdown` → verify decisions imported → query requirements → verify empty → no crash.
   - **Fallback mode scenario**: open DB normally → verify `isDbAvailable()` true → call `_resetProvider()` → verify `isDbAvailable()` false → query functions return null/empty → re-open DB → verify `isDbAvailable()` true again.

3. Both files use `createTestContext()`, `mkdtempSync` for isolation, `closeDatabase()` between groups, file-backed DB paths. Follow patterns from derive-state-db.test.ts and token-savings.test.ts.

## Must-Haves

- [ ] Lifecycle test crosses ≥3 module boundaries (gsd-db, md-importer, context-store, db-writer)
- [ ] Lifecycle test uses file-backed DB (not :memory:) for WAL fidelity
- [ ] Lifecycle test verifies ≥30% savings on scoped vs full content
- [ ] Lifecycle test proves re-import picks up content changes
- [ ] Lifecycle test proves saveDecisionToDb round-trip
- [ ] Edge test: empty project — 0 imports, empty queries, no crash
- [ ] Edge test: partial migration — decisions import, requirements empty, no crash
- [ ] Edge test: fallback mode — _resetProvider disables DB, queries degrade, re-open restores
- [ ] ≥60 combined assertions across both files

## Observability Impact

- **New signals**: Two test files produce assertion count summaries (`Results: N passed, M failed`) to stdout. Migration stderr logs (`gsd-migrate: imported ...`) confirm import behavior during test runs.
- **Inspection**: Run `npm run test:unit -- --test-name-pattern "integration-lifecycle|integration-edge"` to observe full pipeline diagnostics. Each assertion failure prints the expected vs actual values.
- **Failure state**: Test failures produce non-zero exit codes. Failed assertions include the module boundary that broke (e.g., "scoped decisions count" vs "format output size") for rapid triage.

## Verification

- `npm run test:unit -- --test-name-pattern "integration-lifecycle"` — passes
- `npm run test:unit -- --test-name-pattern "integration-edge"` — passes
- `npm run test:unit` — all pass, 0 regressions
- `npx tsc --noEmit` — clean

## Inputs

- `src/resources/extensions/gsd/tests/token-savings.test.ts` — fixture generator patterns (generateDecisionsMarkdown, generateRequirementsMarkdown)
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — temp directory + file-backed DB patterns
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — _resetProvider usage pattern
- `src/resources/extensions/gsd/tests/test-helpers.ts` — createTestContext

## Expected Output

- `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — new file, ~200 LOC, ≥40 assertions
- `src/resources/extensions/gsd/tests/integration-edge.test.ts` — new file, ~150 LOC, ≥20 assertions
