# ADR-005: Provider Capability Registry — Implementation Plan

**Branch:** `feat/provider-capability-registry`
**Base:** `origin/main`
**ADR:** `revised_adr_005.md`
**Research:** `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md`

---

## Overview

Implement a provider capability registry and tool compatibility layer that integrates with the existing ADR-004 capability-aware model router. This enables tool-aware model selection, provider-aware tool filtering, and explicit cross-provider conversation handling.

## Phased Implementation

### Phase 1: Provider Capability Registry (Zero Dependencies)

**Goal:** Create the declarative registry in `packages/pi-ai/src/providers/capabilities.ts`

**Files:**
- **NEW:** `packages/pi-ai/src/providers/capabilities.ts`
- **NEW:** `packages/pi-ai/src/providers/capabilities.test.ts`

**Tasks:**
1. Define `ProviderCapabilities` interface matching ADR-005 spec
2. Define `PROVIDER_CAPABILITIES` record for all 5 canonical APIs:
   - `anthropic-messages`
   - `openai-responses`
   - `google-generative-ai`
   - `mistral-conversations`
   - `bedrock-converse-stream`
3. Add API variant aliasing for the 6 additional registered APIs:
   - `anthropic-vertex` → `anthropic-messages`
   - `google-vertex` → `google-generative-ai`
   - `google-gemini-cli` → `google-generative-ai`
   - `azure-openai-responses` → `openai-responses`
   - `openai-codex-responses` → `openai-responses`
   - `openai-completions` → `openai-responses`
4. Export `getProviderCapabilities(api: string): ProviderCapabilities` with permissive default for unknown APIs
5. Export `PERMISSIVE_CAPABILITIES` constant (fail-open default)
6. Write tests:
   - Known API returns correct profile
   - Variant API returns parent profile (e.g., `anthropic-vertex` → anthropic caps)
   - Unknown API returns permissive default
   - Bare provider name (e.g., `"anthropic"`) returns permissive default (NOT the Anthropic profile) — **Pitfall 1 prevention**

**Key pitfall to address:** Registry MUST be keyed on `.api` (e.g., `"anthropic-messages"`), not `.provider` (e.g., `"anthropic"`). The test for bare provider names is the critical safety net.

---

### Phase 2: ToolCompatibility Metadata on ToolDefinition

**Goal:** Extend `ToolDefinition` with optional compatibility metadata

**Files:**
- **MODIFY:** `packages/pi-coding-agent/src/core/extensions/types.ts`

**Tasks:**
1. Add `ToolCompatibility` interface:
   ```typescript
   interface ToolCompatibility {
     producesImages?: boolean;
     schemaFeatures?: string[];
     minCapabilityTier?: "light" | "standard" | "heavy";
   }
   ```
2. Add to `ToolDefinition`:
   - `compatibility?: ToolCompatibility`
   - `priority?: number` (1-10, higher = keep during pruning)
3. Both fields are optional — no existing tool registrations break

**Note:** Built-in tools (bash, read, write, edit) do NOT need explicit annotations — tools without `compatibility` metadata are universally compatible. No changes to `dynamic-tools.ts` needed in this phase. **Pitfall 6 prevention:** The "no metadata = always compatible" invariant is preserved by NOT annotating universal tools.

---

### Phase 3: Tool-Compatibility Filter in model-router.ts

**Goal:** Add Step 2 hard filter between tier filtering and capability scoring

**Files:**
- **MODIFY:** `src/resources/extensions/gsd/model-router.ts`
- **MODIFY:** `src/resources/extensions/gsd/auto-model-selection.ts` (pass required tools)
- **NEW:** `src/resources/extensions/gsd/tests/tool-compatibility-filter.test.ts`

**Tasks:**
1. Add `getRequiredTools(unitType: string): string[]` mapping in model-router.ts
   - Maps unit types to the tool names they require (derived from `UNIT_TYPE_TIERS` in complexity-classifier.ts)
   - `execute-task` → `["Bash", "Read", "Write", "Edit"]`
   - `research-milestone`, `research-slice` → `["Read"]`
   - Other unit types → `[]` (no tool requirements = no filtering)

2. Add `filterModelsByToolCompatibility()` helper:
   ```typescript
   function filterModelsByToolCompatibility(
     eligibleModels: string[],
     requiredToolNames: string[],
     registeredTools: ToolInfo[],
     availableModels: Model[]
   ): string[]
   ```
   - For each eligible model, resolve its API → get provider capabilities
   - Check each required tool's `compatibility` against provider capabilities
   - Tools without `compatibility` → always pass (fail-open)
   - Models whose provider fails any tool check → removed from eligible set
   - If filter removes ALL models → return original set (fail-open at the set level too)

3. Insert filter call in `resolveModelForComplexity()` AFTER tier eligibility, BEFORE capability scoring (**Pitfall 3 prevention**)

4. Wire: `selectAndApplyModel()` passes `registeredTools` from `pi.getAllTools()` through to `resolveModelForComplexity()`

5. Tests:
   - Model filtered when provider lacks `imageToolResults` and required tool has `producesImages: true`
   - Model passes when tool has no `compatibility` metadata (**Pitfall 6 test — write this FIRST**)
   - Unknown provider passes (permissive default)
   - All-models-filtered fallback returns original set
   - Filter runs before scoring (verified via model selection outcome)

**Key pitfall to address:** Filter position is load-bearing — must be BEFORE `findModelForTier()`, not after. The test must verify a tool-incompatible model is never returned even if it scores highest on capabilities.

