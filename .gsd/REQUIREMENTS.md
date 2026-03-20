# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R001 — A `WorkflowEngine` interface that owns state derivation, dispatch resolution, completion reconciliation, and TUI display metadata. The auto-loop calls these methods polymorphically instead of directly invoking dev-specific functions.
- Class: core-capability
- Status: active
- Description: A `WorkflowEngine` interface that owns state derivation, dispatch resolution, completion reconciliation, and TUI display metadata. The auto-loop calls these methods polymorphically instead of directly invoking dev-specific functions.
- Why it matters: This is the fundamental abstraction that enables pluggable workflows. Without it, every new workflow type requires modifying the loop itself.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S02
- Validation: S01: WorkflowEngine interface defined in workflow-engine.ts with engineId + deriveState/resolveDispatch/reconcile/getDisplayMetadata. Compiles cleanly. Contract test validates shape (19/19 pass). Not yet wired — S02 implements.
- Notes: Interface must support `deriveState()`, `resolveDispatch()`, `reconcile()`, `getDisplayMetadata()` at minimum.

### R002 — An `ExecutionPolicy` interface that owns workspace preparation, model selection, verification execution, recovery handling, and post-unit closeout. Separates "how to run" from "what to run next."
- Class: core-capability
- Status: active
- Description: An `ExecutionPolicy` interface that owns workspace preparation, model selection, verification execution, recovery handling, and post-unit closeout. Separates "how to run" from "what to run next."
- Why it matters: Dev workflows need auto-commit, doctor runs, and worktree sync. Custom workflows may need none of that. The policy makes this pluggable.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S02
- Validation: S01: ExecutionPolicy interface defined in execution-policy.ts with prepareWorkspace/selectModel/verify/recover/closeout. Compiles cleanly. Contract test validates shape. Not yet wired — S02 implements.
- Notes: Interface must support `prepareWorkspace()`, `selectModel()`, `verify()`, `recover()`, `closeout()` at minimum.

### R003 — The ~70-function `LoopDeps` interface is decomposed into logical groups: git operations, model routing, budget/context, verification, state management, worktree, post-unit processing, etc. Each group is a separate typed interface.
- Class: quality-attribute
- Status: active
- Description: The ~70-function `LoopDeps` interface is decomposed into logical groups: git operations, model routing, budget/context, verification, state management, worktree, post-unit processing, etc. Each group is a separate typed interface.
- Why it matters: LoopDeps is a god-interface that makes reasoning about dependencies impossible. Decomposition makes the loop's actual needs visible and testable per-concern.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01: 10 role-based sub-interfaces in loop-deps-groups.ts covering all 58 modules imported by auto.ts. Composite LoopDeps interface groups all 10. Contract test validates count and group keys. Not yet consumed — S02 uses for engine construction.
- Notes: The decomposition must be mechanical — same functions, grouped differently. No behavior change.

### R006 — Workflow definitions are YAML files with a `version: 1` schema. Each definition has steps with IDs, names, prompts, dependency declarations (`requires`), artifact outputs (`produces`), and parameterization via `{{variable}}` template syntax.
- Class: core-capability
- Status: active
- Description: Workflow definitions are YAML files with a `version: 1` schema. Each definition has steps with IDs, names, prompts, dependency declarations (`requires`), artifact outputs (`produces`), and parameterization via `{{variable}}` template syntax.
- Why it matters: YAML definitions are the public API for custom workflows. They must be simple enough to write (or generate) and expressive enough for real workflows.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S07
- Validation: S04 T01: definition-loader.ts implements V1 YAML schema with validateDefinition() enforcing version===1, name required, steps non-empty with id/name/prompt, produces paths reject ".." traversal. Unknown fields silently accepted for forward compatibility. loadDefinition() handles snake_case→camelCase conversion (depends_on→requires, context_from→contextFrom). S04 T03: Integration test proves YAML file loads, validates, and feeds full dispatch cycle. 13 unit tests + 4 integration tests pass. Parameterization via {{variable}} deferred to S07.
- Notes: Schema becomes a versioned public API. V1 surface must be minimal and stable.

