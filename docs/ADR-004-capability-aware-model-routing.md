# ADR-004: Capability-Aware Model Routing

**Status:** Implemented (Phase 2)
**Date:** 2026-03-26
**Revised:** 2026-04-03
**Deciders:** Jeremy McSpadden
**Related:** ADR-003 (pipeline simplification), [Issue #2655](https://github.com/gsd-build/gsd-2/issues/2655), `docs/dynamic-model-routing.md`

## Context

GSD already supports dynamic model routing in auto-mode, but the current router is fundamentally **complexity-tier and cost based**, not **task-capability based**.

Today the selection pipeline is:

```
unit dispatch
  → classifyUnitComplexity(unitType, unitId, basePath, budgetPct)
      → UNIT_TYPE_TIERS default mapping
      → analyzeTaskComplexity() / analyzePlanComplexity()  [metadata heuristics]
      → getAdaptiveTierAdjustment()                        [routing history]
      → applyBudgetPressure()                              [budget ceiling]
  → resolveModelForComplexity(classification, phaseConfig, routingConfig, availableModelIds)
      → downgrade-only: never upgrades beyond user's configured model
      → MODEL_CAPABILITY_TIER lookup → cheapest available in tier
      → fallback chain assembly
  → resolveModelId() → pi.setModel()
  → before_provider_request hook (payload mutation only)
```

This architecture works when all models inside a tier are effectively interchangeable. That assumption no longer holds.

Users increasingly configure heterogeneous provider pools through `models.json`, scoped provider setup, and `/scoped-models`. In practice:

- Claude-class models often perform best on greenfield implementation and architecture work
- Codex-class models often perform best on debugging, refactoring, and root-cause analysis
- Gemini-class models often perform best on long-context synthesis and research-heavy tasks
- Fast small models are often best for cheap validation, triage, and lightweight hooks

The current router cannot express those differences. If Claude and Codex are both available at the same tier, GSD either:

- treats them as equivalent and picks the cheaper one, or
- requires the user to hardcode specific phase models manually

That produces three structural problems:

### 1. Wrong optimization target

The router optimizes primarily for **task difficulty vs model cost**. The real problem is **task requirements vs model strengths**, subject to cost constraints.

### 2. Poor behavior with heterogeneous pools

Different users have different subscriptions and provider access. A fixed mapping like "research always uses Gemini" does not generalize when the user only has Claude + Codex, or only local models.

### 3. Capability knowledge is trapped in user intuition

Experienced users know which models are better at coding, debugging, research, long-context work, or instruction following. GSD has no representation for that knowledge, so it cannot route intelligently on the user's behalf.

The system already has several building blocks that make a richer router feasible:

- unit types already encode the kind of work being dispatched
- `complexity-classifier.ts` already extracts rich `TaskMetadata` (file counts, dependency counts, tags, complexity keywords, code block counts)
- `auto-dispatch.ts` and prompt builders provide stable task categories
- `ctx.modelRegistry.getAvailable()` exposes the current model pool
- `models.json` already supports user overrides and cost data per model
- budget ceilings, routing history, and retry escalation already exist
- the `model_select` hook fires on model changes and could be extended for pre-selection interception

## Decision

**Extend dynamic routing from a one-dimensional tier system to a two-dimensional system that combines complexity classification ("how hard") with capability scoring ("what kind"), while preserving downgrade-only semantics, budget controls, and user overrideability.**

### Design Principles

1. **Downgrade-only invariant is preserved.** The user's configured model for a phase is always the ceiling. Capability scoring ranks models within the eligible set — it never promotes above the user's configured model.

2. **Complexity classification remains.** The existing `classifyUnitComplexity()` pipeline (unit type defaults, task plan analysis, adaptive learning, budget pressure) continues to determine tier eligibility. Capability scoring selects among tier-eligible models.

3. **Cost is a constraint, not a score dimension.** Budget pressure constrains which models are eligible. Capability profiles describe what models are good at, not what they cost.

4. **Requirement vectors are dynamic, not static.** Task requirements are computed from `(unitType, TaskMetadata)`, not from unit type alone.

### The Revised Routing Pipeline

```
unit dispatch
  → classifyUnitComplexity(unitType, unitId, basePath, budgetPct)
      [unchanged — determines tier eligibility and budget filtering]
  → resolveModelForComplexity(classification, phaseConfig, routingConfig, availableModelIds)
      → STEP 1: filter to tier-eligible models (downgrade-only from user ceiling)
      → STEP 2: if capability routing enabled AND >1 eligible model:
          → computeTaskRequirements(unitType, taskMetadata)
          → scoreEligibleModels(eligible, taskRequirements)
          → select highest-scoring model (deterministic tie-break by cost, then ID)
      → STEP 3: assemble fallback chain
  → resolveModelId() → pi.setModel()
```

### Model Capability Profiles

Each model gains an optional capability profile:

```ts
interface ModelCapabilities {
  coding: number;       // greenfield implementation, code generation
  debugging: number;    // root-cause analysis, error diagnosis, refactoring
  research: number;     // information synthesis, investigation, exploration
  reasoning: number;    // multi-step logic, planning, architecture
  speed: number;        // response latency (inverse of thinking time)
  longContext: number;  // effective use of large input windows
  instruction: number;  // instruction following, structured output adherence
}
```

Scores are normalized `0–100`. Seven dimensions. No `costEfficiency` dimension — cost is handled separately by budget pressure and tier economics.

Models without a capability profile are treated as having uniform scores across all dimensions (score 50 in each), which makes capability scoring a no-op for those models and falls back to the existing cheapest-in-tier behavior.

### Dynamic Task Requirement Vectors

Requirement vectors are computed as a function of `(unitType, TaskMetadata)`, not looked up from a static table. This preserves the nuance that `classifyUnitComplexity` already captures.

```ts
function computeTaskRequirements(
  unitType: string,
  metadata?: TaskMetadata,
): Partial<Record<keyof ModelCapabilities, number>> {
  // Base vector from unit type
  const base = BASE_REQUIREMENTS[unitType] ?? { reasoning: 0.5 };

  // Refine based on task metadata (only for execute-task)
  if (unitType === "execute-task" && metadata) {
    // Docs/config/rename tasks → boost instruction, reduce coding
    if (metadata.tags?.some(t => /^(docs?|readme|comment|config|typo|rename)$/i.test(t))) {
      return { ...base, instruction: 0.9, coding: 0.3, speed: 0.7 };
    }
    // Debugging keywords → boost debugging and reasoning
    if (metadata.complexityKeywords?.some(k => k === "concurrency" || k === "compatibility")) {
      return { ...base, debugging: 0.9, reasoning: 0.8 };
    }
    // Migration/architecture → boost reasoning and coding
    if (metadata.complexityKeywords?.some(k => k === "migration" || k === "architecture")) {
      return { ...base, reasoning: 0.9, coding: 0.8 };
    }
    // Many files or high estimated lines → boost coding
    if ((metadata.fileCount ?? 0) >= 6 || (metadata.estimatedLines ?? 0) >= 500) {
      return { ...base, coding: 0.9, reasoning: 0.7 };
    }
  }

  return base;
}
```

Base requirement vectors by unit type:

```ts
const BASE_REQUIREMENTS: Record<string, Partial<Record<keyof ModelCapabilities, number>>> = {
  "execute-task":        { coding: 0.9, instruction: 0.7, speed: 0.3 },
  "research-milestone":  { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "research-slice":      { research: 0.9, longContext: 0.7, reasoning: 0.5 },
  "plan-milestone":      { reasoning: 0.9, coding: 0.5 },
  "plan-slice":          { reasoning: 0.9, coding: 0.5 },
  "replan-slice":        { reasoning: 0.9, debugging: 0.6, coding: 0.5 },
  "reassess-roadmap":    { reasoning: 0.9, research: 0.5 },
  "complete-slice":      { instruction: 0.8, speed: 0.7 },
  "run-uat":             { instruction: 0.7, speed: 0.8 },
  "discuss-milestone":   { reasoning: 0.6, instruction: 0.7 },
  "complete-milestone":  { instruction: 0.8, reasoning: 0.5 },
};
```

### Scoring Function

```ts
function scoreModel(
  model: ModelCapabilities,
  requirements: Partial<Record<keyof ModelCapabilities, number>>,
): number {
  let weightedSum = 0;
  let weightSum = 0;
  for (const [dim, weight] of Object.entries(requirements)) {
    const capability = model[dim as keyof ModelCapabilities] ?? 50;
    weightedSum += weight * capability;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : 50;
}
```

This produces a **weighted average** in the range `0–100`, where each dimension's contribution is proportional to its requirement weight. The output is directly comparable across models regardless of how many dimensions the requirement vector has.

**Tie-breaking:** When two models score within 2 points of each other, prefer the cheaper model (by `MODEL_COST_PER_1K_INPUT`). If cost is also equal, break ties by lexicographic model ID for determinism.

### Configuration Model

Built-in capability profiles ship as a data table alongside `MODEL_CAPABILITY_TIER` and `MODEL_COST_PER_1K_INPUT` in `model-router.ts`:

```ts
const MODEL_CAPABILITY_PROFILES: Record<string, ModelCapabilities> = {
  "claude-opus-4-6":     { coding: 95, debugging: 90, research: 85, reasoning: 95, speed: 30, longContext: 80, instruction: 90 },
  "claude-sonnet-4-6":   { coding: 85, debugging: 80, research: 75, reasoning: 80, speed: 60, longContext: 75, instruction: 85 },
  "claude-haiku-4-5":    { coding: 60, debugging: 50, research: 45, reasoning: 50, speed: 95, longContext: 50, instruction: 75 },
  "gpt-4o":              { coding: 80, debugging: 75, research: 70, reasoning: 75, speed: 65, longContext: 70, instruction: 80 },
  "gpt-4o-mini":         { coding: 55, debugging: 45, research: 40, reasoning: 45, speed: 90, longContext: 45, instruction: 70 },
  "gemini-2.5-pro":      { coding: 75, debugging: 70, research: 85, reasoning: 75, speed: 55, longContext: 90, instruction: 75 },
  "gemini-2.0-flash":    { coding: 50, debugging: 40, research: 50, reasoning: 40, speed: 95, longContext: 60, instruction: 65 },
  "deepseek-chat":       { coding: 75, debugging: 65, research: 55, reasoning: 70, speed: 70, longContext: 55, instruction: 65 },
  "o3":                  { coding: 80, debugging: 85, research: 80, reasoning: 92, speed: 25, longContext: 70, instruction: 85 },
};
```

Users can override capability profiles in `models.json` per provider:

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-sonnet-4-6": {
          "capabilities": {
            "debugging": 90,
            "research": 85
          }
        }
      }
    }
  }
}
```

Partial overrides are deep-merged with built-in defaults. This uses the same `modelOverrides` path that already supports `contextWindow`, `cost`, and `compat` overrides.

### Profile Versioning

Built-in capability profiles are maintained alongside the existing `MODEL_CAPABILITY_TIER` and `MODEL_COST_PER_1K_INPUT` tables in `model-router.ts`. When the `@gsd/pi-ai` model catalog is updated with new models, the capability profile table must be updated in the same PR. A linting rule should flag any model present in `MODEL_CAPABILITY_TIER` but missing from `MODEL_CAPABILITY_PROFILES`.

Profiles are versioned implicitly by GSD release. The existing `models.json` `modelOverrides` mechanism allows users to correct stale defaults immediately without waiting for a GSD update.

### Extension-First Rollout

Capability-aware routing should be prototypable as an extension before moving to core. The current hook surface is **insufficient** for this:

- `before_provider_request` fires after model selection, at the API payload level — too late to swap model choice.
- `model_select` fires reactively when a model changes, not before selection — it cannot influence the choice.

**Required hook addition:** A `before_model_select` hook that fires within `selectAndApplyModel()` after tier classification but before `resolveModelForComplexity()`. This hook would receive:

```ts
interface BeforeModelSelectEvent {
  unitType: string;
  unitId: string;
  classification: ClassificationResult;
  taskMetadata: TaskMetadata;
  eligibleModels: string[];     // tier-filtered available models
  phaseConfig: ResolvedModelConfig;
}
```

Return value: `{ modelId: string } | undefined` (override selection, or undefined to use default).

This hook enables an extension to implement capability scoring externally, test it against real workloads, and validate behavior before the logic moves into `model-router.ts`.

**Rollout sequence:**

1. **Phase 1:** Add `before_model_select` hook and `TaskMetadata` to `ClassificationResult`. Ship built-in capability profile data table. No core routing changes.
2. **Phase 2:** Implement capability scoring as an extension that hooks `before_model_select`. Gather user feedback through routing history.
3. **Phase 3:** If behavior proves stable, move scoring into `resolveModelForComplexity()` in core. Extension hook remains for custom routing strategies.

### Observability

Every routing decision must be inspectable. The existing `RoutingDecision` interface is extended:

```ts
interface RoutingDecision {
  modelId: string;
  fallbacks: string[];
  tier: ComplexityTier;
  wasDowngraded: boolean;
  reason: string;
  // New fields:
  capabilityScores?: Record<string, number>;    // model ID → score
  taskRequirements?: Partial<Record<string, number>>;  // dimension → weight
  selectionMethod: "tier-only" | "capability-scored";
}
```

When verbose mode is on, the routing notification includes the top-scoring models and why the winner was selected:

```
Dynamic routing [S]: claude-sonnet-4-6 (scored 82.3 — coding:0.9×85, debugging:0.6×80)
  runner-up: gpt-4o (scored 78.1)
