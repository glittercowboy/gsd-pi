# S03: Workflow Visualizer Page

**Goal:** Dedicated visualizer page with 7 tabbed sections (Progress, Deps, Metrics, Timeline, Agent, Changes, Export) showing real project data via API route.
**Demo:** User clicks "Visualize" in sidebar NavRail (or types `/gsd visualize` in terminal) → navigates to a full-page tabbed visualizer showing real milestone/slice/task progress, dependency graphs, cost metrics, timeline, agent activity, changelog, and export controls — all backed by live `loadVisualizerData()` data.

## Must-Haves

- `/api/visualizer` GET endpoint returns serialized `VisualizerData` with Maps converted to Records
- Browser-safe TypeScript interfaces in `web/lib/visualizer-types.ts` mirroring upstream types
- `VisualizerView` React component with 7 functioning tabs: Progress, Deps, Metrics, Timeline, Agent, Changes, Export
- "Visualize" entry in sidebar NavRail navigating to the visualizer view
- `activeView === "visualize"` renders the visualizer in app-shell
- `/gsd visualize` dispatch navigates to the visualizer view (not the generic command surface placeholder)
- All 7 tabs render without console errors and show real project data when available
- Client-side markdown/JSON export download from the Export tab

## Proof Level

- This slice proves: integration
- Real runtime required: yes (API route exercises upstream filesystem data loader)
- Human/UAT required: no (build + API response shape + UI rendering are machine-verifiable)

## Verification

- `npm run build:web-host` exits 0 — all new TypeScript compiles
- `npm run build` exits 0 — no regressions in main build
- `curl http://localhost:3000/api/visualizer` returns valid JSON with `milestones`, `phase`, `totals`, `criticalPath` fields; `criticalPath.milestoneSlack` and `criticalPath.sliceSlack` are plain objects (not empty `{}` from Map serialization failure)
- Browser: sidebar shows "Visualize" icon that navigates to visualizer view
- Browser: all 7 tabs render without errors; switching between tabs is smooth
- Browser: `/gsd visualize` in terminal navigates to visualizer view (not generic placeholder)
- Browser: Export tab generates and downloads markdown/JSON files

## Observability / Diagnostics

- Runtime signals: API route returns structured JSON error with message on failure; `Cache-Control: no-store` prevents stale data
- Inspection surfaces: `GET /api/visualizer` — returns full visualizer data payload; response shape is the primary diagnostic
- Failure visibility: API 500 response includes error message; component shows loading/error state when fetch fails
- Redaction constraints: none — visualizer data is project structure and metrics, no secrets

## Integration Closure

- Upstream surfaces consumed: `loadVisualizerData()` from `src/resources/extensions/gsd/visualizer-data.ts`; type interfaces `VisualizerData`, `VisualizerMilestone`, `VisualizerSlice`, `VisualizerTask`, `CriticalPathInfo`, `AgentActivityInfo`, `ChangelogEntry`, `ChangelogInfo` from same module; metric types `ProjectTotals`, `PhaseAggregate`, `SliceAggregate`, `ModelAggregate`, `UnitMetrics`, `TokenCounts` from `metrics.ts`; `Phase` type from `types.ts`
- New wiring introduced in this slice: `src/web/visualizer-service.ts` → `web/app/api/visualizer/route.ts` → `web/components/gsd/visualizer-view.tsx` fetches from route; app-shell renders VisualizerView; sidebar NavRail entry; dispatch navigates to view
- What remains before the milestone is truly usable end-to-end: S04 (diagnostics), S05 (knowledge/captures), S06 (settings), S07 (remaining commands), S08 (parity audit), S09 (test hardening)

## Tasks

- [x] **T01: Create visualizer API route, service layer, and browser types** `est:45m`
  - Why: Establishes the data pipeline from upstream `loadVisualizerData()` through a Next.js API route to the browser. This is the riskiest part — first time the upstream filesystem-based data loader runs in the web host context. Map→Record serialization for `CriticalPathInfo.milestoneSlack` and `.sliceSlack` must be explicit to avoid silent `JSON.stringify(new Map())` → `{}` failure.
  - Files: `src/web/visualizer-service.ts`, `web/app/api/visualizer/route.ts`, `web/lib/visualizer-types.ts`
  - Do: (1) Create `src/web/visualizer-service.ts` following the `recovery-diagnostics-service.ts` pattern — import `resolveBridgeRuntimeConfig` from `bridge-service.ts` to get `projectCwd`, call `loadVisualizerData(projectCwd)`, convert `criticalPath.milestoneSlack` and `criticalPath.sliceSlack` from `Map<string, number>` to `Record<string, number>` via `Object.fromEntries()`. (2) Create `web/app/api/visualizer/route.ts` following the `web/app/api/recovery/route.ts` pattern — `runtime = "nodejs"`, `dynamic = "force-dynamic"`, GET handler with try/catch, `Cache-Control: no-store`. (3) Create `web/lib/visualizer-types.ts` with browser-safe interfaces mirroring all upstream types but with `Record<string, number>` replacing `Map<string, number>` for slack fields, plus formatting utility functions (`formatCost`, `formatTokenCount`, `formatDuration`).
  - Verify: `npm run build:web-host` exits 0
  - Done when: API route compiles, browser types defined, service layer converts Maps to Records