### R007 — When a workflow run starts, the definition YAML is copied into the run directory as `DEFINITION.yaml`. Mid-run edits to the source definition do not affect active runs.
- Class: continuity
- Status: active
- Description: When a workflow run starts, the definition YAML is copied into the run directory as `DEFINITION.yaml`. Mid-run edits to the source definition do not affect active runs.
- Why it matters: Crash recovery and deterministic re-derivation require immutable run state.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: none
- Validation: S04 T02: createRun() in run-manager.ts uses copyFileSync for exact byte-copy of source YAML into run directory as DEFINITION.yaml. S04 T03: Integration test "DEFINITION.yaml snapshot is immune to source modification" proves source YAML modified after createRun still has original bytes in run dir. 4/4 integration tests pass.
- Notes: Re-expansion of iteration steps requires explicit user action, not automatic detection of source changes.

### R008 — A `GRAPH.yaml` file in each run directory tracks the expanded set of step instances, their dependencies, completion status, and timestamps. This is the authoritative source of truth for "what's done, what's next."
- Class: core-capability
- Status: active
- Description: A `GRAPH.yaml` file in each run directory tracks the expanded set of step instances, their dependencies, completion status, and timestamps. This is the authoritative source of truth for "what's done, what's next."
- Why it matters: Durable step state enables crash recovery and deterministic re-derivation for custom workflows.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S06
- Validation: S03 T01: graph.ts implements GRAPH.yaml read/write with atomic writes (tmp + renameSync), step status tracking (pending→active→complete), topological dispatch order via getNextPendingStep(). S04 T01: graphFromDefinition() converts validated WorkflowDefinition into WorkflowGraph with all steps pending. S04 T02: createRun() generates initial GRAPH.yaml from definition via graphFromDefinition()+writeGraph(). S04 T03: Integration test proves full pipeline — YAML definition→createRun→3-step dispatch cycle→all steps complete with on-disk GRAPH.yaml verification. 11/11 engine tests + 4/4 integration tests pass.
- Notes: Artifact existence is validated during `reconcile()` — GRAPH says done but artifact missing triggers a corruption warning. S03 established the core read/write/query primitives; S04 connects these to YAML definitions and run lifecycle.

### R009 — Steps can declare `context_from: [step_ids]` to auto-inject summaries from prior steps' artifacts into their prompt. The engine handles this injection transparently.
- Class: primary-user-loop
- Status: active
- Description: Steps can declare `context_from: [step_ids]` to auto-inject summaries from prior steps' artifacts into their prompt. The engine handles this injection transparently.
- Why it matters: Each step runs in a fresh agent session. Without context injection, steps have no knowledge of what prior steps produced.
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: none
- Validation: unmapped
- Notes: Summaries are extracted from step artifacts, not from conversational memory.

### R010 — Custom workflow steps support four verification policies. `content-heuristic` checks artifact size and patterns. `shell-command` runs a script. `prompt-verify` has the LLM evaluate output. `human-review` pauses for user input.
- Class: failure-visibility
- Status: active
- Description: Custom workflow steps support four verification policies. `content-heuristic` checks artifact size and patterns. `shell-command` runs a script. `prompt-verify` has the LLM evaluate output. `human-review` pauses for user input.
- Why it matters: Verification prevents "fail forward" into corrupted state. Mandatory verification is a design principle from the ADR.
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: none
- Validation: unmapped
- Notes: Default for steps without explicit policy is `content-heuristic` with reasonable defaults (non-empty, >100 bytes).