```

## Consequences

### Positive

#### 1. Better model-task fit

Routing decisions become based on the kind of work being done, not only how expensive or complex the work appears. A debugging task routes to the strongest debugger in the pool; a research task routes to the best synthesizer.

#### 2. Works across arbitrary model pools

The router no longer depends on a hardcoded vendor assumption. If a user has only Claude + Codex, it can still route intelligently between them. If the user adds Gemini or local models later, the same scoring system continues to work.

#### 3. Preserves all existing invariants

- **Downgrade-only semantics:** capability scoring never upgrades beyond the user's configured phase model.
- **Budget pressure:** unchanged — constrains tier eligibility before scoring runs.
- **Retry escalation:** unchanged — escalates tier, then scoring picks the best model in the new tier.
- **Fallback chains:** assembled the same way, with capability-scored winner as primary.

#### 4. Creates a testable, versionable contract for routing behavior

Capability profiles and task vectors are explicit data structures. Routing decisions are inspectable in verbose mode. The scoring function is a pure function suitable for deterministic unit tests.

#### 5. Opens the door to adaptive learning

Existing routing history (`routing-history.ts`) can later refine capability scores per task type. When a model consistently fails at a particular task shape, its effective score for that dimension decreases. This is a natural extension of the existing `getAdaptiveTierAdjustment()` mechanism.

#### 6. Graceful degradation

Models without capability profiles get uniform scores, producing the same cheapest-in-tier behavior as today. Zero behavior change for users who don't configure heterogeneous pools.

### Negative

#### 1. More metadata to maintain

Built-in model profiles will drift as model families evolve. Mitigation: profiles live in a single data table, versioned with GSD releases, with a lint rule for completeness.

#### 2. Scoring can create false precision

A `0–100` capability scale looks exact but is still heuristic. Mitigation: document profiles as "relative rankings, not benchmarks." The 2-point tie-breaking threshold prevents insignificant score differences from overriding cost optimization.

#### 3. More routing complexity

The current tier router is simple to explain and debug. Multi-dimensional scoring is more powerful but harder to reason about. Mitigation: verbose observability output shows scores and reasons. The `selectionMethod` field in routing decisions makes it clear whether capability scoring was active.

#### 4. Stronger test requirements

The router will need coverage for:

- profile loading and override merge rules (partial deep-merge from `modelOverrides`)
- `computeTaskRequirements()` with various unit types and metadata combinations
- scoring function correctness (weighted average, tie-breaking)
- interaction with tier eligibility filtering
- budget pressure applied before scoring, not conflicting with it
- fallback behavior when no scored model is eligible
- graceful degradation when no profiles exist (uniform scores)
- `before_model_select` hook contract (extension path)

#### 5. New hook surface to maintain

The `before_model_select` hook adds a new extension API contract that must be maintained across releases. Mitigation: the hook is narrowly scoped — one event type, optional return.

### Neutral / Migration

#### 1. Tier-based routing does not disappear

Complexity tiers remain as:

- the primary "how hard is this" signal that determines tier eligibility
- the fallback behavior for models without capability profiles
- the escalation path on retries (light → standard → heavy)

Capability scoring adds the "what kind of work" signal on top. The two systems are layered, not competing.

#### 2. Existing preferences continue to work

`dynamic_routing.tier_models` still works — it pins a specific model per tier, bypassing capability scoring for that tier. Per-phase model overrides (`models.planning`, `models.execution`, etc.) continue to set the ceiling. No existing configuration breaks.

#### 3. Documentation update required

`docs/dynamic-model-routing.md` must be updated to explain:

- what capability profiles are and how to override them
- how scoring interacts with tier routing
- how to read verbose routing output
- how to use `before_model_select` for custom routing extensions

## Risks

### 1. Hardcoded vendor stereotypes become stale

If the default profiles are not reviewed regularly, GSD will encode outdated assumptions about which models are "best" at which tasks.

**Mitigation:** Keep defaults in a single data table (not scattered conditionals). Lint for completeness against the model catalog. User overrides via `modelOverrides` provide immediate escape hatch. Document profiles as heuristic rankings, not benchmarks.

### 2. Budget logic and capability logic may conflict in user perception

The highest-scoring model may not be selected because budget pressure constrained the eligible tier. This could look inconsistent if the user doesn't understand the pipeline order.

**Mitigation:** Pipeline order is explicit and enforced in code:
1. Complexity classification determines tier
2. Budget pressure may downgrade tier
3. Tier-eligible models are filtered (downgrade-only from user ceiling)
4. Capability scoring ranks the eligible set
5. Cost tie-breaks within scoring threshold

Verbose output shows each step. The user sees "budget pressure: 85%" in the reason string when downgrade occurs.

### 3. Task-type classification may be too coarse initially

A unit type like `execute-task` contains many sub-shapes. The initial base vector plus metadata refinement may not distinguish all meaningful cases.

**Mitigation:** The `computeTaskRequirements()` function is designed for iterative refinement. The existing `TaskMetadata` already captures tags, complexity keywords, file counts, dependency counts, and code block counts. New metadata signals can be added to the existing `extractTaskMetadata()` without changing the scoring function. Routing history provides signal on where refinement is needed.

### 4. Unknown and custom models may score poorly by default

Users often bring custom provider IDs, local models, or vendor aliases that will not exist in the built-in profile table.

**Mitigation:** Unknown models receive uniform scores (50 across all dimensions), making capability scoring a no-op — they compete on cost within their tier, same as today. Users can add capability profiles via `modelOverrides` in `models.json` for models they know well.

### 5. Extension hook adds API surface

The `before_model_select` hook creates a contract that extensions may depend on.

**Mitigation:** The hook has a narrow, well-defined interface. It is additive (existing hooks unchanged). The return type is simple (`{ modelId } | undefined`). Breaking changes would be handled through the same extension API versioning as other hooks.

## Alternatives Considered

### A. Keep pure complexity-tier routing

Rejected because it optimizes cost within a tier but still treats meaningfully different models as interchangeable. The existing `MODEL_CAPABILITY_TIER` table already proves this is a recognized gap — it just stops at three buckets.

### B. Hardcode task → model mappings

Rejected because it breaks as soon as the user does not have the expected model. This is appropriate for a closed product with a fixed fleet, not for GSD's user-configured provider model.

### C. Route only by user-specified per-phase models

Rejected because it pushes all routing intelligence onto the user and does not adapt to retries, task subtype, or provider heterogeneity.

### D. Use capability-aware routing only as an extension, never in core

Not rejected as a starting point, but insufficient as the long-term architecture. Extension prototyping is the recommended first phase. However, coherent preferences, diagnostics, testing, and profile versioning will likely require core integration if the model proves valuable.

### E. Add `costEfficiency` as a capability dimension

Rejected because it conflates two concerns. If cost appears in both the scoring function and the budget constraint, the router has two competing cost signals that produce confusing behavior (e.g., a cheap model wins on `costEfficiency` score but then gets filtered out by budget pressure, or vice versa). Cost constrains eligibility; capability determines ranking.

### F. Use static requirement vectors per unit type (no metadata refinement)

Rejected because the existing `classifyUnitComplexity()` already proves that unit type alone is too coarse. A `execute-task` for docs vs. a `execute-task` for migration are categorically different. The metadata signals (tags, complexity keywords, file counts) that the classifier already extracts should inform requirement vectors.

## Appendix: Current Architecture Reference

For implementors, the current routing pipeline files:

| File | Role |
|------|------|
| `auto-dispatch.ts` | Rule table that determines unit type + prompt |
| `auto-model-selection.ts` | Orchestrates model selection for each dispatch |
| `complexity-classifier.ts` | Tier classification with task metadata analysis |
| `model-router.ts` | Tier → model resolution with downgrade-only semantics |
| `routing-history.ts` | Adaptive learning from success/failure patterns |
| `preferences-models.ts` | Per-phase model config resolution and fallbacks |
| `register-hooks.ts` | Hook registration including `before_provider_request` |

The capability scoring additions would primarily touch `model-router.ts` (profiles, scoring function) and `auto-model-selection.ts` (passing metadata to the router, new hook point).
