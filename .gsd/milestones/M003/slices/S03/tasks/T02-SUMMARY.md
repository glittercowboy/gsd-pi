---
id: T02
parent: S03
milestone: M003
provides:
  - VisualizerView React component with 7 tabbed sections rendering real project data
  - Client-side markdown/JSON export download via Blob URLs
key_files:
  - web/components/gsd/visualizer-view.tsx
key_decisions:
  - Each tab is a standalone function component receiving `data: VisualizerData` — keeps the main component thin and tabs independently testable
  - 10-second auto-refresh via setInterval with useCallback-memoized fetch to avoid re-render churn
  - Export uses client-side Blob+createObjectURL pattern — no server round-trip needed for download
patterns_established:
  - Tab-per-section pattern: each visualizer tab is a named function component (ProgressTab, DepsTab, etc.) that receives the full VisualizerData and renders its section
  - StatCell reusable card for metric display (label/value/sub layout)
  - Risk heatmap as colored grid blocks with tooltip titles
observability_surfaces:
  - Component shows loading spinner on initial fetch, error banner with retry button on failure, stale-data warning when refresh fails but prior data exists
  - Console errors from failed fetches are not swallowed — they surface in browser DevTools
  - React DevTools shows VisualizerView state (data, loading, error) for inspection
duration: ~25m
verification_result: passed
blocker_discovered: false
---

# T02: Build VisualizerView component with 7 tabbed sections

**Built full VisualizerView component with Progress/Deps/Metrics/Timeline/Agent/Changes/Export tabs, fetching live data from /api/visualizer with 10s auto-refresh.**

## What Happened

Created `web/components/gsd/visualizer-view.tsx` (~700 lines) implementing all 7 tabs defined in the TUI renderer (`visualizer-views.ts`), translated into React+Tailwind following the dashboard's dark-themed aesthetic:

- **Progress tab**: Risk heatmap (colored grid blocks per milestone), milestone/slice/task tree with status icons (✓/▸/○), risk badges, dependency notes, task counts. Active slices expand to show task list.
- **Deps tab**: Milestone dependency arrows, slice dependencies for active milestone, critical path visualization with milestone chain and slice chain (styled as badge pills with arrows), bottleneck warnings for critical-but-not-started slices, slack values.
- **Metrics tab**: Summary stat cards (units/cost/duration/tokens), by-phase breakdown with progress bars, by-model breakdown with progress bars, by-slice table, and projections section (avg cost/slice, projected remaining, burn rate, budget warnings).
- **Timeline tab**: Execution timeline showing last 30 units with time/status/type/ID/duration-bar/cost, sorted most recent first.
- **Agent tab**: Active/idle status with dot indicator, current unit card, completion progress bar, session stats grid, recent completed units list.
- **Changes tab**: Completed slice changelog with milestone/slice ID, title, one-liner quote, files modified with descriptions, relative timestamps. Most recent first.
- **Export tab**: Two download buttons (Markdown and JSON) using client-side Blob+createObjectURL pattern. Markdown generator produces structured report with milestones, metrics table, critical path, and changelog.

State management: `useState` for data/loading/error, `useEffect` with 10s interval, `useCallback`-memoized fetch. Three states: loading (spinner), error-no-data (warning + retry), loaded (tabs). Stale-data warning shown when refresh fails but prior data exists.

## Verification

- `npm run build:web-host` exits 0 — component compiles cleanly
- `rg "<TabsTrigger" web/components/gsd/visualizer-view.tsx` → 7 matches (one per tab)
- `rg "<TabsContent" web/components/gsd/visualizer-view.tsx` → 7 matches (one per tab)
- `rg "api/visualizer" web/components/gsd/visualizer-view.tsx` → fetch call present
- `rg "createObjectURL|Blob" web/components/gsd/visualizer-view.tsx` → Blob download mechanism present
- Component exports `VisualizerView` as named export

### Slice-level verification (partial — T02 is intermediate):
- ✅ `npm run build:web-host` exits 0
- ⬜ `npm run build` — will verify on final task
- ⬜ `curl /api/visualizer` — requires running dev server (verified at T01)
- ⬜ Browser: sidebar shows "Visualize" — requires T03 wiring
- ⬜ Browser: all 7 tabs render — requires T03 wiring
- ⬜ Browser: `/gsd visualize` dispatch — requires T03 wiring
- ⬜ Browser: Export tab downloads — requires T03 wiring

## Diagnostics

- **Inspect component state**: React DevTools → search for `VisualizerView` → check `data`, `loading`, `error` hooks
- **Network tab**: Look for periodic `GET /api/visualizer` requests every 10s after mount
- **Error shape**: When API returns 500, component parses `{ error: string }` from response body and displays it in the error banner
- **Export**: Export downloads create temporary Blob URLs — check browser download activity for `gsd-report.md` / `gsd-report.json`

## Deviations

None. Component implements all 7 tabs as specified in the task plan.

## Known Issues

None.

## Files Created/Modified

- `web/components/gsd/visualizer-view.tsx` — new file, ~700 lines, VisualizerView component with 7 tabbed sections
- `.gsd/milestones/M003/slices/S03/tasks/T02-PLAN.md` — added Observability Impact section (pre-flight fix)