---

### Phase 4: adjustToolSet + Save/Restore in auto-model-selection.ts

**Goal:** Scope tool set changes to individual dispatch turns

**Files:**
- **MODIFY:** `src/resources/extensions/gsd/auto-model-selection.ts`
- **NEW:** `src/resources/extensions/gsd/tests/adjust-tool-set.test.ts`

**Tasks:**
1. Add `adjustToolSet()` pure function:
   ```typescript
   function adjustToolSet(
     model: { id: string; api: string },
     registeredTools: ToolInfo[],
     providerCaps: ProviderCapabilities
   ): string[]
   ```
   - Filter out tools whose `compatibility` conflicts with provider caps
   - Prune lowest-priority tools if exceeding `maxTools`
   - Return filtered tool name list

2. Wire into `selectAndApplyModel()`:
   - After `pi.setModel()`, save current tools: `const priorTools = pi.getActiveTools()`
   - Compute adjusted set via `adjustToolSet()`
   - Call `pi.setActiveTools(adjusted)`
   - Return `priorTools` in `ModelSelectionResult` so caller can restore after dispatch

3. Update `ModelSelectionResult` interface:
   ```typescript
   interface ModelSelectionResult {
     routing: { tier: string; modelDowngraded: boolean } | null;
     priorTools?: string[];  // Caller must restore after dispatch in a finally block
   }
   ```

4. Tests for `adjustToolSet` in isolation (pure function):
   - Tool without compatibility → included
   - Tool with `producesImages: true` on provider without `imageToolResults` → excluded
   - Tool with `schemaFeatures` matching `unsupportedSchemaFeatures` → excluded
   - `maxTools` pruning by priority
   - Empty tools → empty result

**Key pitfall to address:** Session drift (**Pitfall 2**). The caller MUST restore tools in a `finally` block. Document this contract clearly in the return type JSDoc.

---

### Phase 5: ProviderSwitchReport in transform-messages.ts

**Goal:** Make cross-provider context loss visible and trackable

**Files:**
- **MODIFY:** `packages/pi-ai/src/providers/transform-messages.ts`
- **MODIFY:** `src/resources/extensions/gsd/routing-history.ts`
- **NEW:** `packages/pi-ai/src/providers/transform-messages.test.ts` (or extend existing)

**Tasks:**
1. Define `ProviderSwitchReport` interface:
   ```typescript
   interface ProviderSwitchReport {
     fromApi: string;
     toApi: string;
     thinkingBlocksDropped: number;
     thinkingBlocksDowngraded: number;
     toolCallIdsRemapped: number;
     syntheticToolResultsInserted: number;
     thoughtSignaturesDropped: number;
   }
   ```

2. Modify `transformMessages()` return type:
   - Return `{ messages: Message[]; switchReport?: ProviderSwitchReport }`
   - Only compute report when `fromApi !== toApi` (**Pitfall 7 prevention** — early exit for same-provider)
   - Count each transformation type during existing passes (no new traversals)

3. Update all callers of `transformMessages()` in pi-ai to handle new return shape
   - Callers that don't need the report destructure only `messages`

4. Add `switchReport?: ProviderSwitchReport` to routing history entry type
5. Update `recordOutcome()` to accept and store the report

6. Tests:
   - Cross-provider transform produces report with correct counts
   - Same-provider transform produces no report (undefined)
   - Report stored in routing history when present

---

### Phase 6: models.json Override Parsing (Optional / Deferred)

**Goal:** User-facing escape hatch for provider capability overrides

**Deferred to a follow-up PR.** Core functionality works without it. The registry and filter are the priority.

---

## Build Order & Dependencies

```
Phase 1 (capabilities.ts)       ← no dependencies, build first
    ↓
Phase 2 (ToolCompatibility)     ← no dependencies on Phase 1, can parallel
    ↓
Phase 3 (filter in router)      ← depends on Phase 1 + Phase 2
    ↓
Phase 4 (adjustToolSet)         ← depends on Phase 1 + Phase 2
    ↓
Phase 5 (ProviderSwitchReport)  ← independent of Phase 3-4, can parallel
```

**Parallel opportunities:**
- Phase 1 and Phase 2 can be built in parallel (no dependency)
- Phase 3 and Phase 4 are sequential (Phase 3 first for stability)
- Phase 5 is independent and can be built alongside Phase 3-4

## Testing Strategy

- All tests use `node:test` and `node:assert/strict` per CONTRIBUTING.md
- No Jest, Vitest, or `createTestContext()`
- Cleanup via `beforeEach`/`afterEach` or `t.after()`
- Fixture data via array join (no template literal indentation issues)
- Each phase has its own test file
- Phase 3 tests are the most critical — they verify the filter position invariant

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| API name vs provider ID mismatch | Phase 1 test: bare provider name → permissive default |
| Tool filter fails-closed on missing metadata | Phase 3 test #1: tool without compatibility → passes filter |
| Session drift from missing tool restore | Phase 4: return `priorTools` in result; document restore contract |
| Filter after scoring (wrong position) | Phase 3 test: incompatible model never selected regardless of score |
| ProviderSwitchReport hot-path overhead | Phase 5: early exit when `fromApi === toApi` |
| transform-messages.ts return type break | Phase 5: update all callers; destructure pattern is backwards-compatible |

## Copyright

All new files include:
```
// GSD-2 — [File Purpose]
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
```
