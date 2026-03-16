# S07: Integration Verification + Polish — Research

**Date:** 2026-03-15

## Summary

S07 is verification-only. Every subsystem was built and individually tested in S03–S06. This slice composes the cross-cutting integration tests that prove the full pipeline holds together: migration → scoped queries → formatted prompts → token savings → re-import → structured write-back → round-trip fidelity → edge cases → final requirements validation.

Two integration test files need to be ported from the memory-db reference (verbatim, zero adaptation required — import paths match the M004 layout exactly, same as every previous port). Then requirements R045–R052 and R057 are promoted from active → validated, and the milestone acceptance criteria are checked off. No production code changes are expected.

The current baseline is healthy: 369 tests pass (0 failures) in the main suite, `tsc --noEmit` is clean, and the single pre-existing failure (`pack-install.test.ts`, needs built `dist/`) is unrelated to M004 work.

## Recommendation

Port `integration-lifecycle.test.ts` and `integration-edge.test.ts` from the memory-db reference. Run the full suite. Promote requirements. Done.

All imports in the memory-db test files already exist in M004: `openDatabase`, `closeDatabase`, `isDbAvailable`, `_getAdapter`, `_resetProvider`, `migrateFromMarkdown`, `parseDecisionsTable`, `queryDecisions`, `queryRequirements`, `formatDecisionsForPrompt`, `formatRequirementsForPrompt`, `saveDecisionToDb`, `generateDecisionsMd`. No adaptation needed.

## Implementation Landscape

### Key Files

- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — 277-line source. Full pipeline: temp dir with `.gsd/` structure → `migrateFromMarkdown` → scoped `queryDecisions`/`queryRequirements` → `formatDecisionsForPrompt`/`formatRequirementsForPrompt` → token savings assertion (≥30%) → content change → `migrateFromMarkdown` re-import → `saveDecisionToDb` write-back → parse-regenerate-parse round-trip → final count consistency. 8 sequential steps, all under one `try/finally` with cleanup. **Port verbatim to `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts`.**

- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/integration-edge.test.ts` — 228-line source. Three scenarios: (1) empty project — `migrateFromMarkdown` on empty `.gsd/` returns all zeros, queries return empty arrays, formatters return empty strings; (2) partial migration — only `DECISIONS.md` present, requirements path non-fatal; (3) fallback mode — `closeDatabase()` + `_resetProvider()` makes `isDbAvailable()` false, queries return empty, `openDatabase()` restores. **Port verbatim to `src/resources/extensions/gsd/tests/integration-edge.test.ts`.**

- `src/resources/extensions/gsd/tests/token-savings.test.ts` — already present. 99 assertions, 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite savings — all ≥30%. This is the R057 proof. No work needed; just reference it in the requirements update.

- `.gsd/REQUIREMENTS.md` — 8 active requirements (R045–R052, R057) need to be promoted to validated after the integration tests pass. Update Validation fields with test file references and assertion counts.

### Test Runner Command

All M004 tests use:
```bash
node --experimental-sqlite \
  --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/integration-lifecycle.test.ts

node --experimental-sqlite \
  --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/integration-edge.test.ts
```

Note: `--experimental-sqlite` flag is not needed on Node v25.5.0 (node:sqlite is built-in), but the flag is harmless and keeps the invocation consistent with the test runner docs.

### Build Order

1. **Port `integration-lifecycle.test.ts`** — proves the full pipeline in one flow. Runs against all 5 subsystems in sequence. This is the primary S07 deliverable.
2. **Port `integration-edge.test.ts`** — proves empty project, partial migration, and fallback mode. Three isolated blocks, each with its own temp dir and DB. Completes edge case coverage.
3. **Run full test suite** — `npm test` confirms zero regressions; new test files added to the count.
4. **Update REQUIREMENTS.md** — promote R045, R047, R048, R049, R050, R051, R052, R057 from active → validated with evidence pointers.

### Verification Approach

- `npx tsc --noEmit` → zero errors
- `integration-lifecycle.test.ts` → all assertions pass (expect ~26 named assertions)
- `integration-edge.test.ts` → all assertions pass (expect ~24 named assertions across 3 edge cases)
- `token-savings.test.ts` (already passing) → 99 passed, savings ≥30% printed to stdout
- `npm test` → 369+ passed, 0 failed (1 pre-existing pack-install.test.ts failure is unrelated)
- Requirements traceability table in REQUIREMENTS.md updated for R045–R052, R057

## Constraints

- Node v25.5.0 is the runtime — `--experimental-sqlite` flag is harmless but optional. `--experimental-strip-types` is required for `.ts` imports via `resolve-ts.mjs`.
- `_resetProvider()` is exported from `gsd-db.ts` (line 674) — available for the fallback edge test. Don't guard it with a deprecation concern; it's specifically for testing.
- The lifecycle test uses `saveDecisionToDb` which internally calls `await import('./gsd-db.js')` (D049 dynamic import pattern). The test must `await` the `saveDecisionToDb()` call — the memory-db source already does this correctly.
- `integration-lifecycle.test.ts` wraps its main block in `async function main()` called at the bottom — same pattern as `worktree-e2e.test.ts`. Keep this structure.

## Common Pitfalls

- **Module-scoped assertions in edge test** — `integration-edge.test.ts` runs its three blocks at module scope (not inside an `async function main()`), each in its own IIFE-style block. The memory-db source has this structure; keep it verbatim.
- **DB close in finally blocks** — both test files call `closeDatabase()` in `finally` blocks. If this is omitted, a second `openDatabase()` call in the same process will find the DB already open and either silently reuse it or fail, depending on provider. The finally blocks are in the memory-db source — don't strip them.
- **Assertion counts** — the `report()` call at the end of each file uses `createTestContext()` from `test-helpers.ts`. The assertion helper counts are printed to stdout. Both files already use this pattern.