### R011 — Steps with an `iterate` field pattern-match items from a source artifact (e.g., chapters from an outline). Matched items are materialized as concrete step instances in `GRAPH.yaml` before dispatch. Instances execute serially in topological order.
- Class: core-capability
- Status: active
- Description: Steps with an `iterate` field pattern-match items from a source artifact (e.g., chapters from an outline). Matched items are materialized as concrete step instances in `GRAPH.yaml` before dispatch. Instances execute serially in topological order.
- Why it matters: Real workflows need fan-out — "draft each chapter," "audit each endpoint," "review each module." Linear-only is too limiting.
- Source: user
- Primary owning slice: M001/S06
- Supporting slices: none
- Validation: unmapped
- Notes: Once expanded, iteration is frozen for that run. Source changes after expansion do not retroactively add/remove instances.

### R012 — `/gsd workflow new` starts a conversation where the user describes their workflow. The agent asks clarifying questions, then generates a valid YAML definition following the schema and saves it to `workflow-defs/`.
- Class: primary-user-loop
- Status: active
- Description: `/gsd workflow new` starts a conversation where the user describes their workflow. The agent asks clarifying questions, then generates a valid YAML definition following the schema and saves it to `workflow-defs/`.
- Why it matters: Users shouldn't need to learn YAML schema to create workflows. The agent is the builder.
- Source: user
- Primary owning slice: M001/S07
- Supporting slices: none
- Validation: unmapped
- Notes: The conversation should end with the saved file path and a prompt to run it via `/gsd workflow run <name>`.

### R013 — `/gsd workflow` subcommands provide the full lifecycle: `new` (LLM builder), `run <name>` (start a run), `list` (show available definitions and active runs), `pause` (stop active run), `resume` (continue paused run), `validate <file>` (check YAML against schema).
- Class: launchability
- Status: active
- Description: `/gsd workflow` subcommands provide the full lifecycle: `new` (LLM builder), `run <name>` (start a run), `list` (show available definitions and active runs), `pause` (stop active run), `resume` (continue paused run), `validate <file>` (check YAML against schema).
- Why it matters: CLI is the primary interface. Without it, workflows can't be discovered, started, or managed.
- Source: user
- Primary owning slice: M001/S07
- Supporting slices: M001/S08
- Validation: unmapped
- Notes: Commands register via the existing pi extension command system.

### R014 — The health widget / footer progress area shows custom workflow progress: current step name, step N/M fraction, and status. Uses `engine.getDisplayMetadata()`.
- Class: primary-user-loop
- Status: active
- Description: The health widget / footer progress area shows custom workflow progress: current step name, step N/M fraction, and status. Uses `engine.getDisplayMetadata()`.
- Why it matters: Without progress visibility, custom workflows feel like a black box.
- Source: user
- Primary owning slice: M001/S08
- Supporting slices: none
- Validation: unmapped
- Notes: Reuses existing TUI patterns from the dev workflow dashboard.

### R015 — The full user journey works: describe a workflow → LLM builds YAML → run it → steps execute with verification and context continuity → workflow completes. This is the integration test.
- Class: launchability
- Status: active
- Description: The full user journey works: describe a workflow → LLM builds YAML → run it → steps execute with verification and context continuity → workflow completes. This is the integration test.
- Why it matters: Individual pieces working doesn't mean the whole thing works. End-to-end validation is the real proof.
- Source: user
- Primary owning slice: M001/S08
- Supporting slices: M001/S04, M001/S05, M001/S06, M001/S07
- Validation: unmapped
- Notes: Must exercise iteration, context_from, at least two verification policy types, and dashboard progress.

### R017 — The `/gsd start` command, `registry.json`, workflow-templates `.md` files, and `STATE.json` tracking continue to work exactly as before. The two systems coexist.
- Class: constraint
- Status: active
- Description: The `/gsd start` command, `registry.json`, workflow-templates `.md` files, and `STATE.json` tracking continue to work exactly as before. The two systems coexist.
- Why it matters: Existing users of workflow-templates shouldn't be disrupted. Migration is a future concern.
- Source: inferred
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Uses `workflow-defs/` namespace to avoid collision with existing `workflows/` directory.

