---
id: S04
parent: M004
milestone: M004
provides:
  - UnitMetrics interface with promptCharCount and baselineCharCount optional fields
  - snapshotUnitMetrics 6th opts parameter for pass-through of measurement data to ledger
  - Module-scoped lastPromptCharCount/lastBaselineCharCount vars in auto.ts, reset per unit, written once after finalPrompt assembly, read at all 11 call sites
  - Measurement block in dispatchNextUnit: captures prompt length + dynamic-import-based baseline from inlineGsdRootFile(decisions/requirements/project)
  - DB-first content loading tier in _deriveStateImpl: queries artifacts table, populates fileContentCache by absolute path, falls through to native batch parser when empty
  - token-savings.test.ts — 99 assertions proving ≥30% char savings on realistic fixture data
  - derive-state-db.test.ts — 51 assertions proving DB-first deriveState produces identical GSDState with fallback/partial/cache coverage
requires:
  - slice: S03
    provides: Rewired prompt builders (auto-prompts.ts), inlineGsdRootFile for baseline, isDbAvailable()/insertArtifact() from gsd-db.ts
affects:
  - S07
key_files:
  - src/resources/extensions/gsd/metrics.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/state.ts
  - src/resources/extensions/gsd/tests/token-savings.test.ts
  - src/resources/extensions/gsd/tests/derive-state-db.test.ts
key_decisions:
  - D052: Dynamic import for auto-prompts.js in measurement block (avoids auto.ts → auto-dispatch.ts → auto-prompts.ts circular dependency)
  - D053: dbContentLoaded = true only when rows.length > 0 (empty DB falls through to native batch parser identically to no DB)
patterns_established:
  - Module-scoped measurement vars (lastPromptCharCount/lastBaselineCharCount) reset at top of dispatchNextUnit, written once after finalPrompt assembly, read at all 11 snapshotUnitMetrics call sites
  - Three-tier content loading in _deriveStateImpl: DB artifacts table → native batch parser → cachedLoadFile. fileContentCache is the shared contract — each tier writes to it, downstream logic reads from it
  - All test files in this suite require --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs alongside --experimental-test-module-mocks
observability_surfaces:
  - promptCharCount and baselineCharCount optional fields in .gsd/metrics.json ledger entries
  - Savings formula: (baselineCharCount - promptCharCount) / baselineCharCount * 100
  - Absence of baselineCharCount in a ledger record = DB was off or inlineGsdRootFile threw (non-fatal)
  - Re-run savings validation: node --test --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs src/resources/extensions/gsd/tests/token-savings.test.ts
drill_down_paths:
  - .gsd/milestones/M004/slices/S04/tasks/T01-SUMMARY.md
  - .gsd/milestones/M004/slices/S04/tasks/T02-SUMMARY.md
duration: 35m
verification_result: passed
completed_at: 2026-03-16
---

# S04: Token Measurement + State Derivation

**Token measurement wired into all 11 dispatch sites with ≥30% savings confirmed (52.2% plan-slice, 66.3% decisions-only, 32.2% research composite); DB-first state derivation live in `_deriveStateImpl` with full fallback and identity parity proven.**

## What Happened

Two tasks, three production files modified, two test files created.

**T01 — Production wiring (metrics.ts, auto.ts, state.ts)**

`metrics.ts` gained `promptCharCount?: number` and `baselineCharCount?: number` on the `UnitMetrics` interface, plus an `opts?` 6th parameter on `snapshotUnitMetrics` that conditionally spreads into the ledger record. Keys are omitted when `undefined` to keep JSON clean.

`auto.ts` gained module-scoped `lastPromptCharCount` and `lastBaselineCharCount` vars declared near `dispatchGapHandle`. Both reset to `undefined` at the top of `dispatchNextUnit` (after `invalidateAllCaches()`). After finalPrompt assembly, a measurement block sets `lastPromptCharCount = finalPrompt.length`, then uses dynamic `import("./auto-prompts.js")` to call `inlineGsdRootFile` three times (decisions.md, requirements.md, project.md) and sum lengths for `lastBaselineCharCount`. Dynamic import is required because the static import chain `auto.ts → auto-dispatch.ts → auto-prompts.ts` would become circular. All 11 `snapshotUnitMetrics` call sites were updated atomically to pass the 6th opts argument with both measurement vars.

`state.ts` gained `isDbAvailable` and `_getAdapter` imports from `gsd-db.ts`. In `_deriveStateImpl`, before the native batch parser block, a new DB-first tier queries `SELECT path, full_content FROM artifacts`, populates `fileContentCache` keyed by resolved absolute path, and sets `dbContentLoaded = rows.length > 0`. The native batch parser block is wrapped in `if (!dbContentLoaded) { ... }`. The `cachedLoadFile` function and all downstream derivation logic is unchanged — it reads from `fileContentCache` regardless of which tier populated it.

**T02 — Test verification (token-savings.test.ts, derive-state-db.test.ts)**

Both files ported verbatim from the memory-db worktree. No import path adaptation needed.

`token-savings.test.ts` (99 assertions): Seeds the DB with fixture data — 24 decisions across 3 milestones (8 per), 21 requirements across 5 slices — then measures formatted output lengths with and without scoping. Results: 52.2% plan-slice savings, 66.3% decisions-only, 32.2% research composite. All exceed 30%. Scoping correctness verified: M001 queries return exactly 8 decisions with no M002/M003 cross-contamination.

