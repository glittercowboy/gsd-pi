# Dynamic Model Routing

*Introduced in v2.19.0. Capability scoring introduced in v2.52.0.*

Dynamic model routing automatically selects cheaper models for simple work and reserves expensive models for complex tasks. This reduces token consumption by 20-50% on capped plans without sacrificing quality where it matters.

Starting in v2.52.0, the router uses **capability-aware scoring** to select the *best fit* model for each task, not just the cheapest one in the tier.

## How It Works

Each unit dispatched by auto-mode passes through a two-stage pipeline:

**Stage 1: Complexity classification** — classifies the work into a tier (light/standard/heavy).

**Stage 2: Capability scoring** — within the eligible tier, ranks available models by how well their capabilities match the task's requirements.

The key rule: **downgrade-only semantics**. The user's configured model is always the ceiling — routing never upgrades beyond what you've configured.

| Tier | Typical Work | Default Model Level |
|------|-------------|-------------------|
| **Light** | Slice completion, UAT, hooks | Haiku-class |
| **Standard** | Research, planning, execution, milestone completion | Sonnet-class |
| **Heavy** | Replanning, roadmap reassessment, complex execution | Opus-class |

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
  capability_routing: true        # enable capability scoring within tier (default: true)
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

### `capability_routing`

When enabled (default: true), the router uses capability scoring to pick the best model in a tier rather than always defaulting to the cheapest. Set to `false` to revert to cheapest-in-tier behavior:

```yaml
dynamic_routing:
  enabled: true
  capability_routing: false   # disable scoring, use cheapest-in-tier
```

## Capability Profiles

Each model has a built-in **capability profile** — a 7-dimension score (0–100) representing how well it handles different task types:

| Dimension | What It Represents |
|-----------|-------------------|
| `coding` | Code generation and implementation accuracy |
| `debugging` | Diagnosing and fixing errors |
| `research` | Synthesizing information and exploring topics |
| `reasoning` | Multi-step logical reasoning |
| `speed` | Latency and throughput (inverse of capability depth) |
| `longContext` | Handling large codebases and long documents |
| `instruction` | Following structured instructions precisely |

**Built-in profiles** exist for 9 models: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-4o`, `gpt-4o-mini`, `gemini-2.5-pro`, `gemini-2.0-flash`, `deepseek-chat`, `o3`.

Models without a built-in profile receive **uniform scores of 50** across all dimensions. This is a cold-start policy — unknown models compete but don't have an advantage. From the user's perspective, routing behaves the same as before capability scoring was introduced for those models.

**Profiles are heuristic rankings, not benchmarks.** They represent approximate relative strengths, not verified benchmark results. Use user overrides (below) to correct them for models you know well.

## How Scoring Works

The routing pipeline within a tier:

```
classify complexity tier
    ↓
filter eligible models for tier
    ↓
fire before_model_select hook (optional override)
    ↓
capability score eligible models
    ↓
select winner (or first eligible if scoring is disabled)
```

**Scoring formula:** weighted average of capability dimensions

```
score = Σ(weight × capability) / Σ(weights)
```

**Task requirements** are dynamic — different task types weight dimensions differently:

| Unit Type | Key Dimensions |
|-----------|---------------|
| `execute-task` | coding (0.9), instruction (0.7), speed (0.3) |
| `research-*` | research (0.9), longContext (0.7), reasoning (0.5) |
| `plan-*` | reasoning (0.9), coding (0.5) |
| `replan-slice` | reasoning (0.9), debugging (0.6), coding (0.5) |
| `complete-slice`, `run-uat` | instruction (0.8), speed (0.7) |

For `execute-task`, requirements are further refined by task metadata signals:
- Tags like `docs`, `config`, `readme` → boost instruction weight
- Keywords like `concurrency`, `compatibility` → boost debugging and reasoning
- Keywords like `migration`, `architecture` → boost reasoning and coding
- Large file counts (≥6) or large estimated line counts (≥500) → boost coding and reasoning

**Tie-breaking:** When two models score within 2 points of each other, the cheaper model wins. If costs are equal, lexicographic model ID breaks the tie (deterministic).

## User Overrides

Correct built-in capability profiles for models you know well using `modelOverrides` in your models configuration:

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-sonnet-4-6": {
          "capabilities": {
            "debugging": 90,
            "research": 85
          }
        }
      }
    }
  }
}
```

Overrides are **deep-merged** with built-in defaults — only the specified dimensions are overridden; others retain their built-in values.

**Use case:** You've found that a model consistently outperforms its built-in profile on specific task types. Override the relevant dimensions to steer the router toward that model for those tasks.

## Verbose Output

When verbose mode is active, the router logs its routing decision. When capability scoring was used, the log includes a full scoring breakdown:

```
Dynamic routing [S]: claude-sonnet-4-6 (capability-scored) — claude-sonnet-4-6: 82.3, gpt-4o: 78.1, deepseek-chat: 72.0
```

When tier-only routing was used (scoring disabled, single eligible model, or routing guards applied):

```
Dynamic routing [S]: claude-sonnet-4-6 (standard complexity, multiple steps)
```

The `selectionMethod` field in the routing decision indicates which path was taken:
- `"capability-scored"` — capability scoring selected the winner
- `"tier-only"` — cheapest in tier (or explicit pin) was used

## Extension Hook

Extensions can intercept and override model selection using the `before_model_select` hook.

The hook fires **after** tier filtering (eligible models are known) and **before** capability scoring (scores have not been computed yet). A hook can override selection entirely or return `undefined` to let scoring proceed normally.

**Registering a handler:**

```typescript
pi.on("before_model_select", async (event) => {
  const { unitType, unitId, classification, taskMetadata, eligibleModels, phaseConfig } = event;

  // Custom routing strategy: always use gemini for research tasks
  if (unitType.startsWith("research-")) {
    const gemini = eligibleModels.find(id => id.includes("gemini"));
    if (gemini) return { modelId: gemini };
  }

  // Return undefined to let capability scoring proceed
  return undefined;
});
```

**Event payload:**

| Field | Type | Description |
|-------|------|-------------|
| `unitType` | `string` | The unit type being dispatched (e.g., `"execute-task"`) |
| `unitId` | `string` | Unique identifier for this unit dispatch |
| `classification` | `{ tier, reason, downgraded }` | The complexity classification result |
| `taskMetadata` | `Record<string, unknown> \| undefined` | Task metadata extracted from the unit plan |
| `eligibleModels` | `string[]` | Models eligible for the classified tier |
| `phaseConfig` | `{ primary, fallbacks } \| undefined` | The user's configured model for this phase |

**Return value:** `{ modelId: string }` to override selection, or `undefined` to defer to capability scoring.

**First-override-wins:** If multiple extensions register handlers, the first one to return a non-undefined result wins. Subsequent handlers are not called.

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
