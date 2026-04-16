# ADR-009: Unified Orchestration Kernel Refactor

**Status:** Accepted (implemented; emergency legacy fallback retained)
**Date:** 2026-04-14
**Deciders:** Jeremy McSpadden, GSD Core Team
**Related:** ADR-001 (worktree architecture), ADR-003 (pipeline simplification), ADR-004 (capability-aware routing), ADR-005 (multi-provider strategy), ADR-008 (tools over MCP)

## Context

GSD already ships many advanced features:

- dynamic model routing and multi-provider support
- hooks (`pre_dispatch_hooks`, `post_unit_hooks`)
- subagents and parallel execution
- worktree/branch isolation and automated git flows
- per-unit metrics and cost ledgers
- activity logs and structured journal events
- verification retries and failure recovery

The current limitation is not missing capability. The limitation is **distribution of control logic across large, mixed-concern modules**, especially in auto-mode and related orchestration files. This raises change risk, creates duplicated policy paths, and slows the introduction of stronger guarantees.

The target requirements for the next architecture are:

1. User can use any available model during any phase.
2. First-class hooks, agents, sub-agents, team execution, and parallel workflows.
3. Git actions on every turn with deterministic, auditable behavior.
4. Logging of every action with causal traceability.
5. Long upfront planning via multi-round questioning and research.
6. Plan slicing and controlled dispatch through strict gate validation.
7. Deterministic failure reprocessing loops.
8. Automatic testing during build and gate transitions.
9. Explicit token usage controls including a high-burn mode.
10. Enforced compliance with provider/model terms of service.

## Decision

Refactor GSD into a **Unified Orchestration Kernel (UOK)** with explicit control planes, typed contracts, and an incremental strangler migration. This is a staged architectural replacement of orchestration internals, not a rewrite of user-facing CLI/web/MCP surfaces.

### Core Architectural Model

The orchestrator is split into six control planes:

1. **Plan Plane**
2. **Execution Plane**
3. **Model Plane**
4. **Gate Plane**
5. **GitOps Plane**
6. **Audit Plane**

Each dispatched unit (turn) executes through a single deterministic pipeline:

```text
Discover/Clarify/Research -> Plan Compile -> Model Select -> Execute -> Validate -> Git Transaction -> Persist Audit -> Next Unit
```

## Detailed Design

### 1) Plan Plane: Multi-Round Front-Loaded Planning

Add a formal planning lifecycle:

1. `discover`: codebase and state scan
2. `clarify`: multi-round user questions (bounded rounds, explicit stop condition)
3. `research`: internal and external synthesis
4. `draft-plan`: produce full roadmap and milestones
5. `compile`: slice into executable units with IO boundaries
6. `plan-gate`: reject/repair invalid plans before execution starts

Required outputs:

- `ROADMAP.md` (complete)
- per-milestone slice graph
- per-task executable unit specs
- requirement trace matrix (requirement -> unit(s) -> verification)
- plan risk register

Plan gate fails closed if:

- missing acceptance criteria
- missing verification strategy
- cyclic task dependencies
- unowned artifacts
- missing rollback/recovery semantics for risky units

### 2) Execution Plane: Agents, Sub-Agents, Teams, Parallel

Unify all execution into a typed DAG scheduler.

Node kinds:

- `unit` (single execution task)
- `hook`
- `subagent`
- `team-worker`
- `verification`
- `reprocess`

Edges express:

- hard dependencies
- resource conflicts (file-level IO locks)
- ordering constraints (gate-before-merge, test-before-closeout)

Execution modes:

- single-worker deterministic mode
- multi-worker parallel mode
- team mode (shared repo, unique milestone IDs, gated merge)

This removes ad-hoc parallel behavior and makes sub-agent and team paths first-class scheduler decisions.

### 3) Model Plane: Any Model in Any Phase

Replace rigid phase->model assumptions with **requirement-based eligibility**.

Selection pipeline:

1. gather phase/unit requirements (capabilities, context size, latency profile)
2. gather eligible models from configured providers
3. apply hard policy filters (provider auth, TOS, tool compatibility, org rules)
4. apply soft scoring (capability vectors, budget profile, historical outcomes)
5. choose primary + fallback chain

Rules:

- Any model can run any phase if it passes policy and capability constraints.
- User pins remain hard ceilings only when configured explicitly.
- Unknown models are allowed with conservative default capability scores.

