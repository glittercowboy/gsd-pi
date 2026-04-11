# Providers & Models — Multi-Model by Default

Pi isn't locked to one provider. It supports 20+ providers out of the box and lets you add more.

### Authentication Methods

**OAuth subscriptions (via `/login`):**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API keys (via environment variables):**
- Anthropic, Anthropic (Vertex AI), OpenAI, Azure OpenAI, Google Gemini, Google Vertex, Amazon Bedrock
- Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway
- ZAI, OpenCode Zen, OpenCode Go, Hugging Face, Kimi, MiniMax

### Model Switching

You can switch models at any time during a conversation:

- `/model` — Open the model selector
- `Ctrl+L` — Same as `/model`
- `Ctrl+P` / `Shift+Ctrl+P` — Cycle through scoped models
- `Shift+Tab` — Cycle thinking level

Model changes are recorded in the session as `model_change` entries, so when you resume a session, pi knows which model you were using.

### CLI Model Selection

```bash
pi --model sonnet                          # Fuzzy match
pi --model openai/gpt-4o                   # Provider/model
pi --model sonnet:high                     # With thinking level
pi --models "claude-*,gpt-4o"             # Scope models for Ctrl+P cycling
pi --list-models                           # List all available
pi --list-models gemini                    # Search by name
```

### Custom Providers

Add providers via `~/.gsd/agent/models.json` (simple) or extensions (advanced with OAuth, custom streaming):

```json
// ~/.gsd/agent/models.json
{
  "providers": [{
    "name": "my-proxy",
    "baseUrl": "https://proxy.example.com",
    "apiKey": "PROXY_API_KEY",
    "api": "anthropic-messages",
    "models": [{ "id": "claude-sonnet-4", "name": "Sonnet via Proxy", ... }]
  }]
}
```

---
