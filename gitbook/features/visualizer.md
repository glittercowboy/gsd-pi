# Workflow Visualizer

The workflow visualizer is a full-screen terminal overlay showing project progress, dependencies, cost metrics, and execution timeline.

## Opening

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
M001: User Management                        3/6 tasks
  ✅ S01: Auth module                         3/3 tasks
    ✅ T01: Core types
    ✅ T02: JWT middleware
    ✅ T03: Login flow
  ⏳ S02: User dashboard                      1/2 tasks
    ✅ T01: Layout component
    ⬜ T02: Profile page
```

### 2. Dependencies

An ASCII dependency graph showing slice relationships:

```
S01 ──→ S02 ──→ S04
  └───→ S03 ──↗
```

### 3. Metrics

Bar charts showing cost and token usage:

- By phase (research, planning, execution, completion)
- By slice (with running totals)
- By model (which models consumed the most budget)

### 4. Timeline

Chronological execution history: unit type, timestamps, duration, model, and token counts.

## Controls

| Key | Action |
|-----|--------|
| `Tab` | Next tab |
| `Shift+Tab` | Previous tab |
| `1`-`4` | Jump to tab |
| `↑`/`↓` | Scroll |
| `Escape` / `q` | Close |

The visualizer auto-refreshes every 2 seconds, staying current alongside running auto mode.

## HTML Reports

For shareable reports outside the terminal:

```
/gsd export --html              # current milestone
/gsd export --html --all        # all milestones
```

Generates self-contained HTML files in `.gsd/reports/` with progress tree, dependency graph, cost charts, timeline, and changelog. All CSS and JS are inlined — no external dependencies. Printable to PDF from any browser.

```yaml
auto_report: true    # auto-generate after milestone completion (default)
```