## Validated

### R004 — The existing dev workflow (milestones/slices/tasks, `deriveState()`, `DISPATCH_RULES[]`, auto-commit, doctor, worktree sync) is wrapped in a `DevWorkflowEngine` that implements the `WorkflowEngine` interface. All 172 existing tests pass identically.
- Class: core-capability
- Status: validated
- Description: The existing dev workflow (milestones/slices/tasks, `deriveState()`, `DISPATCH_RULES[]`, auto-commit, doctor, worktree sync) is wrapped in a `DevWorkflowEngine` that implements the `WorkflowEngine` interface. All 172 existing tests pass identically.
- Why it matters: The dev workflow is the production workhorse. If the abstraction breaks it, the project fails.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: S02 T01: DevWorkflowEngine class in dev-workflow-engine.ts implements WorkflowEngine, delegates deriveState() to state.ts:deriveState() and resolveDispatch() to auto-dispatch.ts:resolveDispatch() with bridgeDispatchAction conversion. S02 T02: Wired into dispatchNextUnit() at 4 sites — resolveEngine(s) at entry, engine.deriveState() for initial derivation, engine.resolveDispatch() for dispatch resolution. All 1590 tests pass identically (1 pre-existing fail L001, 3 skipped). 18-assertion contract test validates all shapes.
- Notes: Zero behavior change is a hard constraint. Test suite is the verification.

### R005 — A `resolveEngine()` function in the auto-loop checks an `active-engine` file to determine whether to use `DevWorkflowEngine` or `CustomWorkflowEngine`. Defaults to dev when no pointer exists.
- Class: core-capability
- Status: validated
- Description: A `resolveEngine()` function in the auto-loop checks an `active-engine` file to determine whether to use `DevWorkflowEngine` or `CustomWorkflowEngine`. Defaults to dev when no pointer exists.
- Why it matters: This is the switching mechanism. Without it, only one engine can run.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M001/S03
- Validation: S02 T01: resolveEngine() returns DevWorkflowEngine for null/"dev". S03 T01: resolveEngine() gains "custom:*" branch — extracts runDir, returns CustomWorkflowEngine + CustomExecutionPolicy. S03 T02: Integration test proves "custom:/tmp/test" returns correct engine/policy pair, bare "custom" and "bogus" still throw. 19/19 contract test assertions pass, 11/11 integration test assertions pass. Full suite 1602 pass, zero regressions.
- Notes: `active-engine` file acts as a mutex — one active engine at a time.

### R016 — The existing dev workflow (milestones/slices/tasks) must be identical before and after the interface extraction. All 172 existing tests pass. No behavior change in state derivation, dispatch, post-unit processing, verification, or worktree management.
- Class: constraint
- Status: validated
- Description: The existing dev workflow (milestones/slices/tasks) must be identical before and after the interface extraction. All 172 existing tests pass. No behavior change in state derivation, dispatch, post-unit processing, verification, or worktree management.
- Why it matters: The dev workflow is production. Regressions are unacceptable.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S02
- Validation: S01: 1862 unit tests pass (1 pre-existing macOS symlink fail — L001), 23 integration tests pass (6 pre-existing version mismatch fails — L002). Zero new failures. All S01 files are additive types with no behavioral changes. Typecheck passes with 0 errors.
- Notes: Non-negotiable hard constraint. Test suite is the primary verification mechanism.

## Deferred

### R018 — Steps with no dependency relationship execute in parallel rather than serially.
- Class: core-capability
- Status: deferred
- Description: Steps with no dependency relationship execute in parallel rather than serially.
- Why it matters: Performance for workflows with independent steps.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: V1 is serial. Parallel adds concurrency complexity and harder crash recovery. Defer until serial is proven.