Add model intent profiles:

- `economy` (lowest cost)
- `balanced`
- `quality`
- `burn-max` (highest compute/token burn within policy and budget limits)

### 4) Gate Plane: Controlled Dispatch and Reprocessing

All units pass explicit gates:

1. `policy-gate` (provider/tool/TOS/security checks)
2. `input-gate` (unit contract completeness, artifact readiness)
3. `execution-gate` (runtime guardrails, timeout strategy, tool allowlist)
4. `artifact-gate` (expected outputs and format validation)
5. `verification-gate` (lint/test/typecheck/security checks)
6. `closeout-gate` (state transition safety + git transaction outcome)

Gate outcomes:

- `pass`
- `retryable-fail`
- `hard-fail`
- `manual-attention`

Failure reprocessing matrix (deterministic):

- code failure -> targeted fix prompt + bounded retry
- test failure -> impacted test fix loop
- tool failure -> alternate tool/provider fallback
- model failure -> fallback model chain
- policy failure -> immediate hard stop and explicit reason

Retry policy:

- bounded attempts per gate
- escalating strategy per attempt
- terminal state persisted with full evidence

### 5) GitOps Plane: Git Action Every Turn

Every dispatched unit is wrapped in a git transaction:

1. `turn-start`: capture branch/worktree status and dirty-state snapshot
2. `turn-exec`: run unit
3. `turn-stage`: stage relevant changes
4. `turn-checkpoint`: commit checkpoint or structured no-op record
5. `turn-publish`: optional push per policy
6. `turn-record`: write commit metadata into audit ledger

Defaults:

- checkpoint commit each turn in milestone branch/worktree
- squash on milestone merge to keep main history clean

Configurable strictness:

- `git.turn_action: commit|snapshot|status-only`
- `git.turn_push: never|milestone|always`

If a repo state blocks commit (e.g., conflicts), turn fails at closeout gate with explicit diagnostics.

### 6) Audit Plane: Log Every Action

Promote current activity/journal into a single causal event model.

Event classes:

- orchestrator (`dispatch`, `gate-result`, `state-transition`)
- model (`selection`, `fallback`, `provider-switch`)
- tool (`call`, `result`, `error`)
- git (`status`, `stage`, `commit`, `merge`, `push`)
- test (`command`, `result`, `retry`)
- policy (`allow`, `deny`, `warning`)
- cost (`tokens`, `cost`, `cache-hit`, `budget-pressure`)

Every event includes:

- `eventId`
- `traceId` (session)
- `turnId` (unit)
- `causedBy` reference
- timestamp
- durable payload

Storage:

- append-only JSONL + indexed SQLite projection for queryability
- no destructive rewrites of source audit logs

## Compliance and TOS Enforcement

Introduce a provider policy engine as a hard dependency of the policy gate.

Provider policy definition includes:

- allowed auth modes
- prohibited token exchange paths
- tool/protocol constraints
- subscription vs API usage boundaries
- model-specific restrictions

Enforcement rules:

- deny disallowed auth/routing before dispatch
- deny model selection if provider constraints are not met
- emit policy evidence events on every allow/deny decision

This formalizes current compliance work (notably Anthropic/Claude Code boundaries) into a reusable engine rather than scattered checks.

## Automatic Testing Strategy

Testing becomes mandatory at three levels:

1. **Per-turn**: impacted tests + lint/typecheck subset
2. **Per-slice closeout**: full slice verification profile
3. **Per-milestone closeout**: full suite (or policy-defined release profile)

Verification commands become declarative policies by unit type, not ad-hoc shell lists only.

## Token Strategy and Burn-Max Mode

Existing token optimization modes remain, plus explicit high-burn profile.

`burn-max` behavior:

- maximize context inclusion
- prefer high-capability models
- enable deeper critique/review passes
- increase planning/research depth

Hard limits still apply:

- budget ceiling and enforcement rules
- provider rate limits
- TOS/policy constraints

The system must never bypass provider restrictions to increase usage.

## Migration Plan (Strangler Refactor)

No big-bang rewrite. Migrate in waves with compatibility adapters.

### Wave 0: Contracts and Telemetry Baseline

- define turn contract and gate result schemas
- add trace IDs/turn IDs to current paths
- keep behavior unchanged

### Wave 1: Gate Plane Extraction

