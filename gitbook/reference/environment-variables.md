# Environment Variables

## GSD Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_HOME` | `~/.gsd` | Global GSD directory. All paths derive from this unless individually overridden. |
| `GSD_PROJECT_ID` | (auto-hash) | Override automatic project identity hash. Useful for CI/CD or sharing state across repo clones. |
| `GSD_STATE_DIR` | `$GSD_HOME` | Per-project state root. Controls where `projects/<repo-hash>/` directories are created. |
| `GSD_CODING_AGENT_DIR` | `$GSD_HOME/agent` | Agent directory for extensions, auth, and managed resources. |
| `GSD_FETCH_ALLOWED_URLS` | (none) | Comma-separated hostnames exempt from internal URL blocking. |
| `GSD_ALLOWED_COMMAND_PREFIXES` | (built-in) | Comma-separated command prefixes allowed for value resolution. |
| `GSD_WEB_PROJECT_CWD` | — | Default project path for `gsd --web` when `?project=` is not specified. |

## LLM Provider Keys

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI |
| `GEMINI_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `GROQ_API_KEY` | Groq |
| `XAI_API_KEY` | xAI (Grok) |
| `MISTRAL_API_KEY` | Mistral |
| `GH_TOKEN` | GitHub Copilot |
| `AWS_PROFILE` | Amazon Bedrock (named profile) |
| `AWS_ACCESS_KEY_ID` | Amazon Bedrock (IAM keys) |
| `AWS_SECRET_ACCESS_KEY` | Amazon Bedrock (IAM keys) |
| `AWS_REGION` | Amazon Bedrock (region) |
| `AWS_BEARER_TOKEN_BEDROCK` | Amazon Bedrock (bearer token) |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex AI |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex AI (ADC) |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI |

## Tool API Keys

| Variable | Purpose |
|----------|---------|
| `TAVILY_API_KEY` | Tavily web search |
| `BRAVE_API_KEY` | Brave web search |
| `CONTEXT7_API_KEY` | Context7 documentation lookup |
| `DISCORD_BOT_TOKEN` | Discord remote questions |
| `TELEGRAM_BOT_TOKEN` | Telegram remote questions |

## URL Blocking

The `fetch_page` tool blocks requests to private/internal networks by default (SSRF protection). To allow specific internal hosts:

```bash
export GSD_FETCH_ALLOWED_URLS="internal-docs.company.com,192.168.1.50"
```

Or set `fetchAllowedUrls` in `~/.gsd/agent/settings.json`.

Blocked by default: private IP ranges, cloud metadata endpoints, localhost, non-HTTP protocols, IPv6 private ranges.
