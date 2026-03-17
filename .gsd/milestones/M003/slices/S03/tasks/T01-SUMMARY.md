---
id: T01
parent: S03
milestone: M003
provides:
  - GET /api/visualizer endpoint returning serialized VisualizerData
  - Browser-safe TypeScript interfaces for all visualizer types
  - Service layer with Map→Record conversion for critical-path slack fields
key_files:
  - src/web/visualizer-service.ts
  - web/app/api/visualizer/route.ts
  - web/lib/visualizer-types.ts
key_decisions:
  - Child-process pattern required for visualizer-data.ts because upstream uses Node ESM .js import extensions that Turbopack cannot resolve
patterns_established:
  - Same execFile + resolve-ts.mjs child-process pattern as auto-dashboard-service and recovery-diagnostics-service
observability_surfaces:
  - GET /api/visualizer — returns full serialized VisualizerData or { error } with 500 status
duration: 12m
verification_result: passed
completed_at: 2026-03-16
blocker_discovered: false
---

# T01: Create visualizer API route, service layer, and browser types

**Built data pipeline from upstream loadVisualizerData() through child-process service layer and API route to browser, with explicit Map→Record conversion for critical-path slack fields.**

## What Happened

Created three files establishing the visualizer data pipeline:

1. **`src/web/visualizer-service.ts`** — Service layer that spawns a child process to call `loadVisualizerData()` from the upstream extension code. Uses the same `execFile` + `resolve-ts.mjs` pattern as `auto-dashboard-service.ts` and `recovery-diagnostics-service.ts`. The child script converts `criticalPath.milestoneSlack` and `criticalPath.sliceSlack` from `Map<string, number>` to `Record<string, number>` via `Object.fromEntries()` before JSON serialization.

2. **`web/lib/visualizer-types.ts`** — Browser-safe TypeScript interfaces mirroring all upstream types (`VisualizerMilestone`, `VisualizerSlice`, `VisualizerTask`, `CriticalPathInfo`, `AgentActivityInfo`, `ChangelogEntry`, `ChangelogInfo`, `TokenCounts`, `UnitMetrics`, `PhaseAggregate`, `SliceAggregate`, `ModelAggregate`, `ProjectTotals`, `VisualizerData`). `CriticalPathInfo` declares `Record<string, number>` for slack fields. Includes three formatting utilities: `formatCost`, `formatTokenCount`, `formatDuration`.

3. **`web/app/api/visualizer/route.ts`** — GET endpoint following the exact `web/app/api/recovery/route.ts` pattern: `runtime = "nodejs"`, `dynamic = "force-dynamic"`, try/catch with `Cache-Control: no-store`.

## Verification

- `npm run build:web-host` exits 0 — route listed as `ƒ /api/visualizer`
- `rg "Object.fromEntries" src/web/visualizer-service.ts` → 2 matches (milestoneSlack, sliceSlack)
- `rg "Record<string, number>" web/lib/visualizer-types.ts` → 2 matches (milestoneSlack, sliceSlack)
- `rg 'runtime = "nodejs"' web/app/api/visualizer/route.ts` → 1 match

Slice-level checks (partial — expected for T01):
- ✅ `npm run build:web-host` exits 0
- ⏳ `npm run build` (not yet run — deferred to T03 wiring task)
- ⏳ `curl /api/visualizer` (requires running server — deferred to later task)
- ⏳ Browser: sidebar, tabs, dispatch — not yet implemented (T02, T03)

## Diagnostics

- `GET /api/visualizer` returns the full payload or structured `{ error: string }` with 500 status
- `curl http://localhost:3000/api/visualizer | jq .criticalPath` — verify milestoneSlack/sliceSlack are populated objects
- Common failures: missing `.gsd` directory, subprocess timeout, malformed state files — all surface as error message in 500 response

## Deviations

**Child-process pattern instead of direct import.** The plan specified direct `import { loadVisualizerData }` from the upstream module. This fails because `visualizer-data.ts` internally uses `.js` import extensions (Node ESM convention: `import { deriveState } from './state.js'`) which Turbopack cannot resolve to `.ts` files. Switched to the established `execFile` + `resolve-ts.mjs` child-process pattern used by `auto-dashboard-service.ts` and `recovery-diagnostics-service.ts`. The `Object.fromEntries()` Map→Record conversion now happens inside the child script string rather than in the service function directly.

## Known Issues

None.

## Files Created/Modified

- `src/web/visualizer-service.ts` — new; child-process service wrapping loadVisualizerData() with Map→Record conversion
- `web/app/api/visualizer/route.ts` — new; GET endpoint with nodejs runtime, force-dynamic, Cache-Control: no-store
- `web/lib/visualizer-types.ts` — new; browser-safe interfaces for all visualizer types + formatting utilities
- `.gsd/milestones/M003/slices/S03/tasks/T01-PLAN.md` — added Observability Impact section