`derive-state-db.test.ts` (51 assertions): Seven named scenarios — DB path produces identical GSDState as file path (phase, activeMilestone, activeSlice, activeTask, registry, requirements, progress); fallback when `isDbAvailable()` returns false; empty DB falls through to disk reads; partial DB fills gaps from disk (roadmap in DB, plan from disk → correct combined state); requirements counting from DB-only content; multi-milestone registry from DB; cache invalidation (second call returns cached, post-invalidate picks up updated DB content).

## Verification

All slice-level checks passed:

```
npx tsc --noEmit                                     → no output (zero errors)
grep -c 'lastPromptCharCount\|lastBaselineCharCount' auto.ts   → 18 (≥15 ✓)
grep 'snapshotUnitMetrics(' auto.ts | grep -cv 'promptCharCount'  → 0 ✓

token-savings.test.ts    → 99 passed, 0 failed (52.2% plan-slice savings)
derive-state-db.test.ts  → 51 passed, 0 failed
metrics-io.test.ts       → 24 passed, 0 failed (opts backward compat)
Full suite (188 files)   → 188 passed, 0 failed
```

## Requirements Advanced

- R051 — `promptCharCount`/`baselineCharCount` added to UnitMetrics, all 11 call sites updated, measurement block wired into dispatchNextUnit. token-savings.test.ts proves the mechanism works and savings are real.
- R052 — DB-first content loading tier in `_deriveStateImpl` implemented. derive-state-db.test.ts proves identity parity, fallback, partial fill, and cache invalidation.

## Requirements Validated

- Neither R051 nor R052 is fully validated yet — both still depend on S07 end-to-end integration verification against live auto-mode behavior. The contract proof (fixture-based) is complete; operational proof waits for S07.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

The slice plan's verification command examples omitted `--import ./src/resources/extensions/gsd/tests/resolve-ts.mjs`. All test invocations require this loader flag — it's the standard pattern for the entire suite. T02-PLAN.md was updated to note the correct invocation.

## Known Limitations

- `lastBaselineCharCount` uses `inlineGsdRootFile` for the baseline — it loads the full markdown files and sums their lengths. This is an approximation: the real baseline is what the old system injected per prompt builder. The approximation is directionally correct and sufficient to prove the ≥30% claim, but the number isn't exact in production (some prompt builders inject more/fewer files).
- R051 and R052 are not fully validated until S07 proves them against a live auto-mode cycle.

## Follow-ups

- S07 must verify R051/R052 against a real auto-mode run: ledger entries should contain promptCharCount/baselineCharCount after a planning dispatch.
- S07 should confirm `deriveState()` DB path is used when DB is available in an actual auto-mode run (not just in isolation).

## Files Created/Modified

- `src/resources/extensions/gsd/metrics.ts` — Added `promptCharCount?`/`baselineCharCount?` to `UnitMetrics`; added `opts?` 6th param to `snapshotUnitMetrics`; conditional spread into ledger record
- `src/resources/extensions/gsd/auto.ts` — Module-scoped measurement vars; reset in dispatchNextUnit; measurement block with dynamic import; all 11 snapshotUnitMetrics call sites updated with opts argument
- `src/resources/extensions/gsd/state.ts` — isDbAvailable/_getAdapter imports; DB-first content loading tier before native batch parser in `_deriveStateImpl`
- `src/resources/extensions/gsd/tests/token-savings.test.ts` — New; 99 assertions proving ≥30% character savings on fixture data
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — New; 51 assertions proving DB-first state derivation with fallback, partial fill, and cache invalidation

## Forward Intelligence

### What the next slice should know

- The three-tier content loading pattern (`DB → native batch → cachedLoadFile`) is the established pattern for `_deriveStateImpl`. S05 worktree DB copy means the worktree's artifacts table will be pre-populated — the DB tier will be active from the first state derivation in a resumed worktree session.
- `lastBaselineCharCount` is best-effort. If the measurement block fails (DB unavailable, import throws), `snapshotUnitMetrics` still gets called — it just omits the baseline field. Don't treat missing baseline as an error condition in S07 verification.
- token-savings.test.ts prints savings percentages to stdout on every run — use it as a quick regression check any time the prompt builders change.

### What's fragile

- The measurement block's dynamic import of auto-prompts.js calls `inlineGsdRootFile` directly with hardcoded file names (`DECISIONS.md`, `REQUIREMENTS.md`, `project.md`). If those file names change or the function signature changes, baseline measurement silently falls to `undefined`. Non-fatal but the savings metric goes dark.
- `SELECT path, full_content FROM artifacts` in `_deriveStateImpl` assumes the schema column is `full_content`. If the artifacts table schema changes (S05/S06 evolution), this query needs updating.

### Authoritative diagnostics

- Savings percentages: re-run `token-savings.test.ts` — explicit percentage output in stdout
- Ledger inspection: `cat .gsd/metrics.json | jq '.units[] | select(.promptCharCount != null) | {id, promptCharCount, baselineCharCount}'`
- DB-first path active in derivation: add temporary `console.error('DB loaded:', dbContentLoaded)` to `_deriveStateImpl` after the DB tier block

### What assumptions changed

- No assumptions changed. The plan's verification commands were slightly wrong (missing loader flag) but that was a documentation issue, not an architectural one. All production code matched the plan exactly.
