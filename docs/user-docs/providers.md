# Provider Setup Guide

Step-by-step setup instructions for every LLM provider GSD supports. If you ran the onboarding wizard (`gsd config`) and picked a provider, you may already be configured — check with `/model` inside a session.

## Table of Contents

- [Quick Reference](#quick-reference)
- [Built-in Providers](#built-in-providers)
  - [Anthropic (Claude)](#anthropic-claude)
  - [OpenAI](#openai)
  - [Google Gemini](#google-gemini)
  - [OpenRouter](#openrouter)
  - [Groq](#groq)
  - [xAI (Grok)](#xai-grok)
  - [Mistral](#mistral)
  - [GitHub Copilot](#github-copilot)
  - [Amazon Bedrock](#amazon-bedrock)
  - [Anthropic on Vertex AI](#anthropic-on-vertex-ai)
  - [Azure OpenAI](#azure-openai)
- [Local Providers](#local-providers)
  - [Ollama](#ollama)
  - [LM Studio](#lm-studio)
  - [vLLM](#vllm)
  - [SGLang](#sglang)
- [Custom OpenAI-Compatible Endpoints](#custom-openai-compatible-endpoints)
- [Common Pitfalls](#common-pitfalls)
- [Verifying Your Setup](#verifying-your-setup)

## Quick Reference

| Provider | Auth Method | Env Variable | Config File |
|----------|-------------|-------------|-------------|
| Anthropic | API key | `ANTHROPIC_API_KEY` | — |
| OpenAI | API key | `OPENAI_API_KEY` | — |
| Google Gemini | API key | `GEMINI_API_KEY` | — |
| OpenRouter | API key | `OPENROUTER_API_KEY` | Optional `models.json` |
| Groq | API key | `GROQ_API_KEY` | — |
| xAI | API key | `XAI_API_KEY` | — |
| Mistral | API key | `MISTRAL_API_KEY` | — |
| GitHub Copilot | OAuth | `GH_TOKEN` | — |
| Amazon Bedrock | IAM credentials | `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` | — |
| Vertex AI | ADC | `GOOGLE_APPLICATION_CREDENTIALS` | — |
| Azure OpenAI | API key | `AZURE_OPENAI_API_KEY` | — |
| Ollama | None (local) | — | `models.json` required |
| LM Studio | None (local) | — | `models.json` required |
| vLLM / SGLang | None (local) | — | `models.json` required |

---

## Built-in Providers

Built-in providers have models pre-registered in GSD. You only need to supply credentials.

### Anthropic (Claude)

**Recommended.** Anthropic models have the deepest integration: built-in web search, extended thinking, and prompt caching.

**Option A — API key (recommended):**

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Or run `gsd config` and paste your key when prompted.

**Get a key:** [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

**Option B — Claude Code CLI:**

If you have a Claude Pro or Max subscription, you can authenticate through Anthropic's official Claude Code CLI. Install it, sign in with `claude`, then GSD will detect and route through it automatically:

```bash
# Install Claude Code CLI (see https://docs.anthropic.com/en/docs/claude-code)
claude
# Sign in when prompted, then start GSD
gsd
```

GSD detects your local Claude Code installation and uses it as the authenticated Anthropic surface. This is the TOS-compliant path for subscription users — GSD never handles your subscription credentials directly.

> **Note:** GSD does not support browser-based OAuth sign-in for Anthropic. Use an API key or the Claude Code CLI instead.

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
```

Or run `gsd config` and choose "Paste an API key" then "OpenAI".

**Get a key:** [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

### Google Gemini

```bash
export GEMINI_API_KEY="..."
```

**Get a key:** [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

### OpenRouter

OpenRouter aggregates 200+ models from multiple providers behind a single API key.

**Step 1 — Get your API key:**

Go to [openrouter.ai/keys](https://openrouter.ai/keys) and create a key.

**Step 2 — Set the key:**

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Or run `gsd config`, choose "Paste an API key", then "OpenRouter".

**Step 3 — Switch to an OpenRouter model:**

Inside a GSD session, type `/model` and select an OpenRouter model. Models are prefixed with `openrouter/` (e.g., `openrouter/anthropic/claude-sonnet-4`).

**Optional — Add custom OpenRouter models via `models.json`:**

If you want models not in the built-in list, add them to `~/.gsd/agent/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "meta-llama/llama-3.3-70b",
          "name": "Llama 3.3 70B (OpenRouter)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 32768,
          "cost": { "input": 0.3, "output": 0.3, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Note: the `apiKey` field here is the *name* of the environment variable, not the literal key. GSD resolves it automatically. You can also use a literal value or a shell command (see [Value Resolution](./custom-models.md#value-resolution)).

**Optional — Route through specific providers:**

Use `modelOverrides` to control which upstream provider OpenRouter uses:

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

### Groq

```bash
export GROQ_API_KEY="gsk_..."
```

**Get a key:** [console.groq.com/keys](https://console.groq.com/keys)

### xAI (Grok)

```bash
export XAI_API_KEY="xai-..."
```

**Get a key:** [console.x.ai](https://console.x.ai)

### Mistral

```bash
export MISTRAL_API_KEY="..."
```

**Get a key:** [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys)

### GitHub Copilot

Uses OAuth — sign in through the browser:

```bash
gsd config
# Choose "Sign in with your browser" → "GitHub Copilot"
```

Requires an active GitHub Copilot subscription.

### Amazon Bedrock

Bedrock uses AWS IAM credentials, not API keys. Any of these work:

```bash
# Option 1: Named profile
export AWS_PROFILE="my-profile"

# Option 2: IAM keys
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"

# Option 3: Bedrock API key (bearer token)
export AWS_BEARER_TOKEN_BEDROCK="..."
```

ECS task roles and IRSA (Kubernetes) are also detected automatically.

### Anthropic on Vertex AI

Uses Google Cloud Application Default Credentials:

```bash
gcloud auth application-default login
export ANTHROPIC_VERTEX_PROJECT_ID="my-project-id"
```

Or set `GOOGLE_CLOUD_PROJECT` and ensure ADC credentials exist at `~/.config/gcloud/application_default_credentials.json`.

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY="..."
```

---

## Local Providers

Local providers run on your machine. They require a `models.json` configuration file because GSD needs to know the endpoint URL and which models are available.

**Config file location:** `~/.gsd/agent/models.json`

The file reloads each time you open `/model` — no restart needed.

### Ollama

**Step 1 — Install and start Ollama:**

```bash
# macOS
brew install ollama
ollama serve

# Or download from https://ollama.com
```

**Step 2 — Pull a model:**

```bash
ollama pull llama3.1:8b
ollama pull qwen2.5-coder:7b
```

**Step 3 — Create `~/.gsd/agent/models.json`:**

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The `apiKey` is required by the config schema but Ollama ignores it — any value works.

**Step 4 — Select the model:**

Inside GSD, type `/model` and pick your Ollama model.

**Ollama tips:**
- Ollama does not support the `developer` role or `reasoning_effort` — always set `compat.supportsDeveloperRole: false` and `compat.supportsReasoningEffort: false`.
- If you get empty responses, check that `ollama serve` is running and the model is pulled.
- Context window and max tokens default to 128K / 16K if not specified. Override these if your model has different limits.

### LM Studio

**Step 1 — Install LM Studio:**

Download from [lmstudio.ai](https://lmstudio.ai).

**Step 2 — Start the local server:**

In LM Studio, go to the "Local Server" tab, load a model, and click "Start Server". The default port is 1234.

**Step 3 — Create `~/.gsd/agent/models.json`:**

```json
{
  "providers": {
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "your-model-name",
          "name": "My Local Model",
          "contextWindow": 32768,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

Replace `your-model-name` with the model identifier shown in LM Studio's server tab.

**LM Studio tips:**
- The model ID in `models.json` must match what LM Studio reports in its server API. Check the server tab for the exact string.
- LM Studio defaults to port 1234. If you changed it, update `baseUrl` accordingly.
- Increase `contextWindow` and `maxTokens` if your model supports larger contexts.

### vLLM

```json
{
  "providers": {
    "vllm": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "vllm",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        {
          "id": "meta-llama/Llama-3.1-8B-Instruct",
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

The model `id` must match the `--model` flag you passed to `vllm serve`.

### SGLang

```json
{
  "providers": {
    "sglang": {
      "baseUrl": "http://localhost:30000/v1",
      "api": "openai-completions",
      "apiKey": "sglang",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "meta-llama/Llama-3.1-8B-Instruct"
        }
      ]
    }
  }
}
```

---

## Custom OpenAI-Compatible Endpoints

Any server that implements the OpenAI Chat Completions API can work with GSD. This covers proxies (LiteLLM, Portkey, Helicone), self-hosted inference, and new providers.

**Quickest path — use the onboarding wizard:**

```bash
gsd config
# Choose "Paste an API key" → "Custom (OpenAI-compatible)"
# Enter: base URL, API key, model ID
```

This writes `~/.gsd/agent/models.json` for you automatically.

**Manual setup:**

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
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

**Adding custom headers (for proxies):**

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

**Qwen models with thinking mode:**

For Qwen-compatible servers, use `thinkingFormat` to enable thinking mode:

```json
{
  "compat": {
    "thinkingFormat": "qwen",
    "supportsDeveloperRole": false
  }
}
```

Use `"qwen-chat-template"` instead if the server requires `chat_template_kwargs.enable_thinking`.

For the full reference on `compat` fields, `modelOverrides`, value resolution, and advanced configuration, see [Custom Models](./custom-models.md).

---

## Common Pitfalls

### "Authentication failed" with a valid key

**Cause:** The key is set in your shell but not visible to GSD.

**Fix:** Make sure the environment variable is exported in the same terminal where you run `gsd`. Or use `gsd config` to save the key to `~/.gsd/agent/auth.json` so it persists across sessions.

### OpenRouter models not appearing in `/model`

**Cause:** No `OPENROUTER_API_KEY` set, so GSD hides OpenRouter models.

**Fix:** Set the key and restart GSD:

```bash
export OPENROUTER_API_KEY="sk-or-..."
gsd
```

### Ollama returns empty responses

**Cause:** Ollama server isn't running, or the model isn't pulled.

**Fix:**

```bash
# Verify the server is running
curl http://localhost:11434/v1/models

# Pull the model if missing
ollama pull llama3.1:8b
```

### LM Studio model ID mismatch

**Cause:** The `id` in `models.json` doesn't match what LM Studio exposes via its API.

**Fix:** Check the LM Studio server tab for the exact model identifier. It often includes the filename or quantization level (e.g., `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF`).

### `developer` role error with local models

**Cause:** Most local inference servers don't support the OpenAI `developer` message role.

**Fix:** Add `compat.supportsDeveloperRole: false` to the provider config. This makes GSD send `system` messages instead:

```json
{
  "compat": {
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": false
  }
}
```

### `stream_options` error with local models

**Cause:** Some servers don't support `stream_options: { include_usage: true }`.

**Fix:** Add `compat.supportsUsageInStreaming: false`:

```json
{
  "compat": {
    "supportsUsageInStreaming": false
  }
}
```

### "apiKey is required" validation error

**Cause:** `models.json` schema requires `apiKey` when `models` are defined.

**Fix:** For local servers that don't need auth, set a dummy value:

```json
"apiKey": "not-needed"
```

### Cost shows $0.00 for custom models

**Expected behavior.** GSD defaults cost to zero for custom models. Override with the `cost` field if you want accurate cost tracking:

```json
"cost": { "input": 0.15, "output": 0.60, "cacheRead": 0.015, "cacheWrite": 0.19 }
```

Values are per million tokens.

---

## Verifying Your Setup

After configuring a provider:

1. **Launch GSD:**
   ```bash
   gsd
   ```

2. **Check available models:**
   ```
   /model
   ```
   Your provider's models should appear in the list.

3. **Switch to the model:**
   Select it from the `/model` picker.

4. **Send a test message:**
   Type anything to confirm the model responds.

If the model doesn't appear, check:
- The environment variable is set in the current shell
- `models.json` is valid JSON (use `cat ~/.gsd/agent/models.json | python3 -m json.tool`)
- The server is running (for local providers)

For additional help, see [Troubleshooting](./troubleshooting.md) or run `/gsd doctor` inside a session.
