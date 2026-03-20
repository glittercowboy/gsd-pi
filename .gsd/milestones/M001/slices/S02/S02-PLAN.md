# S02: DevWorkflowEngine + Engine Resolution

**Goal:** `resolveEngine()` in the auto-loop returns `DevWorkflowEngine`. The loop calls engine methods polymorphically for state derivation and dispatch resolution. All tests pass identically. Workflow-templates unaffected.
**Demo:** `dispatchNextUnit()` calls `resolveEngine(s)` → gets `DevWorkflowEngine` → calls `engine.deriveState()` and `engine.resolveDispatch()` → the existing dispatch table runs identically → all 1862+ unit tests and 23 integration tests pass with zero new failures.

## Must-Haves

- `DevWorkflowEngine` class implementing `WorkflowEngine` interface — delegates `deriveState()` to `state.ts:deriveState()`, `resolveDispatch()` to `auto-dispatch.ts:resolveDispatch()`, `reconcile()` returns pass-through result, `getDisplayMetadata()` builds from `GSDState`
- `DevExecutionPolicy` class implementing `ExecutionPolicy` interface — delegates each method to the corresponding existing function
- `engine-resolver.ts` with `resolveEngine(session)` returning `DevWorkflowEngine` when `activeEngineId` is null or "dev"
- `dispatchNextUnit()` in `auto.ts` calls `resolveEngine()` and uses engine methods for state derivation and dispatch resolution
- EngineDispatchAction ↔ DispatchAction bridge converts between the two type systems
- All 1862+ existing unit tests pass — zero new failures
- All 23 integration tests pass — zero new failures (pre-existing L001/L002 unchanged)
- Typecheck passes: `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors
- No files in the workflow-templates system are modified (R017)

## Proof Level

- This slice proves: integration — engine methods are called polymorphically in the real auto-loop
- Real runtime required: yes — the full test suite exercises the wired code path
- Human/UAT required: no

## Verification

- `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/dev-engine-contract.test.ts` — all contract tests pass (engine shape, policy shape, resolver logic, bridge correctness)
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/*.test.ts 2>&1 | tail -5` — all 1862+ unit tests pass, zero new failures vs S01 baseline
- `rg --files-without-match "dev-workflow-engine|dev-execution-policy|engine-resolver" src/resources/extensions/gsd/workflow-templates/` — workflow-templates directory has no references to new engine files (R017 coexistence)
- `grep -c "from './" src/resources/extensions/gsd/engine-types.ts` returns 0 — leaf-node constraint preserved

## Integration Closure

- Upstream surfaces consumed: `workflow-engine.ts` (WorkflowEngine interface), `execution-policy.ts` (ExecutionPolicy interface), `engine-types.ts` (EngineState, EngineDispatchAction, StepContract, CompletedStep, ReconcileResult, DisplayMetadata, RecoveryAction, CloseoutResult), `loop-deps-groups.ts` (sub-interfaces), `auto/session.ts` (AutoSession.activeEngineId)
- New wiring introduced in this slice: `dispatchNextUnit()` in `auto.ts` calls `resolveEngine()` → `engine.deriveState()` → `engine.resolveDispatch()` with EngineDispatchAction ↔ DispatchAction bridge
- What remains before the milestone is truly usable end-to-end: S03 (CustomWorkflowEngine), S04 (YAML definitions), S05-S08 (context, iteration, CLI, dashboard)

## Tasks

- [ ] **T01: Create DevWorkflowEngine, DevExecutionPolicy, and engine resolver with contract tests** `est:45m`
  - Why: Establishes the three new files that implement S01's interfaces by delegating to existing GSD functions. All additive — no existing files modified except the new test. This is the safe creation phase before T02's wiring.
  - Files: `src/resources/extensions/gsd/dev-workflow-engine.ts`, `src/resources/extensions/gsd/dev-execution-policy.ts`, `src/resources/extensions/gsd/engine-resolver.ts`, `src/resources/extensions/gsd/tests/dev-engine-contract.test.ts`
  - Do: (1) Verify S01 interface signatures still match existing function signatures — quick grep comparison. (2) Create `DevWorkflowEngine` implementing `WorkflowEngine`: `deriveState()` calls `state.ts:deriveState()` and maps `GSDState` → `EngineState`, `resolveDispatch()` reconstructs `DispatchContext` from `EngineState.raw` and bridges `DispatchAction` → `EngineDispatchAction`, `reconcile()` returns simple pass-through, `getDisplayMetadata()` builds from `GSDState`. (3) Create `DevExecutionPolicy` implementing `ExecutionPolicy`: each method delegates to the corresponding existing function. (4) Create `engine-resolver.ts` with `resolveEngine(session)` that returns `DevWorkflowEngine` for null/"dev" `activeEngineId`. (5) Create contract test validating interface satisfaction, bridge correctness, and resolver logic. (6) Typecheck passes.
  - Verify: `npx tsc --noEmit --project tsconfig.extensions.json` shows 0 errors AND `node --experimental-strip-types --test src/resources/extensions/gsd/tests/dev-engine-contract.test.ts` passes all assertions
  - Done when: All three implementation files compile, contract test passes, existing tests unaffected (no files modified)

- [ ] **T02: Wire resolveEngine into dispatchNextUnit and verify full regression** `est:30m`
  - Why: The critical integration step — modifies `auto.ts` to call engine methods polymorphically. This is where the abstraction becomes real. Must preserve identical behavior proven by the full test suite.
  - Files: `src/resources/extensions/gsd/auto.ts`
  - Do: (1) In `dispatchNextUnit()`, after the health gate and before `deriveState()` call, add `const engine = resolveEngine(s)`. (2) Replace `let state = await deriveState(s.basePath)` with `const engineState = await engine.deriveState(s.basePath); let state = engineState.raw as GSDState` — the raw GSDState is extracted for all existing code that uses `state` directly. (3) At the dispatch table call site (~line 1373), replace `await resolveDispatch({...})` with `await engine.resolveDispatch(engineState, { basePath: s.basePath })` and bridge the result back: extract `unitType`, `unitId`, `prompt` from the `EngineDispatchAction.step` field, preserve `action: "stop"` and `action: "skip"` handling identically. (4) Keep ALL other code in `dispatchNextUnit()` unchanged — budget, idempotency, stuck detection, supervision, session creation, hooks, and the entire `handleAgentEnd` pipeline stay as-is. (5) Do NOT modify the mid-function `state = await deriveState(s.basePath)` re-derivation calls (milestone transition, merge reconciliation) — only the initial derivation is routed through the engine. (6) Run full test suite and verify zero new failures.
  - Verify: `node --experimental-strip-types --test src/resources/extensions/gsd/tests/*.test.ts 2>&1 | tail -5` shows all 1862+ pass AND `npx tsc --noEmit --project tsconfig.extensions.json` shows 0 errors
  - Done when: `dispatchNextUnit()` uses `resolveEngine()` for initial state derivation and dispatch resolution, all 1862+ unit tests pass, all 23 integration tests pass, typecheck passes, zero behavior change

## Files Likely Touched

- `src/resources/extensions/gsd/dev-workflow-engine.ts` (new)
- `src/resources/extensions/gsd/dev-execution-policy.ts` (new)
- `src/resources/extensions/gsd/engine-resolver.ts` (new)
- `src/resources/extensions/gsd/tests/dev-engine-contract.test.ts` (new)
- `src/resources/extensions/gsd/auto.ts` (modified — dispatchNextUnit only)
