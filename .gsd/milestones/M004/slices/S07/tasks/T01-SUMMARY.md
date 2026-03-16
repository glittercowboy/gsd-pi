---
id: T01
parent: S07
milestone: M004
provides:
  - integration-lifecycle.test.ts (50 assertions — full M004 pipeline in one sequential flow)
  - integration-edge.test.ts (33 assertions — empty project, partial migration, fallback mode)
  - REQUIREMENTS.md with R045, R047-R052, R057 promoted to validated
key_files:
  - src/resources/extensions/gsd/tests/integration-lifecycle.test.ts
  - src/resources/extensions/gsd/tests/integration-edge.test.ts
  - .gsd/REQUIREMENTS.md
key_decisions:
  - none (verbatim port — no adaptation decisions)
patterns_established:
  - Integration tests use mkdtempSync + try/finally rmSync for hermetic temp DB isolation
  - File-backed DB (not :memory:) for WAL fidelity in integration tests
  - Token savings printed to stdout for grep-ability in CI
observability_surfaces:
  - "node --test src/resources/extensions/gsd/tests/integration-lifecycle.test.ts → Results: 50 passed, 0 failed"
  - "node --test src/resources/extensions/gsd/tests/integration-edge.test.ts → Results: 33 passed, 0 failed"
  - "grep -c '| validated |' .gsd/REQUIREMENTS.md → 48 (includes header + 46 validated rows)"
duration: ~15m
verification_result: passed
completed_at: 2026-03-16
blocker_discovered: false
---

# T01: Port Integration Tests and Promote Requirements

**Ported integration-lifecycle.test.ts (50 assertions) and integration-edge.test.ts (33 assertions) verbatim — both pass with 0 failures — and promoted R045, R047-R052, R057 from active to validated in REQUIREMENTS.md.**

## What Happened

Both integration test files were read from `.gsd/worktrees/memory-db/` and written verbatim to `src/resources/extensions/gsd/tests/`. Import paths matched M004 layout exactly — zero adaptation needed.

`integration-lifecycle.test.ts` (50 assertions) proves the full M004 pipeline: temp dir + `.gsd/` structure → `migrateFromMarkdown` (14 decisions, 12 requirements, 1 artifact) → WAL mode verification → scoped `queryDecisions` by milestone (M001+M002 sums to total) → scoped `queryRequirements` by slice → `formatDecisionsForPrompt`/`formatRequirementsForPrompt` → 42.4% token savings assertion (≥30%) → content change + re-import → `saveDecisionToDb` write-back → parse-regenerate-parse round-trip field fidelity → final count consistency (14 + 1 re-import + 1 write = 16).

`integration-edge.test.ts` (33 assertions) proves three edge scenarios: (1) empty project — all counts zero, queries return empty arrays, format returns empty strings; (2) partial migration — DECISIONS.md only, 6 decisions imported, requirements return empty without crash; (3) fallback mode — `closeDatabase()` + `_resetProvider()` → `isDbAvailable()` false → all queries return empty → `openDatabase()` restores data.

`npm test` ran all 371 unit + 220 integration tests. The only failure was `pack-install.test.ts` (pre-existing, requires `dist/`). `npx tsc --noEmit` produced no output.

REQUIREMENTS.md promotions applied to the worktree's `.gsd/REQUIREMENTS.md` (the authoritative copy — not the main repo). The original file had validation text already written by S01-S06 for R045-R052; I changed `Status: active` → `Status: validated` for all 8 and updated R057's Validation field with the S07 test evidence. Traceability table rows updated with `| validated |` and augmented proof references. Coverage Summary updated: Active 8 → 0, Validated 40 → 46.

## Verification

```
integration-lifecycle.test.ts: 50 passed, 0 failed (5.3s isolated, 1.2s in npm test)
integration-edge.test.ts: 33 passed, 0 failed (2.0s isolated, 0.9s in npm test)
token-savings.test.ts: 99 passed, 0 failed (no regression)
npm test: 371 unit pass + 220 integration pass (pack-install.test.ts pre-existing failure excluded)
npx tsc --noEmit: no output
grep -c "Status: validated" .gsd/REQUIREMENTS.md → 46 (all 8 promoted + 38 prior)
grep -c "| validated |" .gsd/REQUIREMENTS.md → 48 (table header + 46 validated rows)
```

Token savings confirmed at 42.4% on lifecycle test (≥30% requirement satisfied).

## Diagnostics

- **Run lifecycle test:** `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/integration-lifecycle.test.ts`
- **Run edge test:** `node --experimental-sqlite --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/integration-edge.test.ts`
- **Token savings line:** grep `Token savings:` in lifecycle test stdout
- **Requirements state:** `grep -c "Status: validated" .gsd/REQUIREMENTS.md` → 46
- **Temp DB cleanup:** tests use mkdtempSync + try/finally rmSync. If a test crashes, inspect `/tmp/gsd-int-*` directories.

## Deviations

The task plan said to edit `.gsd/REQUIREMENTS.md` (relative to working directory). The worktree has its own `.gsd/REQUIREMENTS.md` which differed from the main repo's copy — the worktree version had richer validation text written during S01-S06 and had R046, R053-R056 already validated. I initially edited the main repo copy by mistake, then restored the worktree original and applied targeted edits there. All final changes are in the worktree's `.gsd/REQUIREMENTS.md`.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — new file, verbatim port, 50 assertions passing
- `src/resources/extensions/gsd/tests/integration-edge.test.ts` — new file, verbatim port, 33 assertions passing
- `.gsd/REQUIREMENTS.md` — R045, R047-R052, R057 promoted from active to validated; traceability table updated; Coverage Summary updated (Active 8→0, Validated 40→46)
- `.gsd/milestones/M004/slices/S07/S07-PLAN.md` — T01 marked [x]; Observability/Diagnostics section added (preflight requirement)
- `.gsd/milestones/M004/slices/S07/tasks/T01-PLAN.md` — Observability Impact section added (preflight requirement)
- `.gsd/STATE.md` — updated to reflect S07 complete, M004 ready to merge
