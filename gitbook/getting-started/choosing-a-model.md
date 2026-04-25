# Choosing a Model

GSD auto-selects a default model after you log in to a provider. You can switch models at any time.

## Switch Models

Inside a GSD session, type:

```
/model
```

This opens an interactive picker showing all available models from your configured providers.

## Per-Phase Models

Different phases of work have different requirements. You can assign specific models to each phase in your preferences:

```yaml
models:
  research: claude-sonnet-4-6        # scouting and research
  planning: claude-opus-4-7          # architectural decisions
  execution: claude-sonnet-4-6       # writing code
  execution_simple: claude-haiku-4-5 # simple tasks (docs, config)
  completion: claude-sonnet-4-6      # summaries and wrap-up
  subagent: claude-sonnet-4-6        # delegated sub-tasks
```

Omit a key to use whatever model is currently active for that phase.

## Model Fallbacks

If a model is unavailable (provider down, rate limited, credits exhausted), GSD can automatically fall back to another:

```yaml
models:
  planning:
    model: claude-opus-4-7
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/moonshotai/kimi-k2.5
```

Fallbacks are tried in order until one works.

## Token Profiles

Token profiles coordinate model selection, phase skipping, and context compression with a single setting:

| Profile | Cost Savings | Best For |
|---------|-------------|----------|
| `budget` | 40-60% | Prototyping, small projects, well-understood codebases |
| `balanced` | 10-20% | Most projects, day-to-day development (default) |
| `quality` | 0% (baseline) | Complex architectures, greenfield projects, critical work |

```yaml
token_profile: balanced
```

See [Token Optimization](../features/token-optimization.md) for details.

## Dynamic Model Routing

When enabled, GSD automatically picks cheaper models for simple tasks and reserves expensive ones for complex work:

```yaml
dynamic_routing:
  enabled: true
```

A documentation fix gets Haiku. An architectural refactor gets Opus. Your configured model is always the ceiling — routing never upgrades beyond what you've set.

See [Dynamic Model Routing](../features/dynamic-model-routing.md) for the full guide.

## Supported Providers

GSD supports 20+ providers out of the box. See [Provider Setup](../configuration/providers.md) for setup instructions:

| Provider | Auth Method |
|----------|-------------|
| Anthropic (Claude) | OAuth or API key |
| OpenAI | API key |
| Google Gemini | API key |
| OpenRouter | API key |
| Groq | API key |
| xAI (Grok) | API key |
| Mistral | API key |
| GitHub Copilot | OAuth |
| Amazon Bedrock | IAM credentials |
| Vertex AI | ADC |
| Azure OpenAI | API key |
| Ollama | Local (no auth) |
| LM Studio | Local (no auth) |
| vLLM / SGLang | Local (no auth) |