- extract gate runner from auto loop
- route existing checks through unified gate API

### Wave 2: Model Plane Unification

- requirement-based model selection
- policy filter insertion before scoring
- preserve existing model config semantics

### Wave 3: Scheduler and Execution Graph

- introduce DAG scheduler
- map existing subagent/parallel features to graph nodes
- enable graph mode behind flag

### Wave 4: GitOps Transaction Layer

- enforce turn-level git actions
- add deterministic checkpoint behavior

### Wave 5: Audit Plane Consolidation

- unify journal/activity/metrics events under common envelope
- add query projection

### Wave 6: Plan Plane v2

- multi-round clarify/research planner
- compiled unit graph + plan gate

### Wave 7: Legacy Path Retirement

- remove obsolete branches in `auto.ts` and related modules
- keep CLI/API compatibility

## Module Extraction Targets

Primary decomposition targets:

- `auto.ts` -> orchestrator kernel + adapters
- `auto-prompts.ts` -> plan compiler + prompt renderers
- `state.ts` -> state query service + immutable state views
- `gsd-db.ts` -> data access layer + event projection store
- `auto-post-unit.ts` / `auto-verification.ts` -> closeout gate services

## Acceptance Criteria

The refactor is accepted when all conditions are true:

1. Any configured model can be selected in any phase when policy permits.
2. Hooks, agents, sub-agents, teams, and parallel all execute under one scheduler contract.
3. Every turn produces at least one git action record and auditable turn closeout.
4. Every dispatch and action is traceable by `traceId` and `turnId`.
5. Multi-round planning produces a full executable unit graph before execution.
6. Gate outcomes are explicit, deterministic, and persisted.
7. Failure reprocessing uses typed failure classes, not generic retries.
8. Automatic tests run per policy on every turn/slice/milestone gate.
9. Token usage is tracked at turn granularity with burn-max profile support.
10. Policy engine blocks TOS-violating routes and records evidence.

## Closure Update (2026-04-16)

ADR-009 closure is complete, with emergency fallback retained as a release safety valve.

- Kernel-native dispatch is the default UOK runtime path.
- Unit/hook/subagent/team-worker/verification/reprocess dispatch now routes through the scheduler contract facade.
- Legacy execution remains available only through explicit emergency fallback controls.
- CI parity coverage includes explicit kernel-vs-legacy path assertions.

Evidence is tracked in the implementation plan matrix:
- [ADR-009-IMPLEMENTATION-PLAN.md](/Users/jeremymcspadden/Github/gsd-2/docs/dev/ADR-009-IMPLEMENTATION-PLAN.md)

## Consequences

### Positive

- Stronger reliability through fail-closed gates
- Faster feature delivery by isolating orchestration concerns
- Clear compliance and audit posture
- Better debuggability from causal event logs
- Controlled support for aggressive high-burn workflows

### Negative

- Significant migration effort across core modules
- More configuration surface area
- Temporary complexity during dual-path migration

### Neutral

- Existing user commands and workflows remain stable during migration
- Existing preferences remain supported with compatibility adapters

## Alternatives Considered

### A) Full rewrite in a new codebase

Rejected. Too risky for a live project with broad surface area and active releases.

### B) Continue incremental patching without architecture split

Rejected. Slows delivery and increases regression risk as orchestration complexity grows.

### C) Keep existing optimization-first token model only

Rejected. Does not satisfy explicit requirement for intentional high-burn workflows.

## Risks and Mitigations

1. **Migration regressions**
   - Mitigation: golden-path replay tests and shadow mode comparisons per wave.
2. **Audit log volume growth**
   - Mitigation: append-only raw logs plus indexed projections and retention policies.
3. **Git noise from per-turn commits**
   - Mitigation: milestone squash merge defaults and configurable checkpoint modes.
4. **Provider policy drift**
   - Mitigation: versioned provider policy registry with test fixtures per provider.

## Open Questions

1. Should `turn_action: commit` be mandatory default for all modes or only auto-mode?
2. Should `burn-max` be opt-in global, project-scoped, or both?
3. Should policy violations always halt or allow configurable warn-only mode for local development?

## Implementation Note

This ADR intentionally aligns with current architecture principles:

- extension-first where practical
- strong test contracts
- pragmatic incremental rollout
- provider-agnostic execution with explicit policy constraints
