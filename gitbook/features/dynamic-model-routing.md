# Dynamic Model Routing

Dynamic model routing automatically selects cheaper models for simple work and reserves expensive models for complex tasks. This reduces cost by 20-50% without sacrificing quality where it matters.

## Enabling

```yaml
dynamic_routing:
  enabled: true
```

## How It Works

Each unit passes through two stages:

1. **Complexity classification** — classifies work as light, standard, or heavy
2. **Capability scoring** — within the tier, ranks models by how well they match the task

**Key rule:** Your configured model is always the ceiling — routing never upgrades beyond what you've set.

| Tier | Typical Work | Model Level |
|------|-------------|-------------|
| Light | Slice completion, UAT, hooks | Haiku-class |
| Standard | Research, planning, execution | Sonnet-class |
| Heavy | Replanning, roadmap reassessment | Opus-class |

## Configuration

```yaml
dynamic_routing:
  enabled: true
  tier_models:                    # optional: explicit model per tier
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-7
  escalate_on_failure: true       # bump tier on failure (default)
  budget_pressure: true           # auto-downgrade near budget ceiling (default)
  cross_provider: true            # consider models from other providers (default)
  capability_routing: true        # score models by task fit (default)
```

### Escalate on Failure

When a task fails at a given tier, the router escalates to the next tier on retry: Light → Standard → Heavy. This prevents cheap models from burning retries on work that needs more reasoning.

### Budget Pressure

When approaching the budget ceiling, the router progressively downgrades:

| Budget Used | Effect |
|------------|--------|
| < 50% | No adjustment |
| 50-75% | Standard → Light |
| 75-90% | More aggressive |
| > 90% | Nearly everything → Light |

### Cross-Provider

When enabled, the router may select models from providers other than your primary, using the built-in cost table to find the cheapest model at each tier.

### Capability Routing

Models are scored across 7 dimensions: coding, debugging, research, reasoning, speed, long context handling, and instruction following. Different task types weight these dimensions differently — a research task prioritizes research and reasoning, while an execution task prioritizes coding and instruction following.

Set `capability_routing: false` to revert to simple cheapest-in-tier selection.

## Interaction with Token Profiles

Dynamic routing and token profiles work together:

- **Token profiles** control phase skipping and context compression
- **Dynamic routing** controls per-unit model selection

The `budget` profile + dynamic routing provides maximum cost savings.

## Adaptive Learning

GSD tracks routing outcomes in `.gsd/routing-history.json`. If a tier's failure rate exceeds 20% for a given task type, future classifications are bumped up.

Use `/gsd rate` to submit feedback:

```
/gsd rate over    # too powerful — use cheaper next time
/gsd rate ok      # just right
/gsd rate under   # too weak — use stronger next time
```

Feedback is weighted 2x compared to automatic outcomes.
