# ADR-012: Provider Identity vs. API Shape

**Status:** Accepted
**Date:** 2026-04-19
**Author:** Jeremy (@jeremymcs)
**Related:** ADR-005 (multi-model provider tool strategy), Issue #4478, Issue #4384
**Prior art:** PR #2235 (doctor-side Brave warning fix — did not touch native-search)

## Context

A GSD model is described by two independent fields:

- **`provider`** — a transport / credential identifier. Examples: `anthropic`, `claude-code`, `anthropic-vertex`, `amazon-bedrock`, `vercel-ai-gateway`, `openai`, `azure`, `openrouter`, `groq`, `github-copilot`, `google`, `google-vertex`, `google-gemini-cli`.
- **`api`** — the wire protocol the request is serialized as. Registered today in `packages/pi-ai/src/providers/register-builtins.ts`: `anthropic-messages`, `anthropic-vertex`, `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `bedrock-converse-stream`, `mistral-conversations`.

These are **not the same thing**. Many providers serve genuine Anthropic/OpenAI/Google models over the vendor's own wire protocol: Claude Code OAuth and Anthropic-on-Vertex both speak the Anthropic Messages shape; Vercel AI Gateway fronts multiple wire protocols; Azure/Codex/OpenRouter all speak OpenAI-shaped protocols; Gemini on Vertex speaks Gemini-shaped protocols.

### Observed failure (#4478)

`src/resources/extensions/search-the-web/native-search.ts` gated Anthropic-native web-search behavior on `model.provider === "anthropic"`. Claude Pro/Max subscribers authenticated via Claude Code OAuth (provider `claude-code`, api `anthropic-messages`) therefore:

1. Got the "Set `BRAVE_API_KEY` or use an Anthropic model" warning spammed on every `model_select` event.
2. Did **not** receive native `web_search_20250305` tool injection.
3. Had no functional web search unless they paid for a Brave API key that GSD did not actually need.

The same class of bug would bite OpenAI-Responses features gated on `provider === "openai"` (missing Azure, Codex, Copilot, OpenRouter) and Gemini features gated on `provider === "google"` (missing Vertex, Gemini CLI).

## Decision

**Gate API-shape-dependent behavior on `model.api`, not `model.provider`.**

API-shape-dependent behavior includes anything that assumes a specific wire protocol, tool-schema shape, streaming event format, message-array schema, or provider-native tool identifier (`web_search_20250305`, `web_search_preview`, `google_search`, etc.).

Use the shared predicates in `packages/pi-ai/src/providers/api-family.ts`:

- `isAnthropicApi(model)` — `anthropic-messages` | `anthropic-vertex`
- `isOpenAIApi(model)` — `openai-completions` | `openai-responses` | `azure-openai-responses` | `openai-codex-responses`
- `isGeminiApi(model)` — `google-generative-ai` | `google-gemini-cli` | `google-vertex`
- `isBedrockApi(model)` — `bedrock-converse-stream`

The helpers are re-exported from `@gsd/pi-ai` for use across the monorepo.

### When `provider` comparison is still correct

A small set of call sites legitimately keys on `provider`. These are **not** gated on API shape:

- **Per-transport credential resolution** (`env-api-keys.ts`, `web-runtime-env-api-keys.ts`). Each provider has its own env var.
- **Per-transport doctor checks** (`doctor-providers.ts`). Each transport verifies different things (OAuth vs key vs ADC).
- **Fallback-source targeting** (`retry-handler.ts` — "only fall back *from* plain `anthropic` *to* `claude-code`"). The rule is transport-specific by design.
- **Model-registry canonical-provider tiebreakers** (`auto-model-selection.ts`). Same canonical model may appear under multiple transports; plain `anthropic` is the tiebreaker.
- **Display labels / onboarding copy** (`onboarding.ts`). Surface-only, no behavior impact.

These sites are enumerated in the allowlist at `src/tests/provider-equality-allowlist.test.ts`.

### Guardrail

`src/tests/provider-equality-allowlist.test.ts` greps the tree for `model.provider === "<known-transport>"` and asserts every hit is in an explicit file allowlist. A new provider-equality check fails CI unless the author (a) uses an `isXxxApi` helper instead, or (b) adds the site to the allowlist with rationale.

## Consequences

### Positive

- Fixes #4478 and every symmetric instance before it lands.
- Claude Pro/Max users on Claude Code OAuth get functional native web search with no keys.
- Anthropic-on-Vertex and Vercel-AI-Gateway Anthropic routes also gain native web search for free.
- Adding a new Anthropic-fronting transport (e.g. a future Bedrock Messages route) requires zero changes to API-shape-gated code — only registering the new `api` value if it differs.

### Caveats

- **Vertex-side tool support.** `isAnthropicApi` includes `anthropic-vertex`. Whether Google Cloud has enabled `web_search_20250305` on its Anthropic-on-Vertex surface is an external dependency. The SDK is transparent; if Vertex rejects the tool type at the API layer, we'll surface a 400 rather than silent degradation. Users can opt out via `PREFER_BRAVE_SEARCH=1` or `search_provider: brave` in PREFERENCES.md.
- **Bedrock excluded.** Bedrock Converse uses a different tool schema. Native web search on Bedrock is a separate effort, not in this ADR's scope.

### Follow-ups

- Issue #4384 (flat-rate provider classification) has the same root class; it can adopt `isAnthropicApi` / `isOpenAIApi` when it lands.
- If `provider` is reused in a hot path where the helper's lookup cost matters, memoize per `Model` instance — but current use is in event handlers where the cost is irrelevant.
