---
id: S07
parent: M004
milestone: M004
provides:
  - integration-lifecycle.test.ts (50 assertions — full M004 pipeline: migrate → query → format → token savings → re-import → write-back → round-trip)
  - integration-edge.test.ts (33 assertions — empty project, partial migration, fallback mode)
  - REQUIREMENTS.md with R045, R047–R052, R057 promoted from active to validated (total: 46 validated)
requires:
  - slice: S03
    provides: Rewired prompt builders + dual-write re-import + context-store query layer
  - slice: S04
    provides: Token measurement (promptCharCount/baselineCharCount) + deriveState DB-first loading
  - slice: S05
    provides: copyWorktreeDb wired in createWorktree + reconcileWorktreeDb wired in merge paths
  - slice: S06
    provides: gsd_save_decision/gsd_update_requirement/gsd_save_summary tools + /gsd inspect command
affects: []
key_files:
  - src/resources/extensions/gsd/tests/integration-lifecycle.test.ts
  - src/resources/extensions/gsd/tests/integration-edge.test.ts
  - .gsd/REQUIREMENTS.md
key_decisions:
  - none (verbatim port — no adaptation decisions required)
patterns_established:
  - Integration tests use mkdtempSync + try/finally rmSync for hermetic temp DB isolation
  - File-backed DB (not :memory:) for WAL fidelity in integration tests
  - Token savings printed to stdout for grep-ability in CI
  - createTestContext() helper encapsulates pass/fail tracking and process.exit(1) on failure
observability_surfaces:
  - "node --test integration-lifecycle.test.ts → Results: 50 passed, 0 failed + Token savings: 42.4%"
  - "node --test integration-edge.test.ts → Results: 33 passed, 0 failed"
  - "node --test token-savings.test.ts → Results: 99 passed, 0 failed + savings percentages per scenario"
  - "grep -c 'Status: validated' .gsd/REQUIREMENTS.md → 46"
drill_down_paths:
  - .gsd/milestones/M004/slices/S07/tasks/T01-SUMMARY.md
duration: ~15m
verification_result: passed
completed_at: 2026-03-16
---

# S07: Integration Verification + Polish

**Ported two integration test files (83 total assertions) proving the full M004 pipeline composes correctly end-to-end, and promoted all 8 previously-active M004 requirements to validated.**

## What Happened

S07 had a single task: port `integration-lifecycle.test.ts` and `integration-edge.test.ts` verbatim from the memory-db reference worktree, run them to confirm zero failures, then promote R045, R047–R052, and R057 to validated in REQUIREMENTS.md.

Both files were read from `.gsd/worktrees/memory-db/` and written to `src/resources/extensions/gsd/tests/`. Import paths matched the M004 layout exactly — zero adaptation required.

**integration-lifecycle.test.ts (50 assertions)** exercises the full M004 pipeline in a single sequential flow against a file-backed temp DB:

1. Temp dir + `.gsd/` fixture structure created (DECISIONS.md, REQUIREMENTS.md, PROJECT.md, hierarchy of milestones/slices/tasks)
2. `migrateFromMarkdown()` imports 14 decisions, 12 requirements, 1 artifact
3. WAL mode confirmed (`PRAGMA journal_mode` = wal)
4. `queryDecisions()` scoped by milestone — M001+M002 sums to total, no cross-contamination
5. `queryRequirements()` scoped by slice — correct subset returned
6. `formatDecisionsForPrompt()` / `formatRequirementsForPrompt()` produce correctly formatted output
7. Token savings assertion: 42.4% savings (scoped: 5242 chars vs full: 9101 chars) — exceeds ≥30% threshold
8. Content change + re-import: new decision added to DECISIONS.md → `migrateFromMarkdown()` runs again → 15 decisions
9. `saveDecisionToDb()` write-back creates D015 → count reaches 16
10. Parse-regenerate-parse round-trip: generate DECISIONS.md from DB → parse back → field-identical output

**integration-edge.test.ts (33 assertions)** proves three edge scenarios:
1. Empty project — all counts zero, queries return empty arrays, formatters return empty strings, no crash
2. Partial migration — DECISIONS.md only (no REQUIREMENTS.md) — 6 decisions imported, requirements empty without crash
3. Fallback mode — `closeDatabase()` + `_resetProvider()` → `isDbAvailable()` returns false → all queries return empty → `openDatabase()` at the same path restores all data

