# Ollama Extension — First-Class Local LLM Support

## Status: DRAFT — Awaiting approval

## Problem

Ollama support in GSD2 currently requires manual `models.json` configuration. Users must:
1. Know the OpenAI-compatibility endpoint (`localhost:11434/v1`)
2. Manually list every model they want to use
3. Set compat flags (`supportsDeveloperRole: false`, etc.)
4. Use a dummy API key

There's an `ollama-cloud` provider for hosted Ollama, and a discovery adapter that can list models, but no first-class **local Ollama** extension that "just works."

## Goal

Make Ollama the easiest way to use GSD2 — zero config when Ollama is running locally. All Ollama functionality lives in a single extension: `src/resources/extensions/ollama/`.

## Architecture

Everything is a self-contained extension under `src/resources/extensions/ollama/`. The extension:
- Auto-detects Ollama on startup via health check
- Discovers and registers local models with the model registry
- Provides native Ollama API streaming (not OpenAI shim)
- Exposes `/ollama` slash commands for model management
- Registers an LLM-callable tool for model pull/status

Minimal core changes — only `KnownProvider` and `KnownApi` type additions in `pi-ai`, and `env-api-keys.ts` for key resolution. Everything else is in the extension.

## File Structure

```
src/resources/extensions/ollama/
├── index.ts                  # Extension entry — wires everything on session_start
├── ollama-client.ts          # HTTP client for Ollama REST API (/api/*)
├── ollama-discovery.ts       # Model discovery + capability detection
├── ollama-provider.ts        # Native /api/chat streaming provider (registers with pi-ai)
├── ollama-commands.ts        # /ollama slash commands (status, pull, list, remove, ps)
├── ollama-tool.ts            # LLM-callable tool for model management
├── model-capabilities.ts     # Known model capability table (context window, vision, reasoning)
└── types.ts                  # Shared types for Ollama API responses
```

## Scope

### Phase 1: Auto-Discovery + OpenAI-Compat Routing

**What:** Extension that auto-detects Ollama, discovers models, registers them using the existing `openai-completions` API provider. Zero config needed.

**Extension files:**
- `ollama/index.ts` — Main entry. On `session_start`:
  1. Probe `localhost:11434` (or `OLLAMA_HOST`) with 1.5s timeout
  2. If reachable, discover models via `/api/tags`
  3. Register discovered models with `ctx.modelRegistry` using correct defaults
  4. Show status widget if Ollama is detected
- `ollama/ollama-client.ts` — Low-level HTTP client:
  - `isRunning()` — `GET /` health check
  - `getVersion()` — `GET /api/version`
  - `listModels()` — `GET /api/tags`
  - `showModel(name)` — `POST /api/show` (details, template, parameters, size)
  - `getRunningModels()` — `GET /api/ps` (loaded models, VRAM usage)
  - `pullModel(name, onProgress)` — `POST /api/pull` (streaming progress)
  - `deleteModel(name)` — `DELETE /api/delete`
  - `copyModel(source, dest)` — `POST /api/copy`
  - Respects `OLLAMA_HOST` env var for non-default endpoints
- `ollama/ollama-discovery.ts` — Enhanced model discovery:
  - Calls `/api/tags` to get model list
  - Calls `/api/show` per model (batch, cached) to get:
    - `details.parameter_size` → estimate context window
    - `details.families` → detect vision (clip), reasoning (deepseek-r1)
    - `modelfile` → extract default parameters
  - Returns enriched `DiscoveredModel[]` with proper capabilities
- `ollama/model-capabilities.ts` — Known model lookup table:
  - Maps well-known model families to capabilities
  - e.g., `llama3.1` → `{ contextWindow: 131072, input: ["text"] }`
  - e.g., `llava` → `{ contextWindow: 4096, input: ["text", "image"] }`
  - e.g., `deepseek-r1` → `{ reasoning: true, contextWindow: 131072 }`
  - e.g., `qwen2.5-coder` → `{ contextWindow: 131072, input: ["text"] }`
  - Fallback: estimate from parameter count if not in table
- `ollama/types.ts` — Ollama API response types

**Core changes (minimal):**
- `packages/pi-ai/src/types.ts` — Add `"ollama"` to `KnownProvider`
- `packages/pi-ai/src/env-api-keys.ts` — Add `"ollama"` key resolution (returns `"ollama"` placeholder — no real key needed)
- `src/onboarding.ts` — Add `"ollama"` to provider selection list
- `src/wizard.ts` — Add `ollama` entry (no key required)

**Model registration details:**
Each discovered model registers as:
```typescript
{
  id: "llama3.1:8b",           // from /api/tags
  name: "Llama 3.1 8B",        // humanized
  api: "openai-completions",    // uses existing provider
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,             // from capabilities table
  input: ["text"],              // from capabilities table
  contextWindow: 131072,        // from capabilities table or /api/show
  maxTokens: 16384,             // conservative default
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    maxTokensField: "max_tokens",
  },
}
```

**Behavior:**
- `gsd --list-models` shows all locally-pulled Ollama models automatically
- `/model ollama/llama3.1:8b` works without any config file
- If Ollama isn't running, extension is silent — no errors, no models listed
- `models.json` overrides still work (user config wins over auto-discovery)

### Phase 2: Native Ollama API Provider (`/api/chat`)

**What:** A dedicated streaming provider that talks Ollama's native protocol instead of the OpenAI compatibility shim.

