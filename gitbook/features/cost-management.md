# Cost Management

GSD tracks token usage and cost for every unit of work during auto mode. This data powers the dashboard, budget enforcement, and cost projections.

## Viewing Costs

**Dashboard:** Press `Ctrl+Alt+G` or type `/gsd status` for real-time cost breakdown.

**Visualizer:** `/gsd visualize` → Metrics tab for detailed charts.

**Aggregations:**
- By phase (research, planning, execution, completion, reassessment)
- By slice
- By model
- Project totals

## Budget Ceiling

Set a maximum spend:

```yaml
budget_ceiling: 50.00
```

### Enforcement Modes

```yaml
budget_enforcement: pause    # default when ceiling is set
```

| Mode | What Happens |
|------|-------------|
| `warn` | Log a warning, keep going |
| `pause` | Pause auto mode, wait for you |
| `halt` | Stop auto mode entirely |

## Cost Projections

Once at least two slices have completed, GSD projects the remaining cost:

```
Projected remaining: $12.40 ($6.20/slice avg × 2 remaining)
```

## Budget Pressure

When approaching the budget ceiling, GSD automatically uses cheaper models:

| Budget Used | Effect |
|------------|--------|
| < 50% | No adjustment |
| 50-75% | Standard tasks downgrade to lighter models |
| 75-90% | More aggressive downgrading |
| > 90% | Nearly everything downgrades; only complex tasks stay at standard |

This spreads your budget across remaining work instead of exhausting it early.

## Token Profiles & Cost

| Profile | Typical Savings | How |
|---------|----------------|-----|
| `budget` | 40-60% | Cheaper models, phase skipping, minimal context |
| `balanced` | 10-20% | Default models, standard context |
| `quality` | 0% (baseline) | All phases, full context |

## Tips

- Start with `balanced` profile and a generous `budget_ceiling` to establish baseline costs
- Check `/gsd status` after a few slices to see per-slice cost averages
- Switch to `budget` for well-understood, repetitive work
- Use `quality` only when architectural decisions are being made
- Use per-phase model selection to save: Opus for planning, Sonnet for execution
- Enable `dynamic_routing` for automatic model downgrading on simple tasks
- Use `/gsd visualize` → Metrics tab to see where your budget is going
