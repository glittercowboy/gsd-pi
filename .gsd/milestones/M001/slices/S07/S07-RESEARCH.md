# M001/S07 — Integration Verification + Polish — Research

**Date:** 2026-03-15

## Summary

S07 is the final integration slice for M001. All six prior slices (S01–S06) have landed: the DB layer, importers, prompt rewiring, token measurement, worktree isolation, structured tools, and `/gsd inspect` are implemented with 291 passing tests and clean compilation. The remaining work is verification that these pieces compose correctly end-to-end, plus validating the two remaining active requirements: R001 (already functionally proven by S01+S02 — just needs status bump to "validated") and R019 (no output quality regression — the only genuinely unproven requirement).

The codebase is in solid shape. The 10 DB test files total ~3,900 LOC with ~500 assertions covering individual subsystems. What's missing is an **integration-level test** that exercises the full lifecycle as `startAuto` would: markdown project on disk → auto-migration → DB opens → prompt builder queries scoped data → token measurement captures savings → handleAgentEnd re-imports → structured tools write back. No single test currently crosses more than two module boundaries.

Edge cases (empty projects, partial migrations, fallback mode) each have partial coverage in isolation but no integration-level verification. The existing per-module tests are thorough enough that the risk here is low — this is a "prove the composition" exercise, not a "find bugs" exercise.

## Recommendation

**Three focused tasks:**

1. **Full lifecycle integration test** — Create a test that stands up a realistic `.gsd/` directory with decisions, requirements, and hierarchy artifacts, then exercises: `openDatabase` → `migrateFromMarkdown` → query scoped decisions/requirements → verify token savings math → simulate re-import after content changes → verify DB consistency after round-trip. This proves the composition works end-to-end and retires R019 at the test level.

2. **Edge case integration tests** — Three scenarios that aren't covered at the integration level:
   - Empty project: no `.gsd/` markdown files at all → migration finds nothing → queries return empty → prompts gracefully degrade
   - Partial migration: DECISIONS.md exists but no REQUIREMENTS.md → decisions import succeeds, requirements skip → queries work for what's available
   - Fallback mode: `_resetProvider()` + prevent load → `isDbAvailable()` returns false → prompt builders fall back to `inlineGsdRootFile` → no crash

3. **R001 + R019 validation status update** — R001 is fully proven (DB opens, schema inits, versioned migrations, typed wrappers, WAL mode) but still marked "active" — update to "validated". R019 needs the integration test from task 1 as its validation proof.

No new code changes to production modules are needed. This is purely test + documentation work.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Test assertions | `createTestContext()` in `test-helpers.ts` | All S01–S06 tests use this pattern — assertEq/assertTrue/assertMatch with counter-based reporting. Consistency matters. |
| Temp dir management | `mkdtempSync(join(tmpdir(), 'prefix-'))` | Standard pattern used in all DB test files. Clean isolation. |
| Fixture data | `generateDecisionsMarkdown()` / `generateRequirementsMarkdown()` in `token-savings.test.ts` | Realistic fixture generators already exist — reuse for integration tests. |
| DB lifecycle in tests | `openDatabase(':memory:')` / `closeDatabase()` | In-memory DBs avoid filesystem cleanup. Used consistently across all 10 test files. |

## Existing Code and Patterns

- `src/resources/extensions/gsd/tests/token-savings.test.ts` — Contains fixture generators (`generateDecisionsMarkdown`, `generateRequirementsMarkdown`) that create realistic multi-milestone, multi-slice data. Reuse these for integration test fixtures.
- `src/resources/extensions/gsd/tests/prompt-db.test.ts` — Demonstrates the pattern for testing DB-aware query → format → wrap pipeline. The re-import test (line 318–385) is the closest existing code to a lifecycle test.
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — Has edge case patterns: DB path, fallback, empty DB, partial DB — all with temp directories on disk. The partial-DB scenario (line 214+) creates a DB with only some artifacts and verifies the fallback chain.
- `src/resources/extensions/gsd/auto.ts` — The `startAuto()` function (line 556) contains the auto-migration flow. Lines 637–665 are the migration + DB open sequence. Line 876–882 is the handleAgentEnd re-import. Lines 2494–2553 are the three DB-aware helpers.
- `src/resources/extensions/gsd/gsd-db.ts` — `_resetProvider()` (line 674) is the testing hook for simulating provider unavailability. Used in `gsd-db.test.ts` line 333+.
- `src/resources/extensions/gsd/md-importer.ts` — `migrateFromMarkdown()` (line 485) wraps all three importers in independent try/catch inside a transaction. Partial migration is already handled.