**Extension files:**
- `ollama/ollama-provider.ts` — Native `/api/chat` streaming:
  - Registers `"ollama-chat"` API with `registerApiProvider()`
  - Implements `stream()` and `streamSimple()`:
    - Maps GSD `Context` → Ollama messages format
    - Maps GSD `Tool[]` → Ollama tool format
    - Streams NDJSON responses, maps back to `AssistantMessage` events
    - Extracts `<think>` blocks for reasoning models (deepseek-r1, qwq)
  - Ollama-specific options:
    - `keep_alive` — control model memory retention (default: "5m")
    - `num_ctx` — pass through model's context window
    - `num_predict` — max output tokens
    - Temperature, top_p, top_k
  - Response metadata:
    - `eval_count` / `eval_duration` → tokens/sec in usage stats
    - `total_duration`, `load_duration` → performance visibility
  - Vision support: converts image content to base64 for multimodal models

**Core changes:**
- `packages/pi-ai/src/types.ts` — Add `"ollama-chat"` to `KnownApi`

**Phase 1 models switch to `api: "ollama-chat"` by default.** Users can force OpenAI-compat via `models.json` override if needed.

**Why native over OpenAI-compat:**
- Full `keep_alive` / `num_ctx` control
- Better error messages (Ollama-native vs generic OpenAI)
- More reliable tool calling on Ollama's native format
- Performance metrics in response (tokens/sec)
- Foundation for model management commands

### Phase 3: Local LLM Management UX

**What:** `/ollama` slash commands and an LLM tool for model management.

**Extension files:**
- `ollama/ollama-commands.ts` — Slash commands registered via `pi.registerCommand()`:
  - `/ollama` — Status overview:
    ```
    Ollama v0.5.7 — running (localhost:11434)

    Loaded:
      llama3.1:8b       4.7 GB VRAM   idle 3m

    Available:
      llama3.1:8b       (4.7 GB)
      qwen2.5-coder:7b  (4.4 GB)
      deepseek-r1:8b    (4.9 GB)
    ```
  - `/ollama pull <model>` — Pull with streaming progress via `ctx.ui.setWidget()`
  - `/ollama list` — List all local models with sizes and families
  - `/ollama remove <model>` — Delete a model (with confirmation)
  - `/ollama ps` — Running models + VRAM usage
- `ollama/ollama-tool.ts` — LLM-callable tool registered via `pi.registerTool()`:
  - `ollama_manage` tool — lets the agent pull/list/check models
  - Parameters: `{ action: "list" | "pull" | "status" | "ps", model?: string }`
  - Use case: agent detects it needs a model, pulls it automatically

**UX Flow:**
```
$ gsd
> /ollama
Ollama v0.5.7 — running (localhost:11434)
Loaded:
  llama3.1:8b    — 4.7 GB VRAM, idle 3m
Available:
  llama3.1:8b    (4.7 GB)
  qwen2.5-coder:7b (4.4 GB)
  deepseek-r1:8b (4.9 GB)

> /ollama pull codestral:22b
Pulling codestral:22b...
████████████████████████████░░░░ 78% (14.2 GB / 18.1 GB)
✓ codestral:22b ready

> /model ollama/codestral:22b
Switched to codestral:22b (local, Ollama)
```

## Implementation Order

1. **Phase 1** — Auto-discovery with OpenAI-compat routing. Biggest user impact, smallest risk.
2. **Phase 3** — Management UX (`/ollama` commands). Valuable even before native API.
3. **Phase 2** — Native `/api/chat` provider. Optimization over OpenAI-compat; do last.

## Core Changes Summary (minimal)

| File | Change |
|------|--------|
| `packages/pi-ai/src/types.ts` | Add `"ollama"` to `KnownProvider`, `"ollama-chat"` to `KnownApi` (Phase 2) |
| `packages/pi-ai/src/env-api-keys.ts` | Add `"ollama"` → always returns `"ollama"` placeholder |
| `src/onboarding.ts` | Add `"ollama"` to provider picker |
| `src/wizard.ts` | Add `"ollama"` key mapping (no key required) |

Everything else lives in `src/resources/extensions/ollama/`.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Ollama not running — startup probe latency | 1.5s timeout; cache result; probe async so it doesn't block TUI paint |
| Model capabilities unknown | Known-model table + `/api/show` fallback + parameter_size estimation |
| Tool calling unreliable on small models | Detect param count; warn on <7B models |
| Ollama API changes between versions | Version detect via `/api/version`; stable endpoints only |
| Conflicts with `models.json` Ollama config | User config always wins; auto-discovered models merge beneath manual config |
| Extension disabled — no impact on core | Extension is additive; disabling removes all Ollama features cleanly |

## Testing Strategy

- Unit tests: `ollama-client.ts` with mocked fetch responses
- Unit tests: `ollama-discovery.ts` model capability parsing
- Unit tests: `ollama-provider.ts` message format mapping + NDJSON stream parsing
- Unit tests: `model-capabilities.ts` known model lookups
- Integration test: mock HTTP server simulating Ollama `/api/tags`, `/api/chat`, `/api/pull`
- Manual test: real Ollama instance with llama3.1, qwen2.5-coder, deepseek-r1

## Open Questions

1. **Startup probe** — Probe Ollama on `session_start` (adds ~1.5s if not running) or lazy on first `/model`? **Recommendation: async probe on session_start (non-blocking), eager if `OLLAMA_HOST` is set.**
2. **Auto-start** — Try to launch Ollama if installed but not running? **Recommendation: no — too invasive. Show helpful message in `/ollama` status.**
3. **Vision support** — Support multimodal models (llava, etc.) in Phase 2 native API? **Recommendation: yes, detected via capabilities table.**
4. **Model refresh** — How often to re-probe Ollama for new models? **Recommendation: on `/ollama list`, on `/model` command, and every 5 min (existing TTL).**
