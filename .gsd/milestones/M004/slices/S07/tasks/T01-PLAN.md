---
estimated_steps: 5
estimated_files: 3
---

# T01: Port Integration Tests and Promote Requirements

**Slice:** S07 — Integration Verification + Polish
**Milestone:** M004

## Description

Port two integration test files verbatim from the memory-db reference worktree, confirm they pass, run the full suite, then promote 8 Active requirements to validated in REQUIREMENTS.md. No production code changes expected — this is purely verification and requirements bookkeeping.

`integration-lifecycle.test.ts` proves the complete M004 pipeline in one sequential flow: temp dir with `.gsd/` structure → `migrateFromMarkdown` → scoped `queryDecisions`/`queryRequirements` → `formatDecisionsForPrompt`/`formatRequirementsForPrompt` → token savings assertion (≥30%) → content change → `migrateFromMarkdown` re-import → `saveDecisionToDb` write-back → parse-regenerate-parse round-trip → final count consistency.

`integration-edge.test.ts` proves three edge scenarios: (1) empty project returns all zeros, (2) partial migration (only DECISIONS.md present) is non-fatal, (3) fallback mode (`closeDatabase()` + `_resetProvider()`) makes queries return empty arrays and `openDatabase()` restores them.

Both files require zero adaptation — import paths match M004 layout exactly (confirmed by S07 research).

## Steps

1. Read the source files from the memory-db reference:
   - `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/integration-lifecycle.test.ts`
   - `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/integration-edge.test.ts`

2. Write each file verbatim to:
   - `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts`
   - `src/resources/extensions/gsd/tests/integration-edge.test.ts`

3. Run each file individually and confirm all assertions pass:
   ```
   node --experimental-sqlite \
     --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test \
     src/resources/extensions/gsd/tests/integration-lifecycle.test.ts

   node --experimental-sqlite \
     --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
     --experimental-strip-types --test \
     src/resources/extensions/gsd/tests/integration-edge.test.ts
   ```

4. Run `npm test` and confirm 0 failures (pack-install.test.ts pre-existing failure is unrelated — it requires a built `dist/` and is excluded from pass/fail assessment).

5. Promote R045, R047, R048, R049, R050, R051, R052, R057 in `.gsd/REQUIREMENTS.md`:
   - Change `Status: active` → `Status: validated` for each
   - Update the Validation field to reference the relevant test files and assertion counts from across S01–S07
   - Update the traceability table rows for each requirement (change `active` → `validated`)
   - Update the Coverage Summary counts (Active → 0, Validated count increases by 8)

## Must-Haves

- [ ] `integration-lifecycle.test.ts` passes with 0 failures
- [ ] `integration-edge.test.ts` passes with 0 failures
- [ ] `npm test` reports 0 failures
- [ ] `npx tsc --noEmit` produces no output
- [ ] R045, R047, R048, R049, R050, R051, R052, R057 all show `Status: validated` in REQUIREMENTS.md
- [ ] Traceability table in REQUIREMENTS.md updated for all 8 requirements

## Verification

- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` → all assertions pass
- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/integration-edge.test.ts` → all assertions pass
- `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/token-savings.test.ts` → 99 passed (already passing; run to confirm no regression)
- `npm test` → 0 failures in the non-pre-existing test suite
- `npx tsc --noEmit` → no output
- `grep -c "status: validated" .gsd/REQUIREMENTS.md` → count increased by 8 vs pre-task baseline

## Inputs

- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — source for verbatim port (277 lines)
- `.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/integration-edge.test.ts` — source for verbatim port (228 lines)
- `.gsd/REQUIREMENTS.md` — requirements to promote; current Active count = 8 (R045–R052, R057)
- S01–S06 summaries (in `.gsd/milestones/M004/slices/`) — evidence for Validation fields when promoting requirements

## Observability Impact

No production code changes in this task — no new log lines, no new DB operations, no new error paths in the shipped extension. The observability surfaces introduced are test-side only:

- **Test stdout headers** — each scenario prints `=== integration-X: Y ===` to stdout. A future agent running the test file sees exactly which scenario was executing when a failure occurred.
- **`gsd-migrate: imported N decisions...` logs** — emitted by `migrateFromMarkdown` on every call, printed inline with test output. Confirms import counts at each pipeline step.
- **`Token savings: XX.X%` line** — lifecycle test step 5 logs the real savings measurement on every run. If the ≥30% assertion ever fails, this line shows the actual value.
- **`Results: N passed, 0 failed` summary** — each test file prints this before exit. Grep-able from any CI log.
- **Exit code 1 on failure** — `createTestContext().report()` exits non-zero if any assertion failed. The `npm test` process chain propagates this correctly.
- **REQUIREMENTS.md as state surface** — `grep -c "| validated |" .gsd/REQUIREMENTS.md` reports validated count (43 after this task). Runnable by any agent to verify requirements state.



- `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — new file, verbatim port, all assertions passing
- `src/resources/extensions/gsd/tests/integration-edge.test.ts` — new file, verbatim port, all assertions passing
- `.gsd/REQUIREMENTS.md` — 8 requirements promoted to validated, traceability table and coverage summary updated
