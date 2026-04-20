# Custom Models

Define custom models and providers in `~/.gsd/agent/models.json`. This lets you add models not in the default registry — self-hosted endpoints, fine-tuned models, proxies, or new provider releases.

## File Location

GSD looks for models.json at:
1. `~/.gsd/agent/models.json` (primary)
2. `~/.pi/agent/models.json` (fallback)

The file reloads each time you open `/model` — no restart needed.

## Basic Structure

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://my-endpoint.example.com/v1",
      "apiKey": "MY_PROVIDER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "model-id-here",
          "name": "Friendly Model Name",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384,
          "cost": { "input": 0.15, "output": 0.60, "cacheRead": 0.015, "cacheWrite": 0.19 }
        }
      ]
    }
  }
}
```

## API Key Resolution

The `apiKey` field can be:

- **An environment variable name**: `"OPENROUTER_API_KEY"` — GSD resolves it automatically
- **A literal value**: `"sk-abc123..."` — used directly
- **A dummy value**: `"not-needed"` — for local servers that don't require auth

## Compatibility Flags

Local and non-standard servers often need compatibility adjustments:

```json
{
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false,
    "supportsUsageInStreaming": false,
    "thinkingFormat": "qwen"
  }
}
```

| Flag | Default | Purpose |
|------|---------|---------|
| `supportsDeveloperRole` | `true` | Set `false` if the server doesn't support the `developer` message role |
| `supportsReasoningEffort` | `true` | Set `false` if the server doesn't support reasoning effort parameters |
| `supportsUsageInStreaming` | `true` | Set `false` if streaming responses don't include token usage |
| `thinkingFormat` | — | Set `"qwen"` for Qwen thinking mode, `"qwen-chat-template"` for chat template variant |

## Custom Headers

For proxies that need extra headers:

```json
{
  "providers": {
    "litellm-proxy": {
      "baseUrl": "https://litellm.example.com/v1",
      "apiKey": "MY_API_KEY",
      "api": "openai-completions",
      "headers": {
        "x-custom-header": "value"
      },
      "models": [...]
    }
  }
}
```

## Model Overrides

Override specific model settings without redefining the entire model:

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

## Cost Tracking

For accurate cost tracking with custom models, add the `cost` field (per million tokens):

```json
"cost": {
  "input": 0.15,
  "output": 0.60,
  "cacheRead": 0.015,
  "cacheWrite": 0.19
}
```

Without this, cost shows $0.00 — which is the expected default for custom models.

## Community Extensions

For providers not built into GSD, community extensions add full provider support:

| Extension | Provider | Install |
|-----------|----------|---------|
| `pi-dashscope` | Alibaba DashScope (Qwen3, GLM-5, etc.) | `gsd install npm:pi-dashscope` |
