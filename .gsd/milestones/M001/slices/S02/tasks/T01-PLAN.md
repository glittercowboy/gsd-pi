---
estimated_steps: 6
estimated_files: 4
---

# T01: Create DevWorkflowEngine, DevExecutionPolicy, and engine resolver with contract tests

**Slice:** S02 — DevWorkflowEngine + Engine Resolution
**Milestone:** M001

## Description

Create three new implementation files that wrap existing GSD auto-mode functions behind the S01 `WorkflowEngine` and `ExecutionPolicy` interfaces, plus an engine resolver that determines which engine to use. All files are additive — no existing code is modified. A contract test validates interface satisfaction, bridge logic, and resolver behavior.

Key design constraints:
- `engine-types.ts` is a zero-import leaf node — never add imports to it
- `EngineDispatchAction` and `DispatchAction` (in `auto-dispatch.ts`) are separate types — `DevWorkflowEngine.resolveDispatch()` must bridge between them
- `EngineState.raw` is typed as `unknown` — the engine stuffs `GSDState` into it, the caller casts back
- `DevWorkflowEngine.reconcile()` is a simple pass-through for S02 — full delegation is S03+
- `resolveDispatch()` in `auto-dispatch.ts` requires a `DispatchContext` with `basePath`, `mid`, `midTitle`, `state`, `prefs` — the engine must reconstruct this from `EngineState.raw` (which is `GSDState`)
- `DevExecutionPolicy` methods delegate to existing functions but don't need to be wired into the loop yet — that's S03+
- Per the S01 forward intelligence, the sub-interface method signatures are hand-written and may have drifted — verify alignment first

**Relevant skills:** None needed — pure TypeScript implementation against known interfaces.

## Steps

1. **Verify S01 interface alignment.** Quick signature comparison: check that `deriveState` in `state.ts` still returns `Promise<GSDState>`, `resolveDispatch` in `auto-dispatch.ts` still takes `DispatchContext` and returns `Promise<DispatchAction>`, `selectAndApplyModel` in `auto-model-selection.ts` exists, `runPostUnitVerification` in `auto-verification.ts` exists, `closeoutUnit` in `auto-unit-closeout.ts` exists. If any signature drifted, note it and adapt.

2. **Create `dev-workflow-engine.ts`.** Implement `DevWorkflowEngine` class:
   - `readonly engineId = "dev"`
   - `deriveState(basePath: string): Promise<EngineState>` — calls `deriveState(basePath)` from `state.ts`, maps result: `{ phase: gsdState.phase, currentMilestoneId: gsdState.activeMilestone?.id ?? null, activeSliceId: gsdState.activeSlice?.id ?? null, activeTaskId: gsdState.activeTask?.id ?? null, isComplete: gsdState.phase === "complete", raw: gsdState }`
   - `resolveDispatch(state: EngineState, context: { basePath: string }): Promise<EngineDispatchAction>` — extracts `GSDState` from `state.raw`, loads prefs via `loadEffectiveGSDPreferences()`, constructs `DispatchContext { basePath, mid: gsdState.activeMilestone.id, midTitle: gsdState.activeMilestone.title, state: gsdState, prefs }`, calls `resolveDispatch()` from `auto-dispatch.ts`, bridges result: if `action === "dispatch"` → `{ action: "dispatch", step: { unitType, unitId, prompt } }`, if `action === "stop"` → passthrough with `level`, if `action === "skip"` → `{ action: "skip" }`
   - `reconcile(state: EngineState, completedStep: CompletedStep): Promise<ReconcileResult>` — returns `{ outcome: state.isComplete ? "milestone-complete" : "continue" }` (simple pass-through for S02)
   - `getDisplayMetadata(state: EngineState): DisplayMetadata` — extracts from `GSDState`: `{ engineLabel: "GSD Dev", currentPhase: gsdState.phase, progressSummary: buildProgressSummary(gsdState), stepCount: buildStepCount(gsdState) }`
   - Handle the case where `activeMilestone` is null in `resolveDispatch` — return `{ action: "stop", reason: "No active milestone", level: "info" }` (matches existing behavior in `auto.ts`)

3. **Create `dev-execution-policy.ts`.** Implement `DevExecutionPolicy` class:
   - `prepareWorkspace(basePath, milestoneId)` — stub that returns `Promise<void>` (actual workspace prep is deeply entangled with `auto.ts` session state; full delegation is S03+)
   - `selectModel(unitType, unitId, context)` — stub returning `null` (model selection is session-entangled; actual delegation happens when the loop is fully refactored)
   - `verify(unitType, unitId, context)` — stub returning `"continue"` (verification pipeline stays in `handleAgentEnd` for S02)
   - `recover(unitType, unitId, context)` — stub returning `{ outcome: "retry" }` (recovery stays in existing code paths for S02)
   - `closeout(unitType, unitId, context)` — stub returning `{ committed: false, artifacts: [] }` (closeout stays in existing code paths for S02)
   - Note: These stubs satisfy the interface contract. The methods will get real implementations when `handleAgentEnd` is refactored in S03+. For S02, only `deriveState` and `resolveDispatch` are wired into the loop.

