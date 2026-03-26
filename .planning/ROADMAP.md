# Roadmap — Capability-Aware Model Routing

**Milestone:** M001 — ADR-004 Implementation
**Target:** Extend dynamic model routing with capability scoring

## Phases

### Phase 1: Capability-Aware Model Routing
**Goal:** Implement 2D model routing (complexity tier + capability scoring) per ADR-004
**Canonical refs:** `docs/ADR-004-capability-aware-model-routing.md`, `docs/dynamic-model-routing.md`
**Plans:** 5/5 plans executed (COMPLETE)

Plans:
- [x] 01-01-PLAN.md — Types, data tables, pure functions, interface extensions, metadata passthrough
- [x] 01-02-PLAN.md — Unit tests for scoring functions and metadata passthrough (TDD)
- [x] 01-03-PLAN.md — STEP 2 pipeline integration (scoring in resolveModelForComplexity + metadata wiring)
- [x] 01-04-PLAN.md — before_model_select hook (ExtensionAPI + runner + loader + GSD registration)
- [x] 01-05-PLAN.md — Hook firing, verbose output, capability overrides, integration tests, docs

Key deliverables:
- Model capability profiles data table (7 dimensions)
- Dynamic task requirement vectors (`computeTaskRequirements`)
- Scoring function with deterministic tie-breaking
- `getEligibleModels()` helper extraction
- `before_model_select` hook
- `ClassificationResult` metadata passthrough
- `DynamicRoutingConfig` capability_routing flag
- User override support via `modelOverrides.capabilities`
- Extended `RoutingDecision` observability
- Updated documentation
- Comprehensive test suite
