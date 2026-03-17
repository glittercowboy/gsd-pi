---
estimated_steps: 4
estimated_files: 1
---

# T02: Build VisualizerView component with 7 tabbed sections

**Slice:** S03 — Workflow Visualizer Page
**Milestone:** M003

## Description

Creates the main `VisualizerView` React component — the largest piece of this slice. The component fetches from `/api/visualizer` (created in T01) and renders 7 tabbed sections translating the TUI's text-based visualizer views into React. Each tab displays a section of the `VisualizerData` type. Uses the existing Radix UI `Tabs` components from `web/components/ui/tabs.tsx`.

The TUI renderer (`src/resources/extensions/gsd/visualizer-views.ts`, 755 lines) defines exactly what each tab should show — it's the design reference. The browser version translates these text renderers into structured React markup with Tailwind styling, matching the dark-themed aesthetic of existing views like `dashboard.tsx`.

Relevant skill to load: `frontend-design` — for UI quality guidance on the tab content layout.

## Steps

1. **Create `web/components/gsd/visualizer-view.tsx`** with the following structure:
   - Import types from `@/lib/visualizer-types` (created in T01)
   - Import `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` from `@/components/ui/tabs`
   - Import formatting utils (`formatCost`, `formatTokenCount`, `formatDuration`) from `@/lib/visualizer-types`
   - Import icons from `lucide-react` as needed (e.g., `CheckCircle2`, `Circle`, `Play`, `AlertTriangle`, `Clock`, `DollarSign`, `Download`, `Activity`, `GitBranch`, `ArrowRight`, `BarChart3`)
   - Import `cn` from `@/lib/utils` for conditional className merging

2. **Implement data fetching and state management:**
   - Use `useState` for `data: VisualizerData | null`, `loading: boolean`, `error: string | null`
   - Use `useEffect` to fetch `/api/visualizer` on mount and set up a 10-second auto-refresh interval
   - Handle loading state with a skeleton/spinner
   - Handle error state with a clear error message
   - Handle empty state (no milestones, no metrics) gracefully

3. **Implement all 7 tab content sections** (reference `src/resources/extensions/gsd/visualizer-views.ts` for content guidance — DO NOT import it):

   **Progress tab:**
   - Risk heatmap showing milestones with risk distribution (colored indicators: green for done/low, yellow for medium, red for high/blocked)
   - Milestone/slice/task tree with status icons (✓ for done, ▸ for active, ○ for pending)
   - Show risk, depends, and completion count for each slice
   - Show task list under each slice with done/active/pending status

   **Deps tab:**
   - Milestone dependencies listing: for each milestone, show what it depends on and what depends on it
   - Slice dependencies listing: for each active milestone's slices, show `depends:` relationships
   - Critical path display: show the milestone critical path and slice critical path from `criticalPath`
   - Slack values from `criticalPath.milestoneSlack` and `criticalPath.sliceSlack`

   **Metrics tab:**
   - Summary row: total units, total cost, total duration, total tokens
   - By-phase breakdown: table/card grid showing each phase's unit count, cost, duration, token breakdown
   - By-model breakdown: table/card grid showing each model's unit count, cost, tokens
   - By-slice breakdown: table/card grid showing each slice's unit count, cost, duration
   - Use `formatCost()`, `formatTokenCount()`, `formatDuration()` from visualizer-types

   **Timeline tab:**
   - Unit execution timeline: list of units sorted by `startedAt`, showing type, id, model, duration, cost
   - Duration bars: visual bars showing relative duration of each unit (bar width proportional to max duration)
   - Condensed view for many units; expanded view for fewer

   **Agent tab:**
   - If `agentActivity` is null: show "No agent activity data available"
   - If present: show active status, current unit (if running), elapsed time, completion rate as progress bar, completed units / total slices, session cost, session tokens

   **Changes tab:**
   - If changelog has no entries: show "No completed slices yet"
   - For each changelog entry: show milestone/slice ID, title, one-liner summary, files modified with descriptions, completed-at timestamp
   - Most recent entries first

   **Export tab:**
   - Two download buttons: "Download Markdown" and "Download JSON"
   - Markdown export: generate a structured markdown report from the current `VisualizerData` (milestone list, metrics summary, critical path, changelog)
   - JSON export: `JSON.stringify(data, null, 2)` as a downloadable blob
   - Use `URL.createObjectURL(new Blob([content]))` + temporary `<a>` element for downloads
   - Show a brief description of what each format contains

4. **Verify the component compiles**: Run `npm run build:web-host`.

## Must-Haves

- [ ] `web/components/gsd/visualizer-view.tsx` exists and exports `VisualizerView` component
- [ ] Component fetches from `/api/visualizer` on mount with 10s auto-refresh
- [ ] All 7 tabs are implemented with real data rendering (not placeholders)
- [ ] Loading, error, and empty states are handled
- [ ] Export tab generates client-side markdown and JSON downloads
- [ ] Component uses existing UI patterns (Tailwind, cn(), lucide-react icons, Radix Tabs)
- [ ] `npm run build:web-host` exits 0

## Verification

- `npm run build:web-host` exits 0
- `rg "TabsTrigger" web/components/gsd/visualizer-view.tsx` shows 7 tab triggers
- `rg "TabsContent" web/components/gsd/visualizer-view.tsx` shows 7 tab content sections
- `rg "api/visualizer" web/components/gsd/visualizer-view.tsx` shows the fetch call
- `rg "createObjectURL\|Blob" web/components/gsd/visualizer-view.tsx` shows the export download mechanism

## Inputs

- `web/lib/visualizer-types.ts` — browser-safe types and formatting utils (from T01)
- `web/app/api/visualizer/route.ts` — API endpoint to fetch from (from T01)
- `src/resources/extensions/gsd/visualizer-views.ts` — TUI renderer reference for content guidance (755 lines, read for design reference, DO NOT import)
- `web/components/ui/tabs.tsx` — Radix UI Tabs components
- `web/components/gsd/dashboard.tsx` — existing component pattern reference (data fetching, Tailwind usage, icon imports)
- `web/lib/utils.ts` — `cn()` utility for conditional classes

## Observability Impact

- **Client fetch cycle**: Component fetches `GET /api/visualizer` on mount and every 10s. Network tab shows periodic requests; 500 responses surface as error state in the UI.
- **Tab rendering**: Each of the 7 tabs renders conditionally from `VisualizerData` fields. Empty/null data branches show explicit "no data" messages rather than blank panes.
- **Export downloads**: Export tab creates client-side Blob URLs for markdown/JSON downloads. Browser download activity confirms export works. No server round-trip.
- **Inspection**: `React DevTools → VisualizerView` shows current `data`, `loading`, `error` state. Console errors from failed fetches are not swallowed.
- **Failure visibility**: Loading spinner on initial fetch; error banner with message on fetch failure; graceful empty states when data fields are null/empty.

## Expected Output

- `web/components/gsd/visualizer-view.tsx` — new file, ~500-700 lines, complete visualizer component with 7 tabbed sections rendering real project data
