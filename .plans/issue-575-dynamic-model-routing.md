# Plan: Dynamic Model Routing for Token Optimization

**Issue:** #575 — Token Consumption Optimization through Dynamic Model Selection
**Status:** Draft
**Date:** 2025-03-15

## Problem Statement

Users on capped plans (e.g., Claude Pro) exhaust weekly token limits in 15-20 hours of GSD usage. Currently, GSD uses a single model per phase (research/planning/execution/completion), configured statically in preferences. Simple tasks consume the same tokens as complex ones.

## Current Architecture

### What Exists
- **Phase-based model config:** Users can set different models per phase via `PREFERENCES.md` (research, planning, execution, completion)
- **Fallback chains:** Each phase supports `fallbacks: [model1, model2]` for error recovery
- **Pre-dispatch hooks:** `PreDispatchResult` has a `model` field but it's **never applied** in `auto.ts` — this is a ready-made extension point
- **Model registry:** `ModelRegistry.getAvailable()` provides all configured models with metadata
- **Per-unit metrics:** Token counts (input/output/cacheRead/cacheWrite), cost, and model tracked per unit
- **Budget enforcement:** Real-time cost tracking with alerts at 75%/90%/100%

### Key Files
| File | Role |
|------|------|
| `src/resources/extensions/gsd/auto.ts` | Dispatch logic, model switching (lines 1791-1879) |
| `src/resources/extensions/gsd/preferences.ts` | Model resolution, `resolveModelWithFallbacksForUnit()` |
| `src/resources/extensions/gsd/post-unit-hooks.ts` | Pre-dispatch hooks (model field defined but unused) |
| `src/resources/extensions/gsd/types.ts` | Type definitions for hooks and model config |
| `src/resources/extensions/gsd/metrics.ts` | Token tracking, aggregation, cost projection |
| `src/resources/extensions/gsd/auto-prompts.ts` | Prompt builders per unit type |
| `packages/pi-coding-agent/src/core/model-registry.ts` | Model availability and metadata |

## Proposed Design

### Core Concept: Task Complexity Classification

Before each unit dispatch, classify the task into a complexity tier and route to an appropriate model. This sits between preference resolution and model dispatch — it can **downgrade** but never **upgrade** beyond the user's configured model.

### Complexity Tiers

| Tier | Complexity | Example Tasks | Default Model |
|------|-----------|---------------|---------------|
| **Tier 1 — Light** | Low cognitive load, structured output | File reads, search aggregation, simple summaries, completion/summary units | Haiku / cheapest available |
| **Tier 2 — Standard** | Moderate reasoning, some creativity | Research synthesis, plan formatting, routine code generation, UAT checks | Sonnet / mid-tier |
| **Tier 3 — Heavy** | Complex reasoning, architecture, novel code | Complex execution tasks, replanning, multi-file refactors, debugging | Opus / user's configured model |

### Classification Signals

The classifier uses **heuristic signals** available before dispatch (no LLM call needed):

1. **Unit type** (strongest signal):
   - `complete-slice`, `run-uat` → Tier 1 (structured summarization)
   - `research-milestone`, `research-slice` → Tier 2 (synthesis)
   - `plan-milestone`, `plan-slice` → Tier 2-3 (depends on scope)
   - `execute-task` → Tier 2-3 (depends on task complexity)
   - `replan-slice` → Tier 3 (requires understanding of failure)

2. **Task metadata** (for execution units):
   - Lines of code estimated to change (from task plan)
   - Number of files involved
   - Dependency count
   - Whether task involves new file creation vs. modification
   - Tags/labels if present (e.g., "refactor", "test", "docs")

3. **Historical performance** (adaptive, Phase 2):
   - If a Tier 2 model failed and escalated on similar tasks before, default to Tier 3
   - Track success rate per tier per unit-type pattern

### Architecture

```
User Preferences (phase → model)
        │
        ▼
resolveModelWithFallbacksForUnit()     ← existing
        │
        ▼
classifyUnitComplexity()               ← NEW: returns Tier 1/2/3
        │
        ▼
resolveModelForTier()                  ← NEW: maps tier → model from available set
        │
        ▼
maybeDowngradeModel()                  ← NEW: only downgrades from user's configured model
        │
        ▼
Model dispatch (existing auto.ts logic)
```

### Key Design Decisions

1. **Downgrade-only:** The classifier can select a cheaper model than configured, never a more expensive one. The user's preference is the ceiling.

2. **Opt-in with easy override:** New preference key `dynamic_model_routing: true|false` (default: `false`). Users who want token savings enable it explicitly.

3. **Escalation on failure:** If a lower-tier model fails (tool errors, incomplete output, exceeds retries), automatically escalate to the next tier and retry the unit.

4. **No LLM call for classification:** Uses heuristics only — adding an LLM call to save tokens would be counterproductive.

5. **Respects existing fallback chains:** Dynamic routing integrates with existing `fallbacks` — if the dynamically selected model fails, it tries the fallback chain before escalating tiers.

