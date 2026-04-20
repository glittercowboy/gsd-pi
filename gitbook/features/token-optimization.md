# Token Optimization

GSD's token optimization system can reduce token usage by 40-60% without sacrificing output quality. It has three pillars: **token profiles**, **context compression**, and **complexity-based task routing**.

## Token Profiles

A token profile coordinates model selection, phase skipping, and context compression with a single setting:

```yaml
token_profile: balanced
```

### `budget` — Maximum Savings (40-60%)

| Setting | Value |
|---------|-------|
| Planning model | Sonnet |
| Execution model | Sonnet |
| Simple task model | Haiku |
| Milestone research | Skipped |
| Slice research | Skipped |
| Roadmap reassessment | Skipped |
| Context level | Minimal |

Best for: prototyping, small projects, well-understood codebases.

### `balanced` — Smart Defaults (default)

| Setting | Value |
|---------|-------|
| All models | User's default |
| Milestone research | Runs |
| Slice research | Skipped |
| Roadmap reassessment | Runs |
| Context level | Standard |

Best for: most projects, day-to-day development.

### `quality` — Full Context

| Setting | Value |
|---------|-------|
| All models | User's configured defaults |
| All phases | Run |
| Context level | Full |

Best for: complex architectures, greenfield projects, critical work.

## Context Compression

Each profile controls how much context is pre-loaded into AI prompts:

| Profile | What's Included |
|---------|----------------|
| `budget` | Task plan and essential prior summaries only |
| `balanced` | Task plan, summaries, slice plan, roadmap excerpt |
| `quality` | Everything — all plans, summaries, decisions, requirements |

## Complexity-Based Task Routing

GSD classifies each task by complexity and routes it to an appropriate model:

| Complexity | Indicators | Model Level |
|-----------|------------|-------------|
| Simple | ≤3 steps, ≤3 files, short description | Haiku-class |
| Standard | 4-7 steps, 4-7 files | Sonnet-class |
| Complex | ≥8 steps, ≥8 files, complexity keywords | Opus-class |

**Complexity keywords** that prevent simple classification: `refactor`, `migrate`, `integrate`, `architect`, `security`, `performance`, `concurrent`, `distributed`, and others.

{% hint style="info" %}
Dynamic routing requires `models` configured in your preferences and `dynamic_routing.enabled: true`. See [Dynamic Model Routing](dynamic-model-routing.md).
{% endhint %}

## Overriding Profile Defaults

The `token_profile` sets defaults, but explicit preferences always win:

```yaml
token_profile: budget
phases:
  skip_research: false        # override: keep research
models:
  planning: claude-opus-4-6   # override: use Opus for planning
```

## Adaptive Learning

GSD tracks success and failure of tier assignments over time. If a model tier's failure rate exceeds 20% for a given task type, future tasks of that type are bumped to a higher tier.

Submit manual feedback with:

```
/gsd rate over    # model was overpowered — use cheaper next time
/gsd rate ok      # model was appropriate
/gsd rate under   # model was too weak — use stronger next time
```

## Observation Masking

During auto mode, old tool results are replaced with lightweight placeholders before each AI call. This reduces token usage between compactions with zero overhead.

```yaml
context_management:
  observation_masking: true     # default: true
  observation_mask_turns: 8     # keep results from last 8 turns
  tool_result_max_chars: 800    # truncate large tool outputs
```
