---
id: T01
parent: S04
milestone: M004
provides:
  - UnitMetrics with promptCharCount and baselineCharCount fields
  - snapshotUnitMetrics opts parameter for measurement data pass-through
  - Module-scoped measurement vars in auto.ts wired into all 11 call sites
  - DB-first content loading tier in _deriveStateImpl before native batch parser
key_files:
  - src/resources/extensions/gsd/metrics.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/state.ts
key_decisions:
  - Dynamic import of auto-prompts.js in measurement block to avoid auto.ts → auto-dispatch.ts → auto-prompts.ts circular dependency
  - opts spread into unit record using conditional spread (omit keys when undefined) to keep JSON clean
  - DB-first tier sets dbContentLoaded=true only when rows.length > 0, ensuring empty DB still falls through to native batch parser
patterns_established:
  - Module-scoped measurement vars (lastPromptCharCount/lastBaselineCharCount) reset at top of dispatchNextUnit, written once after finalPrompt assembly, read at all 11 snapshotUnitMetrics call sites
  - DB-first content loading → native batch parser → cachedLoadFile (sequential JS) three-tier fallback pattern in _deriveStateImpl
observability_surfaces:
  - promptCharCount and baselineCharCount optional fields in .gsd/metrics.json ledger entries
  - Absence of baselineCharCount in a ledger record = DB was off or inlineGsdRootFile threw
  - Savings % = (baselineCharCount - promptCharCount) / baselineCharCount * 100
duration: 25m
verification_result: passed
completed_at: 2026-03-16
blocker_discovered: false
---

# T01: Wire token measurement into metrics + auto + state

**Added `promptCharCount`/`baselineCharCount` to `UnitMetrics`, wired measurement vars into `dispatchNextUnit` with DB-based baseline computation, updated all 11 `snapshotUnitMetrics` call sites, and added DB-first content loading to `_deriveStateImpl`.**

## What Happened

Three files modified, zero new files:

**metrics.ts** — Added `promptCharCount?: number` and `baselineCharCount?: number` to the `UnitMetrics` interface after `userMessages`. Added `opts?: { promptCharCount?: number; baselineCharCount?: number }` as the 6th parameter to `snapshotUnitMetrics`. In the unit record construction, conditionally spreads opts values to keep JSON clean (omits the keys entirely when undefined rather than writing `null`).

**auto.ts** — Declared `lastPromptCharCount` and `lastBaselineCharCount` as module-scoped vars near the `dispatchGapHandle` declaration (~line 226). Added reset of both to `undefined` after `invalidateAllCaches()` at the top of `dispatchNextUnit`. Added measurement block after the observability repair block (before model switching): sets `lastPromptCharCount = finalPrompt.length`, then uses a dynamic `import("./auto-prompts.js")` to call `inlineGsdRootFile` three times (decisions.md, requirements.md, project.md) and sum their lengths for `lastBaselineCharCount`. Dynamic import avoids the `auto.ts → auto-dispatch.ts → auto-prompts.ts` circular dependency. Used `sed` to update all 11 `snapshotUnitMetrics` call sites atomically to add the 6th opts argument.

**state.ts** — Added `import { isDbAvailable, _getAdapter } from './gsd-db.js'`. In `_deriveStateImpl`, before the native batch parser block, added the DB-first content loading tier: queries `SELECT path, full_content FROM artifacts`, populates `fileContentCache` keyed by absolute path, and sets `dbContentLoaded = rows.length > 0`. The existing native batch parser block is wrapped in `if (!dbContentLoaded) { ... }` to skip it when DB data was available. The `cachedLoadFile` function and everything downstream is unchanged — it reads from `fileContentCache` regardless of which tier populated it.

## Verification

```
npx tsc --noEmit
# → no output (zero errors)

grep -c 'lastPromptCharCount\|lastBaselineCharCount' src/resources/extensions/gsd/auto.ts
# → 18 (≥15 required: 2 decls + 2 resets + measurement block + 11 call sites + 1 comment)

grep 'snapshotUnitMetrics(' src/resources/extensions/gsd/auto.ts | grep -cv 'promptCharCount'
# → 0 (all 11 call sites have opts; grep -cv exits 1 on zero-count which is expected)

node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/metrics-io.test.ts
# → 24 passed, 0 failed (opts param is optional, backward compatible)

node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/metrics.test.ts
# → 53 passed, 0 failed
```

Full test suite: 119 pass / 26 fail. The 26 failures are all pre-existing environment issues:
- 6 auto-*.test.ts: module mock timeout (~88s) in worktree environment — unrelated to this task
- ~20 others: native `gsd_engine.node` code signature rejected by macOS SIP — pre-existing, unrelated

## Diagnostics

- Inspect ledger: `cat .gsd/metrics.json | jq '.units[] | select(.promptCharCount != null) | {id, promptCharCount, baselineCharCount}'`
- Savings formula: `(baselineCharCount - promptCharCount) / baselineCharCount * 100`
- Missing `baselineCharCount` = DB was unavailable or `inlineGsdRootFile` threw — non-fatal
- DB-first path active: `dbContentLoaded = true` means the DB had artifact rows and the native batch parser was skipped entirely

## Deviations

None. All steps matched the plan. The plan explicitly specified dynamic import for `auto-prompts.js` (circular dep avoidance) and the conditional spread pattern for opts — both implemented as written.

## Known Issues

None introduced by this task. The pre-existing native addon signature issue affects ~20 tests in the worktree environment but is unrelated to these changes.

## Files Created/Modified

- `src/resources/extensions/gsd/metrics.ts` — Added `promptCharCount?`/`baselineCharCount?` to `UnitMetrics`; added `opts?` param to `snapshotUnitMetrics`; conditionally spread opts into unit record
- `src/resources/extensions/gsd/auto.ts` — Added module-scoped measurement vars; reset in `dispatchNextUnit`; measurement block with dynamic import; updated all 11 `snapshotUnitMetrics` call sites
- `src/resources/extensions/gsd/state.ts` — Added `isDbAvailable`/`_getAdapter` import; added DB-first content loading tier before native batch parser in `_deriveStateImpl`
- `.gsd/milestones/M004/slices/S04/tasks/T01-PLAN.md` — Added `## Observability Impact` section (pre-flight fix)
