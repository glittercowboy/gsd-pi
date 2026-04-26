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
| `PI_TOKEN_TELEMETRY` | (unset) | Set to literal `1` to emit opt-in per-call token telemetry as JSONL on stderr. Other values are ignored. |

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

## Token Telemetry

Set `PI_TOKEN_TELEMETRY=1` to emit raw token and prompt-cache telemetry for each assistant API attempt. Telemetry writes to stderr, so stdout remains available for normal TUI output or headless `--json` events.

```bash
# Capture telemetry separately from headless JSONL events
PI_TOKEN_TELEMETRY=1 gsd headless --json auto \
  > gsd-events.jsonl \
  2> token-telemetry.jsonl

# Capture telemetry from an interactive session
PI_TOKEN_TELEMETRY=1 gsd 2> token-telemetry.jsonl
```

Each line is one JSON object:

| Field | Description |
|-------|-------------|
| `ts` | Assistant message timestamp in milliseconds since Unix epoch. |
| `model` | Model identifier used for the call. |
| `stopReason` | Provider stop reason recorded for the assistant message, such as `stop` or `error`. |
| `input` | Input tokens reported for the call, excluding tokens served from prompt cache. |
| `output` | Output tokens reported for the call. |
| `cacheRead` | Input tokens read from prompt cache. |
| `cacheWrite` | Input tokens written to prompt cache. |
| `costTotal` | Provider total cost from the model registry. This is `0` when no rate is known for the model. |
| `cacheHitRatio` | `cacheRead / (cacheRead + input)`. This is `0` when both values are zero and `1` for a full cache hit. |

Records are per attempt, not per user turn. A retrying call can emit one line for the failed assistant message, usually with `stopReason: "error"`, plus one line for each retry attempt that reaches an assistant message. Keep every line for billed-attempt accounting; group with session logs or timestamps downstream if you need a deduplicated final-response view.

## URL Blocking

The `fetch_page` tool blocks requests to private/internal networks by default (SSRF protection). To allow specific internal hosts:

```bash
export GSD_FETCH_ALLOWED_URLS="internal-docs.company.com,192.168.1.50"
```

Or set `fetchAllowedUrls` in `~/.gsd/agent/settings.json`.

Blocked by default: private IP ranges, cloud metadata endpoints, localhost, non-HTTP protocols, IPv6 private ranges.
