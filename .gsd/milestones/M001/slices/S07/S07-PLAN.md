# S07: Integration Verification + Polish

**Goal:** Prove that all M001 subsystems compose correctly end-to-end by exercising the full lifecycle (migration → DB open → scoped queries → token savings → re-import) and edge cases (empty project, partial migration, fallback mode) in integration-level tests. Validate R001 and R019.

**Demo:** `npm run test:unit -- --test-name-pattern "integration-lifecycle|integration-edge"` passes with ≥60 assertions covering full lifecycle and all three edge case scenarios. R001 and R019 statuses updated to "validated" in REQUIREMENTS.md.

## Must-Haves

- Full lifecycle integration test crossing ≥3 module boundaries (gsd-db → md-importer → context-store → format → verify round-trip consistency)
- Edge case coverage: empty project, partial migration, fallback mode — all at integration level
- R001 status updated to "validated" with proof summary
- R019 status updated to "validated" with proof reference to the lifecycle integration test

## Proof Level

- This slice proves: final-assembly
- Real runtime required: no (test-level proof with real module imports, no mocks)
- Human/UAT required: yes — R019 is fully proven at the test level ("same data in = same prompt out"), but actual LLM output quality is a UAT concern. Integration test is the necessary condition; UAT is the sufficient condition.

## Verification

- `npm run test:unit -- --test-name-pattern "integration-lifecycle"` — full lifecycle test passes with ≥40 assertions
- `npm run test:unit -- --test-name-pattern "integration-edge"` — edge case tests pass with ≥20 assertions
- `npm run test:unit` — all tests pass, 0 regressions (≥291 + new tests)
- `npx tsc --noEmit` — clean compilation
- R001 and R019 both show `status: validated` in REQUIREMENTS.md

## Integration Closure

- Upstream surfaces consumed: gsd-db.ts (openDatabase, closeDatabase, isDbAvailable, insertDecision, insertRequirement, insertArtifact, _resetProvider), md-importer.ts (migrateFromMarkdown), context-store.ts (queryDecisions, queryRequirements, formatDecisionsForPrompt, formatRequirementsForPrompt, queryArtifact, queryProject), db-writer.ts (saveDecisionToDb)
- New wiring introduced in this slice: none — purely verification
- What remains before the milestone is truly usable end-to-end: UAT on a real project (R019 sufficient condition)

## Tasks

- [x] **T01: Full lifecycle integration test + edge case tests** `est:25m`
  - Why: No existing test crosses more than 2 module boundaries. This proves the full composition: markdown on disk → migrateFromMarkdown → DB queries with scoping → token savings math → re-import after content changes → structured tool write-back → DB consistency. Also covers 3 edge cases that have only per-module coverage.
  - Files: `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts`, `src/resources/extensions/gsd/tests/integration-edge.test.ts`
  - Do:
    1. Create `integration-lifecycle.test.ts` with a realistic `.gsd/` temp directory containing DECISIONS.md (multi-milestone), REQUIREMENTS.md (multi-slice), and at least one hierarchy artifact. Exercise: `openDatabase(file-backed)` → `migrateFromMarkdown(basePath)` → `queryDecisions` with milestone scope → `queryRequirements` with slice scope → `formatDecisionsForPrompt` / `formatRequirementsForPrompt` → verify scoped output is smaller than full content → verify savings ≥30% → simulate content change (write new markdown, call `migrateFromMarkdown` again) → verify DB reflects changes → call `saveDecisionToDb` → verify round-trip (DB → generateDecisionsMd → parseDecisionsTable → compare). Use file-backed DB (not `:memory:`) to match production WAL behavior.
    2. Create `integration-edge.test.ts` with three scenarios: (a) empty project — no markdown files → migration finds nothing → queries return empty arrays → format functions return empty strings, (b) partial migration — DECISIONS.md exists but no REQUIREMENTS.md → decisions import, requirements queries return empty → no crash, (c) fallback mode — `_resetProvider()` → `isDbAvailable()` returns false → queries return null/empty → restore provider via re-open.
    3. Reuse fixture generator patterns from token-savings.test.ts (duplicate locally since they're file-scoped). Use `createTestContext()` from test-helpers.ts. Use `mkdtempSync` for temp dirs. Call `closeDatabase()` between test groups.
  - Verify: `npm run test:unit -- --test-name-pattern "integration-lifecycle|integration-edge"` — all pass, ≥60 assertions total
  - Done when: Both test files pass with ≥60 combined assertions proving full lifecycle composition and all 3 edge cases

- [x] **T02: Validate R001 + R019 and update REQUIREMENTS.md** `est:10m`
  - Why: R001 is fully proven by S01+S02+S07 but still marked "active". R019 needs the lifecycle integration test as its validation proof. Both need status bumps and proof summaries in REQUIREMENTS.md. Also update the traceability table and coverage summary.
  - Files: `.gsd/REQUIREMENTS.md`
  - Do:
    1. Update R001 Active section: change `Status: active` → `Status: validated`, update Validation field to reference S01 DB layer + S02 schema migration + S07 lifecycle integration test proof.
    2. Update R019 Active section: change `Status: active` → `Status: validated`, update Validation field to reference S07 lifecycle integration test ("same data in = same prompt out" proven across full pipeline; UAT for LLM output quality is a separate concern).
    3. Add R001 and R019 entries to the Validated section with proof summaries.
    4. Update traceability table: R001 and R019 status → `validated`.
    5. Update coverage summary: Active requirements → 0, Validated → 21.
  - Verify: `grep -c "status: active" .gsd/REQUIREMENTS.md` in the Active section headers — should be 0 active requirements remaining. Validated count = 21.
  - Done when: R001 and R019 both show validated status with proof summaries, traceability table updated, coverage summary shows 0 active / 21 validated

## Observability / Diagnostics

- **Test output**: Both integration tests use `createTestContext()` which prints `FAIL: <message>` to stderr for each failed assertion and a final `Results: N passed, M failed` summary. Non-zero exit code on any failure.
- **Migration logging**: `migrateFromMarkdown` writes `gsd-migrate: imported N decisions, N requirements, N artifacts` to stderr — visible in test output for debugging import issues.
- **DB writer errors**: `saveDecisionToDb` writes `gsd-db: saveDecisionToDb failed: <message>` to stderr on failure.
- **Failure visibility**: All assertions include descriptive messages that identify which module boundary failed (e.g., "M001 decisions: expected 8, got N"). Test runner surfaces these in CI logs.
- **No secrets or PII**: Test fixtures use synthetic data only. No redaction needed.

## Files Likely Touched

- `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` (new)
- `src/resources/extensions/gsd/tests/integration-edge.test.ts` (new)
- `.gsd/REQUIREMENTS.md`
