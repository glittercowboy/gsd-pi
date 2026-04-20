# Provider Setup

Step-by-step setup instructions for every LLM provider GSD supports. If you ran the onboarding wizard (`gsd config`) and picked a provider, you may already be configured — check with `/model` inside a session.

## Quick Reference

| Provider | Auth Method | Environment Variable |
|----------|-------------|---------------------|
| Anthropic | OAuth or API key | `ANTHROPIC_API_KEY` |
| OpenAI | API key | `OPENAI_API_KEY` |
| Google Gemini | API key | `GEMINI_API_KEY` |
| OpenRouter | API key | `OPENROUTER_API_KEY` |
| Groq | API key | `GROQ_API_KEY` |
| xAI (Grok) | API key | `XAI_API_KEY` |
| Mistral | API key | `MISTRAL_API_KEY` |
| GitHub Copilot | OAuth | `GH_TOKEN` |
| Amazon Bedrock | IAM credentials | `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` |
| Vertex AI | ADC | `GOOGLE_APPLICATION_CREDENTIALS` |
| Azure OpenAI | API key | `AZURE_OPENAI_API_KEY` |
| Ollama | None (local) | — |
| LM Studio | None (local) | — |
| vLLM / SGLang | None (local) | — |

## Built-in Providers

### Anthropic (Claude)

**Recommended.** Anthropic models have the deepest integration: built-in web search, extended thinking, and prompt caching.

**Option A — Browser sign-in (recommended):**

```bash
gsd config
# Choose "Sign in with your browser" → "Anthropic (Claude)"
```

Or inside a session: `/login`

**Option B — API key:**

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
```

Or run `gsd config` and choose "Paste an API key" then "OpenAI".

### Google Gemini

```bash
export GEMINI_API_KEY="..."
```

### OpenRouter

OpenRouter aggregates 200+ models from multiple providers behind a single API key.

1. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Set it:
   ```bash
   export OPENROUTER_API_KEY="sk-or-..."
   ```
3. In GSD, type `/model` to select an OpenRouter model (prefixed with `openrouter/`)

To add models not in the built-in list, add them to `~/.gsd/agent/models.json`. See [Custom Models](custom-models.md).

### Groq

```bash
export GROQ_API_KEY="gsk_..."
```

### xAI (Grok)

```bash
export XAI_API_KEY="xai-..."
```

### Mistral

```bash
export MISTRAL_API_KEY="..."
```

### GitHub Copilot

Uses OAuth — sign in through the browser:

```bash
gsd config
# Choose "Sign in with your browser" → "GitHub Copilot"
```

Requires an active GitHub Copilot subscription.

### Amazon Bedrock

Bedrock uses AWS IAM credentials:

```bash
# Named profile
export AWS_PROFILE="my-profile"

# Or IAM keys
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"

# Or bearer token
export AWS_BEARER_TOKEN_BEDROCK="..."
```

ECS task roles and IRSA (Kubernetes) are also detected automatically.

### Anthropic on Vertex AI

```bash
gcloud auth application-default login
export ANTHROPIC_VERTEX_PROJECT_ID="my-project-id"
```

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY="..."
```

## Local Providers

Local providers run on your machine. They require a `models.json` configuration file at `~/.gsd/agent/models.json` because GSD needs to know the endpoint URL and available models.

The file reloads each time you open `/model` — no restart needed.

### Ollama

1. Install and start Ollama:
   ```bash
   brew install ollama
   ollama serve
   ```

2. Pull a model:
   ```bash
   ollama pull llama3.1:8b
   ```

3. Create `~/.gsd/agent/models.json`:
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
           { "id": "llama3.1:8b" }
         ]
       }
     }
   }
   ```

4. In GSD, type `/model` and select your Ollama model.

### LM Studio

1. Install [LM Studio](https://lmstudio.ai)
2. Go to "Local Server" tab, load a model, click "Start Server" (default port 1234)
3. Create `~/.gsd/agent/models.json`:
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
           { "id": "your-model-name" }
         ]
       }
     }
   }
   ```

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
        { "id": "meta-llama/Llama-3.1-8B-Instruct" }
      ]
    }
  }
}
```

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
        { "id": "meta-llama/Llama-3.1-8B-Instruct" }
      ]
    }
  }
}
```

## Custom OpenAI-Compatible Endpoints

Any server that implements the OpenAI Chat Completions API can work with GSD — proxies (LiteLLM, Portkey, Helicone), self-hosted inference, new providers.

**Quickest path:**

```bash
gsd config
# Choose "Paste an API key" → "Custom (OpenAI-compatible)"
# Enter: base URL, API key, model ID
```

This writes `~/.gsd/agent/models.json` for you. See [Custom Models](custom-models.md) for manual setup.

## Verifying Your Setup

1. Launch GSD: `gsd`
2. Check available models: `/model`
3. Select your model from the picker
4. Send a test message to confirm it responds

If the model doesn't appear, check:
- The environment variable is set in the current shell
- `models.json` is valid JSON
- The server is running (for local providers)

## Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| "Authentication failed" with valid key | Key not visible to GSD | Export in the same terminal, or save via `gsd config` |
| OpenRouter models not in `/model` | No API key set | Set `OPENROUTER_API_KEY` and restart |
| Ollama returns empty responses | Server not running or model not pulled | Run `ollama serve` and `ollama pull <model>` |
| LM Studio model ID mismatch | ID doesn't match server | Check LM Studio's server tab for the exact identifier |
| `developer` role error | Local server doesn't support it | Set `compat.supportsDeveloperRole: false` |
| `stream_options` error | Server doesn't support streaming usage | Set `compat.supportsUsageInStreaming: false` |
| Cost shows $0.00 | Default for custom models | Add `cost` field to model definition |