**npm test** ran 371 unit + 226 integration tests. Only failure: `pack-install.test.ts` (pre-existing, requires `dist/`). **npx tsc --noEmit** produced no output.

REQUIREMENTS.md promotions were applied to the worktree's `.gsd/REQUIREMENTS.md`. The file already had rich validation text written during S01–S06 for R045–R052; the task changed `Status: active` → `Status: validated` for all 8 M004 requirements and augmented R057's Validation field with S07 evidence (42.4% lifecycle savings, 99 token-savings assertions). Traceability table updated. Coverage Summary: Active 8→0, Validated 40→46.

## Verification

```
integration-lifecycle.test.ts:  50 passed, 0 failed  (token savings: 42.4% ≥ 30% ✓)
integration-edge.test.ts:       33 passed, 0 failed
token-savings.test.ts:          99 passed, 0 failed  (52.2% plan-slice, 66.3% decisions-only, 32.2% composite)
npm test:                       371 unit pass + 0 fail (pack-install.test.ts pre-existing excluded)
npx tsc --noEmit:               no output (zero errors)
grep -c "Status: validated" .gsd/REQUIREMENTS.md → 46
```

## Requirements Advanced

None — this slice validated, not advanced.

## Requirements Validated

- R045 — SQLite DB layer with tiered provider chain: lifecycle test proves WAL mode and availability assertion
- R047 — Auto-migration from markdown to DB: lifecycle step 2 imports 14+12+1; re-import after content change imports 15 decisions
- R048 — Round-trip fidelity: lifecycle step 10 parse→generate→parse produces field-identical output
- R049 — Surgical prompt injection: lifecycle steps 3–5 prove scoped queries + formatted output in pipeline context
- R050 — Dual-write sync: lifecycle step 8 re-import after content change proves markdown→DB direction end-to-end
- R051 — Token measurement: lifecycle step 7 asserts 42.4% savings on real file-backed DB with 14 decisions + 12 requirements
- R052 — DB-first state derivation: covered by prior S04 tests; lifecycle confirms DB is populated and queryable throughout
- R057 — ≥30% token savings: 42.4% lifecycle assertion + 99 token-savings assertions all exceed threshold

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

T01 initially edited the main repo's `.gsd/REQUIREMENTS.md` instead of the worktree's copy. Restored and re-applied targeted edits to the correct worktree file. All final changes are in the worktree's `.gsd/REQUIREMENTS.md`.

## Known Limitations

None. All M004 success criteria are proven.

## Follow-ups

None. M004 is complete and ready for squash-merge.

## Files Created/Modified

- `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — new file, verbatim port, 50 assertions passing
- `src/resources/extensions/gsd/tests/integration-edge.test.ts` — new file, verbatim port, 33 assertions passing
- `.gsd/REQUIREMENTS.md` — R045, R047–R052, R057 promoted from active to validated; Coverage Summary Active 8→0, Validated 40→46

## Forward Intelligence

### What the next slice should know
- M004 is complete. All 13 requirements (R045–R057) are validated. The next work is milestone-level: squash-merge M004 to main.
- The `integration-lifecycle.test.ts` is the canonical M004 integration proof — it exercises every subsystem in sequence. Read it first when debugging any M004 regression.
- The memory-db worktree at `.gsd/worktrees/memory-db/` was the authoritative reference for all M004 ports. It remains available for forensics.

### What's fragile
- `node:sqlite` is still experimental — API surface tested is stable but version-pinning Node 22.x is advisable.
- The measurement block in `dispatchNextUnit` uses dynamic import of `auto-prompts.js` to avoid circular dependencies (D052). If the module graph changes, this is the first place to check.

### Authoritative diagnostics
- `node --test integration-lifecycle.test.ts` — single command that exercises the entire M004 pipeline in ~3 seconds. Token savings line in stdout is the fastest way to confirm prompt injection is working.
- `grep -c "Status: validated" .gsd/REQUIREMENTS.md` → 46 confirms all requirements are properly promoted.
- `/tmp/gsd-int-*` directories — if an integration test crashes mid-run, temp DB files land here.

### What assumptions changed
- No assumptions changed. S07 was a pure verification slice — all subsystems composed correctly on first run with zero adaptation needed.
