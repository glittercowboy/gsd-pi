# Workflow Visualizer

*Introduced in v2.19.0*

The workflow visualizer is a full-screen TUI overlay that shows project progress, dependencies, cost metrics, and execution timeline in an interactive four-tab view.

## Opening the Visualizer

```
/gsd visualize
```

Or configure automatic display after milestone completion:

```yaml
auto_visualize: true
```

## Tabs

Switch tabs with `Tab`, `1`-`4`, or arrow keys.

### 1. Progress

A tree view of milestones, slices, and tasks with completion status:

```
M001: User Management                        3/6 tasks ⏳
  ✅ S01: Auth module                         3/3 tasks
    ✅ T01: Core types
    ✅ T02: JWT middleware
    ✅ T03: Login flow
  ⏳ S02: User dashboard                      1/2 tasks
    ✅ T01: Layout component
    ⬜ T02: Profile page
  ⬜ S03: Admin panel                         0/1 tasks
```

Shows checkmarks for completed items, spinners for in-progress, and empty boxes for pending. Task counts and completion percentages are displayed at each level.

**Discussion status** is also shown when milestones have been through a discussion phase — indicates whether requirements were captured and what state the discussion left off in.

### 2. Dependencies

An ASCII dependency graph showing slice relationships:

```
S01 ──→ S02 ──→ S04
  └───→ S03 ──↗
```

Visualizes the `depends:` field from the roadmap, making it easy to see which slices are blocked and which can proceed.

### 3. Metrics

Bar charts showing cost and token usage breakdowns:

- **By phase** — research, planning, execution, completion, reassessment
- **By slice** — cost per slice with running totals
- **By model** — which models consumed the most budget

Uses data from `.gsd/metrics.json`.

### 4. Timeline

Chronological execution history showing:

- Unit type and ID
- Start/end timestamps
- Duration
- Model used
- Token counts

Ordered by execution time, showing the full history of auto-mode dispatches.

## Controls

| Key | Action |
|-----|--------|
| `Tab` | Next tab |
| `Shift+Tab` | Previous tab |
| `1`-`4` | Jump to tab |
| `↑`/`↓` | Scroll within tab |
| `Escape` / `q` | Close visualizer |

## Auto-Refresh

The visualizer refreshes data from disk every 2 seconds, so it stays current if opened alongside a running auto-mode session.

## HTML Export (v2.26)

For shareable reports outside the terminal, use `/gsd export --html`. This generates a self-contained HTML file in `.gsd/reports/` with the same data as the TUI visualizer — progress tree, dependency graph (SVG DAG), cost/token bar charts, execution timeline, changelog, and knowledge base. All CSS and JS are inlined — no external dependencies. Printable to PDF from any browser.

An auto-generated `index.html` shows all reports with progression metrics across milestones.

```yaml
auto_report: true    # auto-generate after milestone completion (default)
```

## Configuration

```yaml
auto_visualize: true    # show visualizer after milestone completion
```