6. **Transparent to user:** Dashboard shows which model was selected and why (tier badge in progress widget).

## Implementation Phases

### Phase 1: Foundation — Complexity Classifier & Routing (Core)

**Goal:** Build the classification and routing system, wire it into dispatch.

#### 1a. Define types and configuration

**File:** `src/resources/extensions/gsd/types.ts`
- Add `ComplexityTier` type: `'light' | 'standard' | 'heavy'`
- Add `DynamicRoutingConfig` interface:
  ```typescript
  interface DynamicRoutingConfig {
    enabled: boolean;
    tier_models?: {
      light?: string;    // model ID for light tasks
      standard?: string; // model ID for standard tasks
      heavy?: string;    // model ID for heavy tasks (default: user's configured model)
    };
    escalate_on_failure?: boolean; // default: true
  }
  ```

**File:** `src/resources/extensions/gsd/preferences.ts`
- Add `dynamic_routing` to preference schema
- Add validation for the new config
- Add `loadDynamicRoutingConfig()` function

#### 1b. Build complexity classifier

**New file:** `src/resources/extensions/gsd/complexity-classifier.ts`
- `classifyUnitComplexity(unitType, unitId, metadata?)` → `ComplexityTier`
- Heuristic rules:
  - Unit type mapping (see Tiers table above)
  - Task plan analysis: parse task plan file for file count, estimated scope
  - Dependency analysis: tasks with 3+ dependencies → bump to heavy
- Export `getClassificationReason()` for dashboard display

#### 1c. Build model router

**New file:** `src/resources/extensions/gsd/model-router.ts`
- `resolveModelForComplexity(tier, phaseConfig, availableModels)` → `ResolvedModelConfig`
- Logic:
  1. Get user's configured model for phase (ceiling)
  2. If `tier_models` configured, use tier-specific model
  3. If not configured, use smart defaults from available models (cheapest for light, mid for standard, configured for heavy)
  4. Validate selected model is available
  5. Return with fallback chain: `[tier_model, ...configured_fallbacks, configured_primary]`

#### 1d. Wire into dispatch

**File:** `src/resources/extensions/gsd/auto.ts`
- In the model resolution block (lines 1791-1879):
  1. After `resolveModelWithFallbacksForUnit()`, call classifier
  2. If dynamic routing enabled, call router to potentially downgrade
  3. Log tier and model selection to metrics
  4. On unit failure: if using downgraded model, escalate tier and retry

#### 1e. Wire the unused pre-dispatch hook model field

**File:** `src/resources/extensions/gsd/auto.ts`
- Apply `preDispatchResult.model` when returned — this is already defined but unused
- Allows hooks to override dynamic routing decisions

#### Tests

**New file:** `src/resources/extensions/gsd/tests/complexity-classifier.test.ts`
- Test tier assignment for each unit type
- Test metadata-based adjustments (file count, dependency count)
- Test edge cases (missing metadata, unknown unit types)

**New file:** `src/resources/extensions/gsd/tests/model-router.test.ts`
- Test downgrade-only behavior (never exceeds configured model)
- Test tier-to-model mapping with various available model sets
- Test fallback chain construction
- Test when dynamic routing is disabled (passthrough)

**New file:** `src/resources/extensions/gsd/tests/dynamic-routing-integration.test.ts`
- Test full flow: unit → classify → route → dispatch
- Test escalation on failure
- Test preference loading and validation

---

### Phase 2: Observability & Dashboard

**Goal:** Make routing decisions visible to users.

#### 2a. Metrics tracking

**File:** `src/resources/extensions/gsd/metrics.ts`
- Add `tier` field to `UnitMetrics`
- Add `model_downgraded: boolean` field
- Add `escalation_count` field
- Add `aggregateByTier()` function
- Add `formatTierSavings()` — show estimated savings from downgrades

#### 2b. Dashboard integration

**File:** `src/resources/extensions/gsd/auto-dashboard.ts`
- Add tier badge to unit progress display (e.g., `[L]`, `[S]`, `[H]`)
- Add savings summary to completion stats: "Dynamic routing saved ~$X.XX (N units downgraded)"
- Color-code tier in token widget

#### Tests
- Test metrics aggregation by tier
- Test savings calculation
- Test dashboard formatting

---

### Phase 3: Adaptive Learning (Future)

**Goal:** Improve classification accuracy over time based on outcomes.

#### 3a. Outcome tracking

**File:** `src/resources/extensions/gsd/complexity-classifier.ts`
- Track success/failure per tier per unit-type pattern
- Store in `.gsd/routing-history.json` (project-level)
- Simple structure: `{ "execute-task:docs": { light: { success: 12, fail: 1 }, ... } }`

#### 3b. Adaptive thresholds

- If a tier has >20% failure rate for a pattern, auto-bump default tier
- Decay old data (rolling window of last 50 units)
- User can reset learning: `dynamic_routing_reset: true` in preferences

#### Tests
- Test learning updates on success/failure
- Test threshold bumping
- Test decay logic
- Test reset behavior

