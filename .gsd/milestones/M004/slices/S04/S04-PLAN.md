# S04: Token Measurement + State Derivation

**Goal:** `promptCharCount`/`baselineCharCount` in UnitMetrics, measurement wired into all `snapshotUnitMetrics` call sites, `deriveState()` reads content from DB when available, savings ≥30% confirmed on fixture data.
**Demo:** `token-savings.test.ts` proves ≥30% character savings on plan-slice prompts. `derive-state-db.test.ts` proves DB path produces identical `GSDState` as file path.

## Must-Haves

- `promptCharCount` and `baselineCharCount` optional fields on `UnitMetrics` interface
- `snapshotUnitMetrics` accepts optional `opts` parameter with those fields, spreads into unit record
- All 11 `snapshotUnitMetrics` call sites in `auto.ts` pass `{ promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount }`
- Module-scoped `lastPromptCharCount`/`lastBaselineCharCount` in `auto.ts`, reset at top of `dispatchNextUnit`
- Measurement block after `finalPrompt` assembly captures prompt length and baseline from `inlineGsdRootFile`
- `_deriveStateImpl` in `state.ts` loads content from DB artifacts table when `isDbAvailable()`, falls back to native batch parser
- ≥30% savings proven on fixture data with 24 decisions across 3 milestones and 21 requirements across 5 slices

## Proof Level

- This slice proves: contract + operational
- Real runtime required: no (fixture-based tests)
- Human/UAT required: no

## Verification

- `npx tsc --noEmit` — zero errors after all changes
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/token-savings.test.ts` — all assertions pass, ≥30% savings on plan-slice
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/derive-state-db.test.ts` — DB path produces identical GSDState, fallback works, partial DB fills gaps
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/metrics-io.test.ts` — existing metrics tests pass (opts param is optional)
- `grep -c 'lastPromptCharCount\|lastBaselineCharCount' src/resources/extensions/gsd/auto.ts` — ≥15 (2 declarations + 2 resets + measurement block + 11 call sites)
- `grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'` — 0 (all call sites pass opts)
- Full test suite: `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/*.test.ts` — all existing tests pass

## Observability / Diagnostics

- Runtime signals: `promptCharCount` and `baselineCharCount` in metrics ledger JSON (`.gsd/metrics-ledger.json`)
- Inspection surfaces: `UnitMetrics` records queryable from ledger — savings = `(baselineCharCount - promptCharCount) / baselineCharCount * 100`
- Failure visibility: `lastBaselineCharCount` is `undefined` when DB is off or `inlineGsdRootFile` fails — non-fatal, measurement is best-effort
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: S03's rewired prompt builders (`auto-prompts.ts`), `inlineGsdRootFile` for baseline measurement, `isDbAvailable()` and `_getAdapter()` from `gsd-db.ts`, `insertArtifact` from `gsd-db.ts` (tests only)
- New wiring introduced in this slice: measurement block in `dispatchNextUnit` (after `finalPrompt` assembly), DB-first content loading tier in `_deriveStateImpl`
- What remains before the milestone is truly usable end-to-end: S05 (worktree DB copy/merge), S06 (structured tools + /gsd inspect), S07 (integration verification)

## Tasks

- [x] **T01: Wire token measurement into metrics + auto + state** `est:25m`
  - Why: Adds the production-code infrastructure for R051 (token measurement) and R052 (DB-first state derivation). Three files changed: `metrics.ts` gets the new fields + opts param, `auto.ts` gets measurement vars + reset + baseline computation + 11 call-site updates, `state.ts` gets DB-first content loading tier.
  - Files: `src/resources/extensions/gsd/metrics.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/state.ts`
  - Do:
    1. In `metrics.ts`: add `promptCharCount?: number` and `baselineCharCount?: number` to `UnitMetrics` (after `userMessages`). Add `opts?: { promptCharCount?: number; baselineCharCount?: number }` as 6th param to `snapshotUnitMetrics`. Spread opts into the unit record: `...(opts?.promptCharCount != null ? { promptCharCount: opts.promptCharCount } : {})` and same for baseline. Preserve `loadLedgerFromDisk` and all other existing code.
    2. In `auto.ts`: declare `let lastPromptCharCount: number | undefined;` and `let lastBaselineCharCount: number | undefined;` near line 210 (after `dispatchGapHandle` declaration). Reset both to `undefined` after `invalidateAllCaches()` at top of `dispatchNextUnit` (~line 1245). Add measurement block after the observability repair block (~line 1840, before model switching): `lastPromptCharCount = finalPrompt.length; lastBaselineCharCount = undefined;` then `if (isDbAvailable()) { try { const { inlineGsdRootFile } = await import("./auto-prompts.js"); ... } catch {} }` — use dynamic import to avoid circular deps. Update all 11 `snapshotUnitMetrics` call sites to pass `{ promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount }` as the 6th argument.
    3. In `state.ts`: add `import { isDbAvailable, _getAdapter } from './gsd-db.js';` to imports. In `_deriveStateImpl`, before the existing `const batchFiles = nativeBatchParseGsdFiles(gsdDir);` block, add a DB-first content loading tier: `let dbContentLoaded = false; if (isDbAvailable()) { const adapter = _getAdapter(); if (adapter) { try { const rows = adapter.prepare('SELECT path, full_content FROM artifacts').all(); for (const row of rows) { fileContentCache.set(resolve(gsdDir, row['path']), row['full_content']); } dbContentLoaded = rows.length > 0; } catch {} } }`. Wrap the existing native batch parser block in `if (!dbContentLoaded) { ... }`.
  - Verify: `npx tsc --noEmit` clean. `grep -c 'lastPromptCharCount\|lastBaselineCharCount' src/resources/extensions/gsd/auto.ts` returns ≥15. `grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'` returns 0.
  - Done when: TypeScript compiles clean, all 11 call sites updated, measurement block wired, DB-first tier in state.ts.

- [x] **T02: Port test suites and verify ≥30% savings** `est:15m`
  - Why: Provides contract verification for R051 (measurement fields recorded) and R052 (DB-first derivation produces identical state). Proves the ≥30% savings claim with realistic fixture data (R057 evidence).
  - Files: `src/resources/extensions/gsd/tests/token-savings.test.ts`, `src/resources/extensions/gsd/tests/derive-state-db.test.ts`
  - Do:
    1. Copy `token-savings.test.ts` from memory-db worktree (`/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/token-savings.test.ts`). No adaptation needed — import paths match.
    2. Copy `derive-state-db.test.ts` from memory-db worktree (`/Users/lexchristopherson/Developer/gsd-2/.gsd/worktrees/memory-db/src/resources/extensions/gsd/tests/derive-state-db.test.ts`). No adaptation needed.
    3. Run both test files individually. Run existing `metrics-io.test.ts` to verify opts param backward compatibility. Run full test suite to confirm zero regressions.
  - Verify: `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/token-savings.test.ts` — all pass, ≥30% savings. `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/derive-state-db.test.ts` — all pass. Full suite: all pass.
  - Done when: Both test files pass with zero failures, existing tests still pass, savings ≥30% confirmed in test output.

## Files Likely Touched

- `src/resources/extensions/gsd/metrics.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/state.ts`
- `src/resources/extensions/gsd/tests/token-savings.test.ts` (new)
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` (new)
