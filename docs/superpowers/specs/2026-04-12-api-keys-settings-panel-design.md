# API Keys Settings Panel — Design

## Problem

GSD-2 makes it hard to add or update API keys after initial setup. Tool keys (Context7, Jina, etc.) have no UI at all — the only way is via `/gsd keys add` in the CLI. LLM provider keys can only be set during onboarding.

## Solution

Add a new **API Keys** panel in the Settings UI, accessible anytime from the workspace settings tab. Users can view, add, update, and remove any provider's API key.

## Scope

- **In scope**: All providers in `PROVIDER_REGISTRY` — LLM, Search, Tool, Remote
- **Out of scope**: OAuth flows (those require browser redirect), preferences editing, budget/cost panels

## Design

### New Panel: `ApiKeysPanel`

Location: `web/components/gsd/settings-panels.tsx`

Tab label: "API Keys" | icon: `KeyRound` from lucide-react

### Provider Data

Grouped by `ProviderCategory`:
1. **LLM Providers** — Anthropic, OpenAI, Google, Groq, xAI, Mistral, OpenRouter, Cerebras, Ollama Cloud
2. **Search Providers** — Tavily, Brave Search
3. **Tool Keys** — Context7, Jina AI
4. **Remote Integrations** — Discord, Slack, Telegram

Each group has a section header with category label.

### Per-Provider Row

```
[✓/✗] Provider Name        [sk-an***xyz4]   [Update] [Remove]
```

- **Status icon**: checkmark (configured) or circle (not set)
- **Key display**: masked key if configured (first 4 + last 4 chars), or "Not set" in muted text
- **Update button**: always visible. Opens inline input row below.
- **Remove button**: only visible when key is configured.

### Inline Update Flow

When "Update" is clicked on a provider row:
- Input row expands below that provider
- Text input for API key (password type, toggleable visibility)
- "Save" and "Cancel" buttons
- For LLM providers with validation (Anthropic, OpenAI, Google, Groq, xAI, Mistral, OpenRouter): validate via API before saving
- For Context7, Jina, Brave, Discord, Slack, Telegram: save directly, no validation
- Success: inline row collapses, key display updates to masked value
- Error: red error message below input

### Backend API

**Endpoint**: `PATCH /api/keys`
**Request body**: `{ providerId: string, apiKey: string }`
**Response**: `{ ok: true, masked: string }` or `{ ok: false, error: string }`

**Endpoint**: `DELETE /api/keys`
**Request body**: `{ providerId: string }`
**Response**: `{ ok: true }`

**Implementation**: New handlers in the Express server, similar to `remote-questions.ts` pattern. Uses `AuthStorage` from `@gsd/pi-coding-agent` to save/remove keys.

### Provider Registration

Read from `PROVIDER_REGISTRY` in `key-manager.ts`. The registry already has all providers with their `id`, `label`, `envVar`, and category. The frontend should use the same registry to stay in sync.

### Validation

LLM providers with testable endpoints use existing `defaultValidateApiKey` logic from `onboarding-service.ts`. Move or export a shared validation function.

Tool keys (Context7, Jina) have no validation — save directly. User is responsible for key correctness.

### Data Flow

```
User clicks Update → inline input opens
User enters key → clicks Save
  → (validate for LLM) → API call to /api/keys (PATCH)
  → (save for tools) → API call to /api/keys (PATCH)
  → AuthStorage.set(providerId, { type: "api_key", key })
  → Response → update UI with masked key
```

## Files Changed

1. `web/components/gsd/settings-panels.tsx` — add `ApiKeysPanel` component
2. `src/web/` — add `api-keys-handler.ts` (or similar) with `PATCH` and `DELETE` handlers
3. Server routing — register new endpoint (find existing route registration pattern)

## Acceptance Criteria

- [ ] All providers in PROVIDER_REGISTRY appear in the panel grouped by category
- [ ] Configured keys show masked (first 4 + last 4 chars)
- [ ] "Update" opens inline input with Save/Cancel
- [ ] LLM keys are validated before saving (fail with error message on invalid)
- [ ] Tool keys save directly without validation
- [ ] "Remove" deletes the key and updates UI
- [ ] Panel accessible from Settings tabs at any time
- [ ] No existing settings panels are broken