4. **Create `engine-resolver.ts`.** Implement:
   - `resolveEngine(session: { activeEngineId: string | null }): { engine: DevWorkflowEngine; policy: DevExecutionPolicy }` — when `activeEngineId` is null or `"dev"`, returns `{ engine: new DevWorkflowEngine(), policy: new DevExecutionPolicy() }`. For any other value, throws an error with message like `Unknown engine: ${id}` (custom engine routing is S03+).
   - Export type `ResolvedEngine = { engine: WorkflowEngine; policy: ExecutionPolicy }`

5. **Create `dev-engine-contract.test.ts`.** Contract tests using Node.js built-in test runner:
   - **DevWorkflowEngine shape**: has `engineId`, `deriveState`, `resolveDispatch`, `reconcile`, `getDisplayMetadata`
   - **DevExecutionPolicy shape**: has `prepareWorkspace`, `selectModel`, `verify`, `recover`, `closeout`
   - **Engine ID**: `new DevWorkflowEngine().engineId === "dev"`
   - **Resolver null path**: `resolveEngine({ activeEngineId: null })` returns engine with `engineId === "dev"`
   - **Resolver "dev" path**: `resolveEngine({ activeEngineId: "dev" })` returns engine with `engineId === "dev"`
   - **Resolver unknown throws**: `resolveEngine({ activeEngineId: "custom" })` throws
   - **DispatchAction bridge**: verify the shape transformation from `DispatchAction` to `EngineDispatchAction` (if a bridge function is exported for testing)
   - **Policy stubs**: verify each policy method returns expected stub values
   - Use `import()` for module resolution, direct instantiation for shape tests

6. **Typecheck.** Run `npx tsc --noEmit --project tsconfig.extensions.json` — must show 0 errors.

## Must-Haves

- [ ] `DevWorkflowEngine` implements `WorkflowEngine` interface with correct `engineId` and all 4 methods
- [ ] `DevWorkflowEngine.deriveState()` calls `state.ts:deriveState()` and maps `GSDState` → `EngineState` correctly
- [ ] `DevWorkflowEngine.resolveDispatch()` bridges `DispatchAction` → `EngineDispatchAction` correctly
- [ ] `DevExecutionPolicy` implements `ExecutionPolicy` interface with all 5 methods (stubs for S02)
- [ ] `resolveEngine()` returns `DevWorkflowEngine` for null and "dev", throws for unknown
- [ ] Contract test validates all shapes and behaviors
- [ ] Typecheck passes with 0 errors
- [ ] `engine-types.ts` leaf-node constraint preserved (0 local imports)

## Verification

- `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/dev-engine-contract.test.ts` — all assertions pass
- `grep -c "from './" src/resources/extensions/gsd/engine-types.ts` returns 0
- Existing test files unmodified (no `git diff` on test files other than the new one)

## Inputs

- `src/resources/extensions/gsd/workflow-engine.ts` — `WorkflowEngine` interface from S01
- `src/resources/extensions/gsd/execution-policy.ts` — `ExecutionPolicy` interface from S01
- `src/resources/extensions/gsd/engine-types.ts` — `EngineState`, `EngineDispatchAction`, `StepContract`, `CompletedStep`, `ReconcileResult`, `DisplayMetadata`, `RecoveryAction`, `CloseoutResult` from S01
- `src/resources/extensions/gsd/state.ts` — `deriveState(basePath: string): Promise<GSDState>`
- `src/resources/extensions/gsd/auto-dispatch.ts` — `resolveDispatch(ctx: DispatchContext): Promise<DispatchAction>`, `DispatchAction` type, `DispatchContext` interface
- `src/resources/extensions/gsd/types.ts` — `GSDState`, `ActiveRef`, `Phase` types
- `src/resources/extensions/gsd/preferences.ts` — `loadEffectiveGSDPreferences()`
- `src/resources/extensions/gsd/auto/session.ts` — `AutoSession` with `activeEngineId: string | null`

## Expected Output

- `src/resources/extensions/gsd/dev-workflow-engine.ts` — `DevWorkflowEngine` class (~80-120 lines)
- `src/resources/extensions/gsd/dev-execution-policy.ts` — `DevExecutionPolicy` class (~50-70 lines)
- `src/resources/extensions/gsd/engine-resolver.ts` — `resolveEngine()` function + `ResolvedEngine` type (~30-50 lines)
- `src/resources/extensions/gsd/tests/dev-engine-contract.test.ts` — contract test (~100-150 lines)