### R019 — A step can invoke another workflow definition as a sub-workflow.
- Class: core-capability
- Status: deferred
- Description: A step can invoke another workflow definition as a sub-workflow.
- Why it matters: Enables workflow reuse and nesting.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: ADR leans no for V1. Composition adds complexity with unclear benefit until base workflows are proven.

### R020 — A registry for discovering and installing community-created workflow definitions.
- Class: differentiator
- Status: deferred
- Description: A registry for discovering and installing community-created workflow definitions.
- Why it matters: Network effects and community value.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: V1 sharing is manual (copy YAML files). Registry is a product decision, not an engineering one.

### R021 — Custom workflows can opt into worktree isolation per-run via `isolation: worktree` in the definition.
- Class: quality-attribute
- Status: deferred
- Description: Custom workflows can opt into worktree isolation per-run via `isolation: worktree` in the definition.
- Why it matters: Isolation prevents custom workflow artifacts from polluting the main working tree.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: V1 runs in project root, no isolation. DevWorkflowEngine continues using worktrees per milestone.

### R022 — Steps can declare `when:` conditions evaluated by the engine from artifact/filesystem state.
- Class: core-capability
- Status: deferred
- Description: Steps can declare `when:` conditions evaluated by the engine from artifact/filesystem state.
- Why it matters: Dynamic workflows that skip or include steps based on prior results.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: V1: all declared steps execute. Conditions must be deterministic from disk state, not LLM output.

## Out of Scope

### R023 — Replacing the `while (s.active)` loop with a concurrent DAG scheduler.
- Class: anti-feature
- Status: out-of-scope
- Description: Replacing the `while (s.active)` loop with a concurrent DAG scheduler.
- Why it matters: Prevents scope creep into a fundamentally different architecture. The linear loop is the durable asset.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: The graph lives in durable state (GRAPH.yaml), not in the control flow. Serial dispatch from a graph is the design.

### R024 — Representing custom workflow steps as milestones, slices, or tasks in the dev hierarchy.
- Class: anti-feature
- Status: out-of-scope
- Description: Representing custom workflow steps as milestones, slices, or tasks in the dev hierarchy.
- Why it matters: Poisons the type system and UI with wrong abstractions.
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: ADR explicitly rejected this approach.