- [ ] **T02: Build VisualizerView component with 7 tabbed sections** `est:2h`
  - Why: The core user-facing work — translates the TUI's 7 visualizer tab renderers (755 lines in `visualizer-views.ts`) into React components. Each tab renders a section of the VisualizerData. Uses existing Radix UI Tabs components.
  - Files: `web/components/gsd/visualizer-view.tsx`
  - Do: Create `web/components/gsd/visualizer-view.tsx` that fetches from `/api/visualizer` on mount with a 10-second auto-refresh interval. Use `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `@/components/ui/tabs`. Implement all 7 tab sections referencing `visualizer-views.ts` for content guidance: **Progress** — risk heatmap + milestone/slice/task tree with status icons; **Deps** — milestone dependency listing + slice dependency listing + critical path display; **Metrics** — cost/token summary + by-phase breakdown + by-model breakdown; **Timeline** — unit execution timeline with duration bars; **Agent** — active status, progress, rate, session cost, recent units; **Changes** — completed slice changelog with files modified; **Export** — client-side markdown/JSON download buttons generating blobs from the current data. Match the existing app-shell aesthetic (dark theme, Tailwind classes, same component patterns as dashboard.tsx). Show loading skeleton on initial fetch and error state on failure. Relevant skill: `frontend-design` (for the visualizer UI quality).
  - Verify: `npm run build:web-host` exits 0
  - Done when: Component compiles with all 7 tabs rendering their respective data sections

- [ ] **T03: Wire visualizer into app-shell, sidebar, and dispatch** `est:30m`
  - Why: Connects the visualizer view to the rest of the app so users can actually reach it — sidebar navigation, app-shell rendering, and `/gsd visualize` slash command dispatch.
  - Files: `web/components/gsd/app-shell.tsx`, `web/components/gsd/sidebar.tsx`, `web/components/gsd/command-surface.tsx`, `web/lib/browser-slash-command-dispatch.ts`, `web/lib/gsd-workspace-store.tsx`
  - Do: (1) In `app-shell.tsx`: add `"visualize"` to `KNOWN_VIEWS` set, import `VisualizerView`, add `{activeView === "visualize" && <VisualizerView />}` render branch. (2) In `sidebar.tsx`: add `{ id: "visualize", label: "Visualize", icon: BarChart3 }` to `navItems` array (import `BarChart3` from lucide-react). (3) For `/gsd visualize` dispatch: make the dispatch navigate to the visualizer view instead of opening the command surface generic placeholder. In the workspace store's `dispatchSlashCommand` method (or in the dispatch function), detect `outcome.surface === "gsd-visualize"` and emit `window.dispatchEvent(new CustomEvent("gsd:navigate-view", { detail: { view: "visualize" } }))` instead of opening the command surface. In `app-shell.tsx`, add a `gsd:navigate-view` event listener (parallel to the existing `gsd:open-file` listener) that calls `handleViewChange(event.detail.view)`. (4) Optionally clean up the generic `gsd-` placeholder in command-surface.tsx to no longer match `gsd-visualize` (since it now navigates directly).
  - Verify: `npm run build:web-host` exits 0; `npm run build` exits 0
  - Done when: "Visualize" appears in sidebar NavRail, clicking it shows the visualizer view, and `/gsd visualize` navigates to the view

## Files Likely Touched

- `src/web/visualizer-service.ts` (new)
- `web/app/api/visualizer/route.ts` (new)
- `web/lib/visualizer-types.ts` (new)
- `web/components/gsd/visualizer-view.tsx` (new)
- `web/components/gsd/app-shell.tsx` (modify)
- `web/components/gsd/sidebar.tsx` (modify)
- `web/components/gsd/command-surface.tsx` (modify)
- `web/lib/browser-slash-command-dispatch.ts` (modify)
- `web/lib/gsd-workspace-store.tsx` (modify)
