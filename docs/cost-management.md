# Cost Management

GSD tracks token usage and cost for every unit of work dispatched during auto mode. This data powers the dashboard, budget enforcement, and cost projections.

## Cost Tracking

Every unit's metrics are captured automatically:

- **Token counts** — input, output, cache read, cache write, total
- **Cost** — USD cost per unit
- **Duration** — wall-clock time
- **Tool calls** — number of tool invocations
- **Message counts** — assistant and user messages

Data is stored in `.gsd/metrics.json` and survives across sessions.

### Viewing Costs

**Dashboard:** `Ctrl+Alt+G` or `/gsd status` shows real-time cost breakdown.

**Aggregations available:**
- By phase (research, planning, execution, completion, reassessment)
- By slice (M001/S01, M001/S02, ...)
- By model (which models consumed the most budget)
- Project totals

## Budget Ceiling

Set a maximum spend for a project:

```yaml
---
version: 1
budget_ceiling: 50.00
---
```

### Enforcement Modes

Control what happens when the ceiling is reached:

```yaml
budget_enforcement: pause    # default when ceiling is set
```

| Mode | Behavior |
|------|----------|
| `warn` | Log a warning, continue executing |
| `pause` | Pause auto mode, wait for user action |
| `halt` | Stop auto mode entirely |

## Cost Projections

Once at least two slices have completed, GSD projects the remaining cost:

```
Projected remaining: $12.40 ($6.20/slice avg × 2 remaining)
```

Projections use per-slice averages from completed work. If the budget ceiling has been reached, a warning is appended.

## Budget Pressure & Model Downgrading

When approaching the budget ceiling, the [complexity router](./token-optimization.md#budget-pressure) automatically downgrades model assignments to cheaper tiers. This is graduated:

- **< 50% used** — no adjustment
- **50-75% used** — standard tasks downgrade to light
- **75-90% used** — same, more aggressive
- **> 90% used** — nearly everything downgrades; only heavy tasks stay at standard

This ensures the budget is spread across remaining work instead of being exhausted early on complex tasks.

## Token Profiles & Cost

The `token_profile` preference directly affects cost:

| Profile | Typical Savings | How |
|---------|----------------|-----|
| `budget` | 40-60% | Cheaper models, phase skipping, minimal context |
| `balanced` | 10-20% | Default models, skip slice research, standard context |
| `quality` | 0% (baseline) | Full models, all phases, full context |

See [Token Optimization](./token-optimization.md) for details.

## Tips

- Start with `balanced` profile and a generous `budget_ceiling` to establish baseline costs
- Check `/gsd status` after a few slices to see per-slice cost averages
- Switch to `budget` profile for well-understood, repetitive work
- Use `quality` only when architectural decisions are being made
- Per-phase model selection lets you use Opus only for planning while keeping execution on Sonnet
- Enable `dynamic_routing` for automatic model downgrading on simple tasks — see [Dynamic Model Routing](./dynamic-model-routing.md)
- Use `/gsd visualize` → Metrics tab to see where your budget is going