## Constraints

- Tests must use Node's built-in test runner with `--experimental-strip-types` — no vitest/jest
- All assertion patterns must use `createTestContext()` from `test-helpers.ts` for consistency
- DB tests that need filesystem artifacts must use `mkdtempSync` for isolation — no writing to the working tree
- `_resetProvider()` is the only way to test fallback mode without actually uninstalling `node:sqlite` — it's a test-only export
- Integration tests should exercise real module imports (not mocks) to prove composition

## Common Pitfalls

- **In-memory DB doesn't set WAL mode** — `openDatabase(':memory:')` creates a non-WAL database (WAL only works on file-backed DBs). Tests that need WAL verification must use a temp file path. The lifecycle integration test should use a file-backed DB to match production behavior.
- **`migrateFromMarkdown` gsdDir convention** — Per D013, the `gsdDir` parameter is the project root, NOT the `.gsd/` directory. The function joins `gsdDir + '.gsd/'` internally. Getting this wrong causes silent import failures (0 artifacts imported).
- **`closeDatabase()` must be called between test groups** — Module-scoped `currentDb` persists across test blocks. If one block opens a DB and the next opens a different one without closing first, the second open is a no-op (it checks `if (currentDb) return true`). This causes cross-contamination.
- **Fixture generators are not exported** — `generateDecisionsMarkdown` and `generateRequirementsMarkdown` in `token-savings.test.ts` are file-scoped functions. The integration test will need to either duplicate them or extract them to a shared test helper.
- **Dynamic import paths resolve at runtime** — The `await import("./gsd-db.js")` calls in auto.ts resolve relative to the compiled output. Integration tests that import from `.ts` files directly work fine because `--experimental-strip-types` handles the resolution, but the pattern means any path changes silently break at runtime.

## Open Risks

- **R019 validation is inherently qualitative** — "No regression in auto-mode output quality" can only be fully proven by running auto-mode on a real project and comparing outputs. The integration test can prove equivalent data flows through the pipeline, but actual LLM output quality is a UAT concern, not something a unit/integration test can definitively prove. The test proves "same data in = same prompt out" which is a necessary (but not sufficient) condition.
- **Fixture data distribution vs real projects** — Token savings percentages depend on how decisions/requirements are distributed across milestones/slices. The 52.2%/66.3%/32.2% figures from S04 use evenly distributed fixtures. Real projects may have skewed distributions. This risk is already acknowledged in S04's forward intelligence.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| SQLite | `martinholovsky/claude-skills-generator@sqlite database expert` (556 installs) | Available — not relevant (generic SQLite guidance; this project has a mature custom SQLite layer) |
| Node.js testing | none found | No skills needed — using built-in Node test runner |

## Sources

- Codebase exploration of all 10 DB module test files (gsd-db, context-store, md-importer, prompt-db, derive-state-db, token-savings, worktree-db, gsd-tools, gsd-inspect, db-writer) — ~3,900 LOC, ~500 assertions, all passing
- S03 forward intelligence: dynamic import paths are fragile; grep `inlineGsdRootFile` auto.ts should be exactly 7
- S04 forward intelligence: savings vary by fixture distribution; module-scoped vars reset per dispatch
- S05 forward intelligence: DB operations in worktree lifecycle are entirely non-fatal
- S06 forward intelligence: round-trip fidelity depends on exact markdown format matching between generators and parsers
