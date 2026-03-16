# M004/S04 — Research

**Date:** 2026-03-15

## Summary

This slice has two requirements: R051 (token measurement in UnitMetrics) and R052 (DB-first state derivation). Both have complete reference implementations in the memory-db worktree that need porting to the current M004 codebase.

The memory-db reference already has all the code: `metrics.ts` adds `promptCharCount`/`baselineCharCount` optional fields to `UnitMetrics` and an `opts` parameter to `snapshotUnitMetrics`; `auto.ts` declares module-scoped `lastPromptCharCount`/`lastBaselineCharCount` variables, resets them in `dispatchNextUnit`, measures `finalPrompt.length` and computes baseline from `inlineGsdRootFile`, and passes the opts to all 13 `snapshotUnitMetrics` call sites; `state.ts` adds a DB-first content loading tier before the native batch parser fallback. Test files `token-savings.test.ts` and `derive-state-db.test.ts` provide full coverage.

The current M004 worktree already has S03's DB-aware helpers wired in `auto-prompts.ts`, `isDbAvailable` imported in `auto.ts`, and the DB lifecycle (open/close/re-import) in place. `npx tsc --noEmit` is clean with 0 errors. This slice is a mechanical port with zero architectural risk.

## Recommendation

Port the memory-db changes directly with minimal adaptation:
1. Add `promptCharCount`/`baselineCharCount` to `UnitMetrics` and `opts` param to `snapshotUnitMetrics` in `metrics.ts`
2. Add measurement vars + reset + measurement block in `auto.ts` `dispatchNextUnit`
3. Update all 11 `snapshotUnitMetrics` call sites in `auto.ts` to pass the opts
4. Add DB-first content loading tier to `state.ts` `_deriveStateImpl`
5. Port `token-savings.test.ts` and `derive-state-db.test.ts` from memory-db

## Implementation Landscape

### Key Files

- `src/resources/extensions/gsd/metrics.ts` — Add `promptCharCount?: number` and `baselineCharCount?: number` to `UnitMetrics` (line ~41). Add `opts` parameter to `snapshotUnitMetrics` (line ~101). Spread opts into the unit record (line ~158). Preserve existing `loadLedgerFromDisk` that memory-db doesn't have.
- `src/resources/extensions/gsd/auto.ts` — 3 changes: (a) declare `let lastPromptCharCount: number | undefined` and `let lastBaselineCharCount: number | undefined` near line 210 (after the `dispatchGapHandle` declaration), (b) reset both to `undefined` at top of `dispatchNextUnit` after `invalidateAllCaches()` (around line 1248), (c) add measurement block after `finalPrompt` assembly (after the observability repair block, around line 1840) — capture `finalPrompt.length`, then compute baseline from `inlineGsdRootFile` when `isDbAvailable()`. (d) update all 11 `snapshotUnitMetrics` call sites to pass `{ promptCharCount: lastPromptCharCount, baselineCharCount: lastBaselineCharCount }`.
- `src/resources/extensions/gsd/state.ts` — In `_deriveStateImpl`, add DB-first content loading before the existing native batch parser block. When `isDbAvailable()`, query `SELECT path, full_content FROM artifacts` via `_getAdapter()`, populate `fileContentCache`. Set a `dbContentLoaded` flag and wrap the existing native batch parser block in `if (!dbContentLoaded)`. Imports needed: `isDbAvailable` and `_getAdapter` from `./gsd-db.js`.
- `src/resources/extensions/gsd/auto-prompts.ts` — No changes needed. `inlineGsdRootFile` is already exported and will be imported by `auto.ts` for the baseline measurement.
- `src/resources/extensions/gsd/tests/token-savings.test.ts` — Port from memory-db. Direct copy — the test imports `gsd-db.ts`, `md-importer.ts`, `context-store.ts` which all exist in M004 at the same paths.
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — Port from memory-db. Imports `state.ts`, `gsd-db.ts`. Reference code uses `insertArtifact` and `_getAdapter` — both are exported from `gsd-db.ts` in M004.

### Build Order

1. **T01: metrics.ts + auto.ts measurement wiring** — Add the fields to `UnitMetrics`, update `snapshotUnitMetrics` signature, add measurement vars + reset + measurement block in `dispatchNextUnit`, update all 11 call sites. This is the highest-surface-area task (11 call sites to edit) but entirely mechanical. Verify with `npx tsc --noEmit`.

2. **T02: state.ts DB-first content loading** — Add the DB-first tier to `_deriveStateImpl`. Small diff — ~15 lines of DB query code inserted before the existing native batch parser block, plus wrapping that block in `if (!dbContentLoaded)`. Two imports added. Verify with `npx tsc --noEmit`.

3. **T03: Test suite** — Port `token-savings.test.ts` and `derive-state-db.test.ts` from memory-db. Run both plus existing test suite to confirm no regressions.

### Verification Approach

- `npx tsc --noEmit` — must stay clean after each task
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/token-savings.test.ts` — ≥30% savings proven on fixture data
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/derive-state-db.test.ts` — DB path produces identical GSDState as file path
- `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/metrics-io.test.ts` — existing metrics tests still pass (the `opts` param is optional, so no breakage)
- Full test suite: `node --test --experimental-test-module-mocks src/resources/extensions/gsd/tests/*.test.ts` — all existing tests pass
- `grep -c 'lastPromptCharCount\|lastBaselineCharCount' src/resources/extensions/gsd/auto.ts` — should return ≥13 (2 declarations + reset + measurement block + 11 call sites)
- `grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'` — should be 0 (all call sites pass opts)

## Constraints

- `snapshotUnitMetrics` opts parameter must be optional to preserve backward compatibility — existing call sites in tests and elsewhere should not break.
- `inlineGsdRootFile` is in `auto-prompts.ts`. The baseline measurement block in `auto.ts` needs to import it. In memory-db, `inlineGsdRootFile` was defined locally in `auto.ts` — in M004 it's been extracted. Use dynamic import to match the pattern from S03 (avoids circular deps).
- The `_getAdapter` export from `gsd-db.ts` is module-private by convention (underscore prefix) but already exported and used by `context-store.ts`. Using it in `state.ts` is consistent.
- `loadLedgerFromDisk` exists in M004's `metrics.ts` but not in memory-db. Must be preserved when porting the `UnitMetrics` changes.

## Common Pitfalls

- **Forgetting a `snapshotUnitMetrics` call site** — There are 11 in M004 (vs 13 in memory-db due to memory-db having different code paths). Every single one must get the opts parameter. Use grep to verify none are missed.
- **Circular import from `auto.ts` → `auto-prompts.ts`** — `auto.ts` already imports from `auto-dispatch.ts` which imports from `auto-prompts.ts`. A direct static import of `inlineGsdRootFile` from `auto-prompts.ts` in `auto.ts` could create a cycle. Use dynamic `import("./auto-prompts.js")` inside the measurement block, matching the S03 pattern for DB-aware helpers.
- **`_getAdapter` null check in state.ts** — `isDbAvailable()` can be true but `_getAdapter()` can theoretically return null in edge cases. The memory-db reference handles this with `if (adapter)` guard. Must replicate.
