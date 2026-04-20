# ADR-007: Model Catalog Split and Provider API Encapsulation

**Status:** Proposed
**Date:** 2026-04-03
**Deciders:** Jeremy McSpadden
**Related:** ADR-004 (capability-aware model routing), [ADR-005](https://github.com/gsd-build/gsd-2/issues/2790), [ADR-006](https://github.com/gsd-build/gsd-2/issues/2995), `packages/pi-ai/src/providers/`, `packages/pi-ai/src/models.ts`

## Context

The model/provider system in `pi-ai` has two structural problems worth fixing — but the system is **not fundamentally broken**. The heavy lifting (lazy SDK imports, registry-based dispatch, extension-based registration) is already well-designed. This ADR targets the two areas where the current design creates real friction without proposing unnecessary runtime changes.

### Current Architecture

```
stream.ts
  └─ import "./providers/register-builtins.js"  ← side-effect import at load time
       ├─ import anthropic.ts            (6.8 KB)
       ├─ import anthropic-vertex.ts     (3.9 KB)
       ├─ import openai-completions.ts   (26 KB)
       ├─ import openai-responses.ts     (6.4 KB)
       ├─ import openai-codex-responses.ts (29 KB)
       ├─ import azure-openai-responses.ts (7.8 KB)
       ├─ import google.ts              (13.6 KB)
       ├─ import google-vertex.ts       (14.5 KB)
       ├─ import google-gemini-cli.ts   (30 KB)
       ├─ import mistral.ts             (18.9 KB)
       └─ amazon-bedrock.ts             (24 KB) ← only lazy-loaded provider

models.ts
  └─ import models.generated.ts   ← 13,848 lines, ALL providers, loaded at init
  └─ import models.custom.ts      ← 197 lines, additional providers
```

### What Already Works Well

1. **SDK lazy loading.** Every provider file uses `async function getXxxClass()` with a cached dynamic `import()`. The heavy npm packages (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `@aws-sdk/*`, `@mistralai/*`) are only loaded on first API call. This is where the real startup cost would be — and it's already handled.

2. **Registry-based dispatch.** `api-registry.ts` cleanly maps API types to stream functions. Callers use `stream(model, context)` and the registry routes to the right provider. This pattern is sound.

3. **Extension registration.** Ollama and Claude Code CLI register via `registerApiProvider()` at runtime. This extensibility point works correctly.

4. **Provider implementation code loading (~200KB total).** While all providers load eagerly, V8 parses local `.js` files in single-digit milliseconds each. The total parse cost for all provider files is ~10-30ms — not a user-visible bottleneck on a CLI that's about to make a multi-second API call anyway.

### What's Actually Worth Fixing

#### Problem 1: Monolithic model catalog — developer experience, not runtime

`models.generated.ts` is **13,848 lines in a single file**. This creates real friction:

- **PR reviews are painful.** When the generation script runs, the diff is a wall of changes across unrelated providers. Reviewers can't tell what actually changed for a specific provider.
- **Navigation is slow.** Finding a specific model requires scrolling or searching through thousands of lines of static object literals.
- **Merge conflicts are frequent.** Any two PRs that touch model generation will conflict on the same monolithic file.
- **Git blame is useless.** Every line was "last changed" by the generation script, obscuring the history of individual provider additions.

The runtime cost of loading all model definitions is negligible — a Map of ~200 model objects is maybe 50-100KB of heap. The problem is purely about code organization and developer workflow.

#### Problem 2: Barrel export leaks provider internals — API design

`packages/pi-ai/src/index.ts` re-exports every provider module's internals:

```typescript
export * from "./providers/anthropic.js";
export * from "./providers/google.js";
export * from "./providers/google-gemini-cli.js";
export * from "./providers/google-vertex.js";
export * from "./providers/mistral.js";
export * from "./providers/openai-completions.js";
export * from "./providers/openai-responses.js";
// ... etc
```

This is a public API problem:

- **Consumers can bypass the registry.** Any code that `import { streamAnthropic } from "pi-ai"` has a direct dependency on an implementation detail that should be internal.
- **Refactoring is blocked.** Renaming a function inside a provider file is a breaking change because it's re-exported from the package root.
- **API surface is unnecessarily large.** The public API should be `stream()`, `streamSimple()`, `registerApiProvider()`, model utilities, and types. Provider-specific stream functions are implementation details.

### What Is NOT Worth Changing

**Lazy provider loading (converting `register-builtins.ts` to async on-demand loading).** This was considered and rejected because:

1. **The SDKs are already lazy.** The heavy cost is handled. Provider implementation code (~200KB of local `.js`) parses in ~10-30ms total.
2. **Async resolution adds complexity to the hot path.** `stream.ts` currently does a synchronous `Map.get()`. Making `resolveApiProvider` async adds a microtask hop to every API call — not just the first. Small but measurable, and for no user-visible gain.
3. **High blast radius, low payoff.** Touching `stream.ts`, `api-registry.ts`, and the registration lifecycle simultaneously risks regressions in the core streaming path for an optimization that wouldn't show up in profiling.
4. **Bedrock's lazy loading is a special case, not a template.** It exists because `@aws-sdk/client-bedrock-runtime` is uniquely massive. Generalizing this pattern to providers where the SDK is already lazy-imported doesn't compound the benefit.

## Decision

**Make two targeted improvements to code organization and API hygiene. Do not change runtime loading behavior.**

### Change 1: Split `models.generated.ts` into per-provider files

Replace the monolithic 13,848-line generated file with per-provider files:

```
packages/pi-ai/src/models/
  ├── index.ts                  ← re-exports combined registry, same public API
  ├── generated/
  │   ├── anthropic.ts          ← Anthropic model definitions
  │   ├── openai.ts             ← OpenAI model definitions
  │   ├── google.ts             ← Google model definitions
  │   ├── mistral.ts            ← Mistral model definitions
  │   ├── amazon-bedrock.ts     ← Bedrock model definitions
  │   ├── groq.ts               ← Groq model definitions
  │   ├── xai.ts                ← xAI model definitions
  │   ├── cerebras.ts           ← Cerebras model definitions
  │   ├── openrouter.ts         ← OpenRouter model definitions
  │   └── ...                   ← one file per provider in the catalog
  ├── custom.ts                 ← replaces models.custom.ts (unchanged content)
  └── capability-patches.ts     ← CAPABILITY_PATCHES extracted for clarity
```

**`models/index.ts` keeps the exact same synchronous public API:**

```typescript
// models/index.ts
// GSD-2 — Model registry (split by provider for maintainability)

import { ANTHROPIC_MODELS } from "./generated/anthropic.js";
import { OPENAI_MODELS } from "./generated/openai.js";
import { GOOGLE_MODELS } from "./generated/google.js";
// ... one import per provider

import { CUSTOM_MODELS } from "./custom.js";
import { CAPABILITY_PATCHES, applyCapabilityPatches } from "./capability-patches.js";
import type { Api, KnownProvider, Model, Usage } from "../types.js";

// Combine all generated models into single registry — same as today
const MODELS = {
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...GOOGLE_MODELS,
  // ...
};

// Rest of the file is identical to current models.ts:
// modelRegistry Map construction, capability patch application,
// getModel(), getProviders(), getModels(), calculateCost(),
// supportsXhigh(), modelsAreEqual()
```

**Key constraint: loading stays synchronous and eager.** All model files are statically imported. The Map is built at module init exactly as today. No async, no lazy loading, no runtime behavior change. This is purely a file organization change.

**Update `generate-models.ts`** to emit one file per provider instead of a single `models.generated.ts`. The script already groups models by provider internally — it just needs to write separate files instead of one.

#### Why this matters

| Before | After |
|--------|-------|
| PR diffs show 13K-line file changes | PR diffs scoped to the provider that changed |
| Merge conflicts on any concurrent model update | Conflicts only when same provider is touched |
| `git blame` shows "regenerate models" for every line | `git blame` shows per-provider history |
| Finding a model = search through 13K lines | Finding a model = open the provider file |
| One reviewer must understand all providers | Reviewers only need context for affected provider |

### Change 2: Stop barrel-exporting provider internals

**Update `packages/pi-ai/src/index.ts`:**

```typescript
// Before (current — 17 re-exports including all providers):
export * from "./providers/anthropic.js";
export * from "./providers/azure-openai-responses.js";
export * from "./providers/google.js";
export * from "./providers/google-gemini-cli.js";
export * from "./providers/google-vertex.js";
export * from "./providers/mistral.js";
export * from "./providers/openai-completions.js";
export * from "./providers/openai-responses.js";
export * from "./providers/register-builtins.js";
// ...

// After (clean public API):
export * from "./api-registry.js";
export * from "./env-api-keys.js";
export * from "./models/index.js";
export * from "./providers/register-builtins.js";  // resetApiProviders() is public
export * from "./stream.js";
export * from "./types.js";
export * from "./utils/event-stream.js";
export * from "./utils/json-parse.js";
export type { OAuthAuthInfo, OAuthCredentials, /* ... */ } from "./utils/oauth/types.js";
export * from "./utils/overflow.js";
export * from "./utils/typebox-helpers.js";
export * from "./utils/repair-tool-json.js";
export * from "./utils/validation.js";
```

Provider-specific exports (`streamAnthropic`, `streamGoogle`, etc.) are removed from the public API. Any external consumer that imported them directly should use the registry-based `stream()` / `streamSimple()` functions instead — which is how all internal callers already work.

#### Why this matters

- **Enforces the registry pattern.** The correct way to call a provider is `stream(model, context)`. Direct provider function imports create fragile coupling.
- **Enables future refactoring.** Provider internal function signatures can change without breaking the package API. Today, renaming `streamAnthropic` would be a semver-breaking change.
- **Reduces API surface.** Consumers see only what they need: `stream`, `streamSimple`, `registerApiProvider`, model utilities, and types.

### What Does NOT Change

- **Runtime behavior** — all providers still load eagerly, same as today
- **The `Model<TApi>` type system** — all types, interfaces, and generics stay the same
- **The `ApiProvider` interface** — providers still implement `{ api, stream, streamSimple }`
- **The `api-registry.ts` registry** — synchronous `Map.get()` dispatch, unchanged
- **`stream.ts`** — no changes to the streaming entry point
- **`register-builtins.ts`** — still eagerly imports and registers all providers (only `resetApiProviders` remains in barrel export)
- **The extension system** — `registerApiProvider()` continues to work for Ollama, Claude Code CLI, etc.
- **`models.json` user config** — custom models, overrides, provider settings are unaffected
- **Model discovery** — discovery adapters are already lazy and independent
- **Model routing** — ADR-004's capability-aware routing is orthogonal

## Consequences

### Positive

1. **Cleaner PRs.** Model catalog changes are scoped to the provider that changed. Reviewers see a 200-line diff in `models/generated/openai.ts` instead of a 13K-line diff in `models.generated.ts`.

2. **Fewer merge conflicts.** Two PRs that update different providers no longer conflict on the same file.

3. **Better navigability.** Developers can jump directly to `models/generated/anthropic.ts` to see Anthropic's model definitions instead of searching through a monolith.

4. **Cleaner package API.** `pi-ai` exports only what consumers need. Provider internals are properly encapsulated.

5. **Future-proofs refactoring.** Provider implementation details can evolve without breaking the public API contract.

6. **Zero runtime risk.** No changes to loading, registration, streaming, or dispatch. The refactor is purely structural.

### Negative

1. **More files.** Instead of 1 generated file + 1 custom file, we'll have ~15-20 generated files. Marginal complexity increase, but each file is focused and small.

2. **Generation script update.** `generate-models.ts` needs to write per-provider files. The script already groups by provider, so this is straightforward but requires testing.

3. **Import audit for barrel export change.** Any code that directly imports `streamAnthropic` (etc.) from `pi-ai` needs to be updated. Based on research, the main consumer is `register-builtins.ts` itself, which imports providers directly (not through the barrel). External usage should be minimal.

## Alternatives Considered

### 1. Full lazy provider loading (original ADR-005 proposal)

Make all providers load on-demand via async dynamic imports, generalizing the Bedrock pattern. **Rejected** because:
- SDK imports are already lazy — the heavy cost is handled
- Provider implementation parsing is ~10-30ms total — not a bottleneck
- Adds async complexity to the synchronous stream dispatch hot path
- High migration effort and regression risk for unmeasurable performance gain

### 2. Plugin architecture with separate npm packages

Move each provider to its own package (`@gsd/provider-anthropic`, etc.). Maximum isolation but dramatically more complex build/release/versioning. Overkill for a monorepo where all providers ship together.

### 3. Do nothing

The current architecture works. This is a valid choice. The split is justified by the developer experience friction (13K-line file, merge conflicts, unusable git blame) and the API hygiene issue (leaking provider internals), not by a runtime problem. If the team is not experiencing these friction points, deferring is reasonable.

## Implementation Plan

### Wave 1: Split Model Catalog (Low-Medium Risk)
1. Update `generate-models.ts` to emit per-provider files into `models/generated/`
2. Create `models/index.ts` that imports all per-provider files and builds the same registry
3. Extract `CAPABILITY_PATCHES` into `models/capability-patches.ts`
4. Move `models.custom.ts` to `models/custom.ts`
5. Update imports in `models.ts` (or replace it with the new `models/index.ts`)
6. Verify `npm run build` and `npm run test` pass
7. Delete `models.generated.ts` and `models.custom.ts`

### Wave 2: Clean Up Barrel Export (Low Risk)
1. Remove provider re-exports from `index.ts`
2. Grep for direct provider imports from `"pi-ai"` across the codebase
3. Migrate any found usages to use `stream()` / `streamSimple()` through the registry
4. Verify build and tests

### Wave 3: Validate
1. Run full test suite
2. Verify extension registration (Ollama, Claude Code CLI) still works
3. Verify `resetApiProviders()` test helper still works
4. Spot-check a few providers end-to-end

## References

- Current model catalog: `packages/pi-ai/src/models.generated.ts` (13,848 lines)
- Current barrel export: `packages/pi-ai/src/index.ts`
- Model registry: `packages/pi-ai/src/models.ts`
- API provider registry: `packages/pi-ai/src/api-registry.ts`
- Eager registration: `packages/pi-ai/src/providers/register-builtins.ts`
- Stream dispatch: `packages/pi-ai/src/stream.ts`
- Generation script: `packages/pi-ai/scripts/generate-models.ts`
- Extension registration: `packages/pi-coding-agent/src/core/model-registry.ts`
- ADR-004: `docs/ADR-004-capability-aware-model-routing.md`
