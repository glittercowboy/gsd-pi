# Dynamic Model Routing

*Introduced in v2.19.0*

Dynamic model routing automatically selects cheaper models for simple work and reserves expensive models for complex tasks. This reduces token consumption by 20-50% on capped plans without sacrificing quality where it matters.

## How It Works

Each unit dispatched by auto-mode is classified into a complexity tier:

| Tier | Typical Work | Default Model Level |
|------|-------------|-------------------|
| **Light** | Slice completion, UAT, hooks | Haiku-class |
| **Standard** | Research, planning, execution, milestone completion | Sonnet-class |
| **Heavy** | Replanning, roadmap reassessment, complex execution | Opus-class |

The router then selects a model for that tier. The key rule: **downgrade-only semantics**. The user's configured model is always the ceiling — routing never upgrades beyond what you've configured.

## Enabling

Dynamic routing is off by default. Enable it in preferences:

```yaml
---
version: 1
dynamic_routing:
  enabled: true
---
```

## Configuration

```yaml
dynamic_routing:
  enabled: true
  tier_models:                    # explicit model per tier (optional)
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-6
  escalate_on_failure: true       # bump tier on task failure (default: true)
  budget_pressure: true           # auto-downgrade when approaching budget ceiling (default: true)
  cross_provider: true            # consider models from other providers (default: true)
  hooks: true                     # apply routing to post-unit hooks (default: true)
```

### `tier_models`

Override which model is used for each tier. When omitted, the router uses a built-in capability mapping that knows common model families:

- **Light:** `claude-haiku-4-5`, `gpt-4o-mini`, `gemini-2.0-flash`
- **Standard:** `claude-sonnet-4-6`, `gpt-4o`, `gemini-2.5-pro`
- **Heavy:** `claude-opus-4-6`, `gpt-4.5-preview`, `gemini-2.5-pro`

### `escalate_on_failure`

When a task fails at a given tier, the router escalates to the next tier on retry. Light → Standard → Heavy. This prevents cheap models from burning retries on work that needs more reasoning.

### `budget_pressure`

When approaching the budget ceiling, the router progressively downgrades:

| Budget Used | Effect |
|------------|--------|
| < 50% | No adjustment |
| 50-75% | Standard → Light |
| 75-90% | More aggressive downgrading |
| > 90% | Nearly everything → Light; only Heavy stays at Standard |

### `cross_provider`

When enabled, the router may select models from providers other than your primary. This uses the built-in cost table to find the cheapest model at each tier. Requires the target provider to be configured.

## Complexity Classification

Units are classified using pure heuristics — no LLM calls, sub-millisecond:

### Unit Type Defaults

| Unit Type | Default Tier |
|-----------|-------------|
| `complete-slice`, `run-uat` | Light |
| `research-*`, `plan-*`, `complete-milestone` | Standard |
| `execute-task` | Standard (upgraded by task analysis) |
| `replan-slice`, `reassess-roadmap` | Heavy |
| `hook/*` | Light |

### Task Plan Analysis

For `execute-task` units, the classifier analyzes the task plan:

| Signal | Simple → Light | Complex → Heavy |
|--------|---------------|----------------|
| Step count | ≤ 3 | ≥ 8 |
| File count | ≤ 3 | ≥ 8 |
| Description length | < 500 chars | > 2000 chars |
| Code blocks | — | ≥ 5 |
| Complexity keywords | None | Present |

**Complexity keywords:** `research`, `investigate`, `refactor`, `migrate`, `integrate`, `complex`, `architect`, `redesign`, `security`, `performance`, `concurrent`, `parallel`, `distributed`, `backward compat`

### Adaptive Learning

The routing history (`.gsd/routing-history.json`) tracks success/failure per tier per unit type. If a tier's failure rate exceeds 20% for a given pattern, future classifications are bumped up. User feedback (`over`/`under`/`ok`) is weighted 2× vs automatic outcomes.

## Interaction with Token Profiles

Dynamic routing and token profiles are complementary:

- **Token profiles** (`budget`/`balanced`/`quality`) control phase skipping and context compression
- **Dynamic routing** controls per-unit model selection within the configured phase model

When both are active, token profiles set the baseline models and dynamic routing further optimizes within those baselines. The `budget` token profile + dynamic routing provides maximum cost savings.

## Cost Table

The router includes a built-in cost table for common models, used for cross-provider cost comparison. Costs are per-million tokens (input/output):

| Model | Input | Output |
|-------|-------|--------|
| claude-haiku-4-5 | $0.80 | $4.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-opus-4-6 | $15.00 | $75.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-4o | $2.50 | $10.00 |
| gemini-2.0-flash | $0.10 | $0.40 |

The cost table is used for comparison only — actual billing comes from your provider.