---

### Phase 4: Task Plan Introspection (Future)

**Goal:** Deeper classification using task plan content analysis.

- Parse task plan markdown for complexity signals:
  - "Create new file" vs. "modify existing"
  - Number of code blocks in plan
  - Presence of keywords: "refactor", "migration", "architecture", "test", "docs", "config"
  - Estimated lines of change (if specified)
- Weight these signals alongside unit-type heuristics

---

## Preference Configuration (User-Facing)

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
dynamic_routing:
  enabled: true
  tier_models:
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    # heavy: inherits from phase config (ceiling)
  escalate_on_failure: true
---
```

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Cheaper model produces low-quality output | Downgrade-only design; escalation on failure; user can disable |
| Classification overhead adds latency | Heuristics-only, no LLM call; <1ms classification time |
| Complex preferences confuse users | Disabled by default; works with zero config if enabled (uses smart defaults) |
| Model not available in user's provider | Validation at preference load; falls back to configured model |
| Escalation loops | Max 1 escalation per unit; after that, use configured model |

## Estimated Token Savings

Based on typical GSD session patterns:
- ~30% of units are completion/summary (Tier 1 candidates)
- ~40% are research/standard planning (Tier 2 candidates)
- ~30% are complex execution (Tier 3, no downgrade)

If Haiku is ~10x cheaper than Opus and Sonnet is ~5x cheaper:
- **Conservative estimate:** 20-30% cost reduction with dynamic routing enabled
- **Aggressive estimate:** 40-50% for projects with many small tasks

## Resolved Design Decisions

All four open questions resolved as **yes** — folded into the plan as additional scope:

### 1. Post-unit hook classification — YES
Hooks get their own complexity classification. Most hooks are lightweight (validation, file checks) and should default to Tier 1. The existing `model` field on `PostUnitHookConfig` becomes the ceiling, same as phase models for units.

**Implementation:** Add to Phase 1d — extend `classifyUnitComplexity()` to accept hook metadata. Wire into hook dispatch at `auto.ts` lines 936-946.

### 2. Budget-pressure-aware routing — YES
As budget usage increases, the classifier becomes more aggressive about downgrading:
- **<50% budget used:** Normal classification
- **50-75% budget used:** Bump Tier 2 candidates down to Tier 1 where possible
- **75-90% budget used:** Only Tier 3 tasks get the configured model; everything else goes to cheapest available
- **>90% budget used:** Everything except `replan-slice` gets downgraded to cheapest

**Implementation:** Add to Phase 1b — `classifyUnitComplexity()` takes `budgetPct` parameter from existing `getBudgetAlertLevel()` logic. New function `applyBudgetPressure(tier, budgetPct)` adjusts the tier.

### 3. Multi-provider cost routing — YES
When multiple providers are configured, the router should consider cost differences. If a user has both Anthropic and OpenRouter, pick the cheapest option for the resolved tier.

**Implementation:**
- Add `cost_per_1k_tokens` metadata to model registry (or maintain a lookup table for known models)
- New file: `src/resources/extensions/gsd/model-cost-table.ts` — static cost table for known models, updatable via preferences
- `resolveModelForComplexity()` ranks available models by cost within a tier's capability range
- Preference key: `dynamic_routing.cross_provider: true|false` (default: true when enabled)

**Risk:** Cost data goes stale. Mitigate with a bundled cost table that gets updated with GSD releases + user override capability.

### 4. User feedback loop — YES
After each unit completes, users can flag the output quality to improve future classification.

**Implementation (Phase 3 — Adaptive Learning):**
- Post-unit prompt option: user can react with `/gsd:rate-unit [over|under|ok]`
  - `over` = "this could have used a simpler model" → records downgrade signal
  - `under` = "this needed a better model" → records upgrade signal
  - `ok` = confirms current tier was appropriate
- Feedback stored alongside outcome data in `.gsd/routing-history.json`
- Classifier weights feedback signals 2x vs. automatic success/failure detection
- Skill: `gsd:rate-unit` — simple command that tags the last completed unit

### Updated Preference Configuration

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
dynamic_routing:
  enabled: true
  tier_models:
    light: claude-haiku-4-5
    standard: claude-sonnet-4-6
    # heavy: inherits from phase config (ceiling)
  escalate_on_failure: true
  budget_pressure: true        # more aggressive downgrading as budget fills
  cross_provider: true          # consider cost across providers
  hooks: true                   # classify hooks too
---
```

### Updated Phase Summary

| Phase | Scope | Includes |
|-------|-------|----------|
| **1 — Foundation** | Classifier, router, dispatch, hook classification, budget pressure | Decisions 1 & 2 |
| **2 — Observability** | Dashboard, tier badges, savings tracking, cost table | Decision 3 |
| **3 — Adaptive Learning** | Outcome tracking, user feedback (`/gsd:rate-unit`), adaptive thresholds | Decision 4 |
| **4 — Task Introspection** | Parse task plans for deeper complexity signals | — |
