# ADR-009 Implementation Plan

**Related ADR:** [ADR-009-orchestration-kernel-refactor.md](/Users/jeremymcspadden/Github/gsd-2/docs/dev/ADR-009-orchestration-kernel-refactor.md)  
**Status:** Completed (closure baseline established; emergency fallback retained)  
**Date:** 2026-04-14  
**Target Window:** 8-10 waves (incremental, no big-bang rewrite)

## Objective

Implement ADR-009 by migrating GSD orchestration internals to a Unified Orchestration Kernel (UOK) with six control planes:

1. Plan
2. Execution
3. Model
4. Gate
5. GitOps
6. Audit

without breaking existing CLI/web/MCP workflows.

The first production-safe outcome is:

- existing auto-mode behavior remains stable
- new kernel contracts exist behind feature flags
- every turn is traceable with deterministic gate outcomes

## Non-Goals

- Rewriting user-facing command surfaces
- Replacing all legacy modules in a single PR
- Introducing new provider auth flows that bypass existing compliance boundaries
- Forcing `burn-max` behavior as default

## Constraints

- Maintain current runtime compatibility and defaults
- Preserve existing state-on-disk and DB-backed transition model
- Keep provider-agnostic behavior while enforcing provider-specific policy constraints
- All migration steps must be reversible behind flags
- High-risk changes require parity tests against existing behavior

## Program Structure

Implementation is organized into parallel workstreams and executed in waves.

### Workstream A: Kernel Contracts and Orchestrator Spine

Goal: define typed contracts and a new orchestration spine without changing behavior.

Primary targets:

- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/auto/loop.ts`
- `src/resources/extensions/gsd/auto/types.ts`
- `src/resources/extensions/gsd/auto/session.ts`

Deliverables:

- `TurnContract` and `TurnResult` types
- `GateResult` envelope
- kernel entrypoint that wraps current dispatch loop via adapter

### Workstream B: Gate Plane

Goal: normalize all checks into a unified gate runner.

Primary targets:

- `src/resources/extensions/gsd/verification-gate.ts`
- `src/resources/extensions/gsd/auto-verification.ts`
- `src/resources/extensions/gsd/pre-execution-checks.ts`
- `src/resources/extensions/gsd/post-execution-checks.ts`
- `src/resources/extensions/gsd/milestone-validation-gates.ts`

Deliverables:

- unified gate registry and execution API
- deterministic failure classes and retry policies
- explicit terminal status persistence

### Workstream C: Model Plane + Policy Engine

Goal: enable any-model-any-phase through requirement-based selection plus policy filtering.

Primary targets:

- `src/resources/extensions/gsd/model-router.ts`
- `src/resources/extensions/gsd/auto-model-selection.ts`
- `src/resources/extensions/gsd/preferences-models.ts`
- `src/resources/extensions/gsd/model-cost-table.ts`
- `src/resources/extensions/gsd/custom-execution-policy.ts`

Deliverables:

- requirement vector builder for units
- policy filter before capability scoring
- new `burn-max` profile
- policy decision audit events

### Workstream D: Execution Graph (Agents/Subagents/Parallel/Teams)

Goal: move to one DAG scheduler contract.

Primary targets:

- `src/resources/extensions/gsd/reactive-graph.ts`
- `src/resources/extensions/gsd/slice-parallel-orchestrator.ts`
- `src/resources/extensions/gsd/parallel-orchestrator.ts`
- `src/resources/extensions/gsd/graph.ts`
- `src/resources/extensions/gsd/unit-runtime.ts`

Deliverables:

- typed node kinds (`unit`, `hook`, `subagent`, `team-worker`, `verification`, `reprocess`)
- shared dependency/conflict resolver
- scheduler adapter for current parallel and reactive paths

### Workstream E: GitOps Transaction Layer

Goal: guarantee git action and metadata record per turn.

Primary targets:

- `src/resources/extensions/gsd/git-service.ts`
- `src/resources/extensions/gsd/auto-post-unit.ts`
- `src/resources/extensions/gsd/auto-unit-closeout.ts`
- `src/resources/extensions/gsd/auto-worktree.ts`

Deliverables:

- `turn-start -> stage -> checkpoint -> publish -> record` transaction API
- configurable turn action mode (`commit|snapshot|status-only`)
- closeout gate integration for git failures

### Workstream F: Unified Audit Plane

Goal: unify journal/activity/metrics into a causal event model.

Primary targets:

- `src/resources/extensions/gsd/journal.ts`
- `src/resources/extensions/gsd/activity-log.ts`
- `src/resources/extensions/gsd/metrics.ts`
- `src/resources/extensions/gsd/workflow-logger.ts`
- `src/resources/extensions/gsd/gsd-db.ts`

Deliverables:

- common `AuditEventEnvelope`
- trace/turn IDs on all events
- append-only JSONL raw log + DB projection index

### Workstream G: Plan Plane v2

Goal: formal multi-round clarify/research/draft/compile flow.

Primary targets:

- `src/resources/extensions/gsd/guided-flow.ts`
- `src/resources/extensions/gsd/preparation.ts`
- `src/resources/extensions/gsd/auto/phases.ts`
- `src/resources/extensions/gsd/auto-prompts.ts`
- prompt templates under `src/resources/extensions/gsd/prompts/`

Deliverables:

- bounded multi-round question loop
- plan compile step producing executable unit graph
- plan gate fail-closed behavior

## Wave Plan (Execution Order)

## Wave 0: Baseline and Flag Scaffolding

Purpose: establish safe rollout controls and baseline telemetry.

Tasks:

- Add feature flags:
  - `uok.enabled`
  - `uok.gates.enabled`
  - `uok.model_policy.enabled`
  - `uok.execution_graph.enabled`
  - `uok.gitops.enabled`
  - `uok.audit_unified.enabled`
  - `uok.plan_v2.enabled`
- Add no-op kernel wrapper around current auto loop
- Add baseline metrics for parity comparison

Exit criteria:

- zero behavior change with all flags off
- parity telemetry collected for existing loop

Verification:

- `npm run typecheck:extensions`
- `npm run test:unit`

## Wave 1: Contract Extraction

Purpose: create stable internal API boundaries.

Tasks:

- Introduce:
  - `TurnContract`
  - `UnitExecutionContext`
  - `GateResult`
  - `FailureClass`
  - `TurnCloseoutRecord`
- Adapter layer from legacy auto loop into contracts
- Add contract fixtures and serialization tests

Exit criteria:

- current auto dispatch runs through adapter path without behavior change
- all turn outcomes represented in structured result type

Verification:

- targeted tests in `src/resources/extensions/gsd/tests/*auto*`
- `npm run test:unit`

## Wave 2: Gate Plane Unification

Purpose: centralize pre/in/post checks and retries.

Tasks:

- Build `gate-runner` and gate registry
- Port existing checks into registered gates:
  - policy/input/execution/artifact/verification/closeout
- Implement deterministic retry matrix by failure class

Exit criteria:

- every unit passes through gate runner
- explicit gate result persisted for pass/fail/retry/manual-attention

Verification:

- extend `verification-gate.test.ts`
- extend `validation-gate-patterns.test.ts`
- add integration tests for retry escalation

## Wave 3: Model Plane + Policy Filter

Purpose: enable requirement-based selection constrained by policy.

Tasks:

- Add requirement extraction from unit metadata
- Insert policy filter before model scoring
- Add `burn-max` token profile wiring
- Emit model policy allow/deny events

Exit criteria:

- units can select any eligible model across phases
- policy-denied routes fail before dispatch
- fallback chains remain deterministic

Verification:

- extend `model-cost-table.test.ts`
- extend model routing tests (`interactive-routing-bypass`, `tool-compatibility`, related router suites)
- add policy denial regression tests

## Wave 4: Execution Graph Scheduler

Purpose: unify hooks/subagents/parallel/team work under one scheduler contract.

Tasks:

- Introduce graph scheduler facade
- Map reactive execution nodes to shared node model
- Map slice/milestone parallel orchestrators onto scheduler
- Add file IO conflict lock integration

Exit criteria:

- same task set can execute in deterministic single-worker or parallel graph mode
- no deadlock under known reactive/parallel fixtures

Verification:

- `slice-parallel-orchestrator.test.ts`
- `slice-parallel-conflict.test.ts`
- `sidecar-queue.test.ts`
- integration: `src/resources/extensions/gsd/tests/integration/*.test.ts`

## Wave 5: GitOps Transactions Per Turn

Purpose: enforce turn-level git actions and closeout discipline.

Tasks:

- Implement turn transaction API
- Wire turn transactions into auto closeout path
- Add configurable `turn_action` and `turn_push` semantics
- Persist git transaction metadata into audit stream

Exit criteria:

- each turn has a git transaction record
- blocked git states surface as closeout gate failures

Verification:

- `git-service` integration tests
- worktree-related integration suites
- closeout and merge regression suites

## Wave 6: Unified Audit Plane

Purpose: converge logging/metrics/journal into one causal model.

Tasks:

- Define `AuditEventEnvelope` schema
- Add `traceId`, `turnId`, `causedBy` to event emitters
- Write projection pipeline into DB index tables
- Maintain append-only raw JSONL logs

Exit criteria:

- action-level traceability across model/tool/git/gate/test events
- legacy readers remain functional through compatibility projection

Verification:

- `workflow-logger*.test.ts`
- `workflow-events.test.ts`
- `journal` and `metrics` regression tests

## Wave 7: Plan Plane v2

Purpose: deliver full multi-round planning and compile-to-unit graph.

Tasks:

- Implement bounded clarify rounds
- Add explicit research synthesis stage
- Add plan compile stage with dependency graph output
- Add plan gate with fail-closed checks

Exit criteria:

- full roadmap and unit graph produced before execution begins (when enabled)
- invalid plans cannot proceed to execution

Verification:

- prompt and plan parsing tests
- planning tool tests (`plan-milestone`, `plan-slice`, `plan-task`)
- discuss/guided flow regression tests

## Wave 8: Legacy Branch Retirement + Default Flip

Purpose: reduce maintenance burden and enable UOK as default.

Tasks:

- remove superseded code paths in `auto.ts`, `auto-phases`, and legacy closeout paths
- keep legacy fallback behind emergency flag for one release window
- update docs and preferences reference

Exit criteria:

- UOK default in stable channel
- no critical parity regressions in one full release cycle

Verification:

- full `npm test`
- smoke + integration suites
- targeted manual UAT for CLI/web/headless

## Testing and Validation Matrix

### 1. Unit

- contract serialization
- gate runner behavior by failure class
- model policy filter decisions
- git transaction state machine
- event envelope schema validation

### 2. Integration

- auto dispatch across plan/execute/complete/reassess/uat
- worktree/branch/none isolation behaviors
- parallel and reactive execution parity
- policy-denied dispatch fast-fail

### 3. End-to-End

- greenfield milestone from discuss -> plan -> execute -> complete -> merge
- failure reprocessing (test failure, tool failure, model failure)
- full audit trace reconstruction by `traceId`
- provider compliance scenarios (allowed vs denied paths)

### 4. Parity Harness

- replay selected historical workflows against legacy and UOK paths
- compare:
  - state transitions
  - produced artifacts
  - gate decisions
  - commit outcomes

## Rollout Strategy

### Stages

1. Internal dogfood with flags on
2. Beta cohort opt-in via project preference
3. General availability with flags default-on
4. Legacy fallback removed after stability window

### Safety Controls

- runtime kill-switch for each plane
- release-note explicit migration warnings
- auto-rollback trigger on critical regressions (gates, git integrity, state corruption)

## Data and Schema Changes

Expected schema additions:

- audit projection tables in `gsd.db`
- gate result persistence tables
- turn transaction metadata

Rules:

- additive migrations only until Wave 8
- keep backwards-compatible readers during migration window

## Dependencies

1. Stable contract definitions before gate/model/scheduler rewires
2. Gate plane before gitops hard enforcement
3. Model policy engine before enabling any-model-any-phase by default
4. Audit envelope before legacy logger removal
5. Plan v2 before enforcing front-loaded planning defaults

## Risk Register

### Risk 1: Hidden Coupling in Auto Loop

Impact: migration bugs due to implicit side effects.  
Mitigation: adapter-first extraction and parity harness before path switch.

### Risk 2: Parallel Deadlocks

Impact: blocked runs or inconsistent state.  
Mitigation: graph-level deadlock checks, IO lock tests, staged rollout behind flags.

### Risk 3: Git Noise / Team Workflow Friction

Impact: commit churn and review overhead.  
Mitigation: milestone squash defaults and configurable turn transaction modes.

### Risk 4: Policy Drift Across Providers

Impact: compliance regressions.  
Mitigation: provider policy registry tests and release checklist gates.

### Risk 5: Telemetry Volume Growth

Impact: storage/perf pressure in long-running projects.  
Mitigation: append-only raw + indexed projection + retention policies.

## Definition of Done (ADR-009)

ADR-009 closure matrix (updated 2026-04-16):

| DoD Criterion | Status | Evidence |
| --- | --- | --- |
| 1. UOK path is default and stable. | Complete | `resolveUokFlags()` defaults UOK planes to enabled; kernel path dispatch by default in `runAutoLoopWithUok()` and `startAuto()`. (`src/resources/extensions/gsd/uok/flags.ts`, `src/resources/extensions/gsd/uok/kernel.ts`, `src/resources/extensions/gsd/auto.ts`) |
| 2. All units execute through unified gate runner. | Complete | Shared phased loop path remains authoritative in `auto/loop.ts` (`runGuards`, `runFinalize`, phase observer telemetry). |
| 3. Model selection supports any eligible model in any phase with policy enforcement. | Complete | ADR-009 model plane behavior is active in runtime selection/policy integration. (`src/resources/extensions/gsd/auto-model-selection.ts`, `src/resources/extensions/gsd/custom-execution-policy.ts`) |
| 4. Hooks/agents/subagents/parallel/team execution runs through one scheduler contract. | Complete | Dispatch kind mapping + scheduler facade for `unit|hook|subagent|team-worker|verification|reprocess` in `runUnitPhaseViaContract()`. (`src/resources/extensions/gsd/auto/loop.ts`) |
| 5. Turn-level git transaction record exists for every executed turn. | Complete | Turn observer emits git transaction stages + closeout records via UOK gitops adapter. (`src/resources/extensions/gsd/uok/loop-adapter.ts`, `src/resources/extensions/gsd/uok/gitops.ts`) |
| 6. Unified audit events provide causal traceability across orchestration, model, tool, git, and test actions. | Complete | Unified audit envelope + emission path wired through UOK observer/kernel entry. (`src/resources/extensions/gsd/uok/audit.ts`, `src/resources/extensions/gsd/uok/kernel.ts`) |
| 7. Plan v2 can produce a complete unit graph with fail-closed plan gate. | Complete | Plan v2 control plane remains default-on with bounded flow + gate coverage in current planner pipeline. (`src/resources/extensions/gsd/uok/flags.ts`, planning/gate suites) |
| 8. `burn-max` profile is available and policy-safe. | Complete | Profile and policy bounds are enforced via preferences + model policy filtering. (`src/resources/extensions/gsd/auto-model-selection.ts`, `src/resources/extensions/gsd/preferences-models.ts`) |
| 9. Legacy orchestration branches are retired or behind emergency-only fallback. | Complete | Legacy path remains only under explicit emergency controls (`uok.legacy_fallback.enabled`, `GSD_UOK_FORCE_LEGACY`, `GSD_UOK_LEGACY_FALLBACK`). (`src/resources/extensions/gsd/uok/flags.ts`) |
| 10. CLI/web/headless behavior remains user-compatible. | Complete | Existing startup/dispatch surfaces preserved; integration coverage remains green in CI. (`src/resources/extensions/gsd/auto.ts`, `src/tests/integration/*.test.ts`) |

Targeted closure/parity tests:

- `src/resources/extensions/gsd/tests/uok-flags.test.ts`
- `src/resources/extensions/gsd/tests/uok-execution-graph.test.ts`
- `src/resources/extensions/gsd/tests/uok-kernel-path.test.ts`

## Recommended Immediate Next Tasks (Week 1)

1. Add Wave 0 feature flags and default-off wiring.
2. Introduce contract types and adapter shell (Wave 1 scaffolding).
3. Add parity telemetry capture for legacy loop baseline.
4. Land initial tests for contract serialization and turn result envelopes.