### R025 — Converting existing workflow-templates (bugfix, spike, hotfix, etc.) to YAML workflow definitions.
- Class: constraint
- Status: out-of-scope
- Description: Converting existing workflow-templates (bugfix, spike, hotfix, etc.) to YAML workflow definitions.
- Why it matters: Prevents unnecessary scope expansion. The two systems serve different use cases.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: User explicitly chose coexistence over migration.

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | active | M001/S01 | M001/S02 | S01: WorkflowEngine interface defined in workflow-engine.ts with engineId + deriveState/resolveDispatch/reconcile/getDisplayMetadata. Compiles cleanly. Contract test validates shape (19/19 pass). Not yet wired — S02 implements. |
| R002 | core-capability | active | M001/S01 | M001/S02 | S01: ExecutionPolicy interface defined in execution-policy.ts with prepareWorkspace/selectModel/verify/recover/closeout. Compiles cleanly. Contract test validates shape. Not yet wired — S02 implements. |
| R003 | quality-attribute | active | M001/S01 | none | S01: 10 role-based sub-interfaces in loop-deps-groups.ts covering all 58 modules imported by auto.ts. Composite LoopDeps interface groups all 10. Contract test validates count and group keys. Not yet consumed — S02 uses for engine construction. |
| R004 | core-capability | validated | M001/S02 | none | S02 T01: DevWorkflowEngine class in dev-workflow-engine.ts implements WorkflowEngine, delegates deriveState() to state.ts:deriveState() and resolveDispatch() to auto-dispatch.ts:resolveDispatch() with bridgeDispatchAction conversion. S02 T02: Wired into dispatchNextUnit() at 4 sites — resolveEngine(s) at entry, engine.deriveState() for initial derivation, engine.resolveDispatch() for dispatch resolution. All 1590 tests pass identically (1 pre-existing fail L001, 3 skipped). 18-assertion contract test validates all shapes. |
| R005 | core-capability | validated | M001/S02 | M001/S03 | S02 T01: resolveEngine() returns DevWorkflowEngine for null/"dev". S03 T01: resolveEngine() gains "custom:*" branch — extracts runDir, returns CustomWorkflowEngine + CustomExecutionPolicy. S03 T02: Integration test proves "custom:/tmp/test" returns correct engine/policy pair, bare "custom" and "bogus" still throw. 19/19 contract test assertions pass, 11/11 integration test assertions pass. Full suite 1602 pass, zero regressions. |
| R006 | core-capability | active | M001/S04 | M001/S07 | S04 T01: definition-loader.ts implements V1 YAML schema with validateDefinition() enforcing version===1, name required, steps non-empty with id/name/prompt, produces paths reject ".." traversal. Unknown fields silently accepted for forward compatibility. loadDefinition() handles snake_case→camelCase conversion (depends_on→requires, context_from→contextFrom). S04 T03: Integration test proves YAML file loads, validates, and feeds full dispatch cycle. 13 unit tests + 4 integration tests pass. Parameterization via {{variable}} deferred to S07. |
| R007 | continuity | active | M001/S04 | none | S04 T02: createRun() in run-manager.ts uses copyFileSync for exact byte-copy of source YAML into run directory as DEFINITION.yaml. S04 T03: Integration test "DEFINITION.yaml snapshot is immune to source modification" proves source YAML modified after createRun still has original bytes in run dir. 4/4 integration tests pass. |
| R008 | core-capability | active | M001/S04 | M001/S06 | S03 T01: graph.ts implements GRAPH.yaml read/write with atomic writes (tmp + renameSync), step status tracking (pending→active→complete), topological dispatch order via getNextPendingStep(). S04 T01: graphFromDefinition() converts validated WorkflowDefinition into WorkflowGraph with all steps pending. S04 T02: createRun() generates initial GRAPH.yaml from definition via graphFromDefinition()+writeGraph(). S04 T03: Integration test proves full pipeline — YAML definition→createRun→3-step dispatch cycle→all steps complete with on-disk GRAPH.yaml verification. 11/11 engine tests + 4/4 integration tests pass. |
| R009 | primary-user-loop | active | M001/S05 | none | unmapped |
| R010 | failure-visibility | active | M001/S05 | none | unmapped |
| R011 | core-capability | active | M001/S06 | none | unmapped |
| R012 | primary-user-loop | active | M001/S07 | none | unmapped |
| R013 | launchability | active | M001/S07 | M001/S08 | unmapped |
| R014 | primary-user-loop | active | M001/S08 | none | unmapped |
| R015 | launchability | active | M001/S08 | M001/S04, M001/S05, M001/S06, M001/S07 | unmapped |
| R016 | constraint | validated | M001/S01 | M001/S02 | S01: 1862 unit tests pass (1 pre-existing macOS symlink fail — L001), 23 integration tests pass (6 pre-existing version mismatch fails — L002). Zero new failures. All S01 files are additive types with no behavioral changes. Typecheck passes with 0 errors. |
| R017 | constraint | active | M001/S02 | none | unmapped |
| R018 | core-capability | deferred | none | none | unmapped |
| R019 | core-capability | deferred | none | none | unmapped |
| R020 | differentiator | deferred | none | none | unmapped |
| R021 | quality-attribute | deferred | none | none | unmapped |
| R022 | core-capability | deferred | none | none | unmapped |
| R023 | anti-feature | out-of-scope | none | none | n/a |
| R024 | anti-feature | out-of-scope | none | none | n/a |
| R025 | constraint | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 14
- Mapped to slices: 14
- Validated: 3 (R004, R005, R016)
- Unmapped active requirements: 0
