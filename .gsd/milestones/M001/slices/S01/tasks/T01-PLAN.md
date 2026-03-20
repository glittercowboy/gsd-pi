---
estimated_steps: 5
estimated_files: 3
---

# T01: Define engine types, WorkflowEngine interface, and ExecutionPolicy interface

**Slice:** S01 — Interface Extraction + LoopDeps Decomposition
**Milestone:** M001

## Description

Create the three core interface files that define the WorkflowEngine and ExecutionPolicy abstractions (R001, R002). These are pure type files that serve as the contract between the auto-loop and workflow implementations. `engine-types.ts` is a leaf node — it must NOT import from any existing GSD module to prevent import cycles. `workflow-engine.ts` and `execution-policy.ts` import only from `engine-types.ts`.

**Relevant skills:** None required — this is pure TypeScript interface work.

The method signatures are derived from analysis of the existing auto-mode functions:
- `WorkflowEngine.deriveState()` → wraps `deriveState()` from `state.ts`
- `WorkflowEngine.resolveDispatch()` → wraps `resolveDispatch()` from `auto-dispatch.ts`
- `WorkflowEngine.reconcile()` → wraps post-unit state transitions in `auto-post-unit.ts`
- `WorkflowEngine.getDisplayMetadata()` → wraps dashboard widget data from `auto-dashboard.ts`
- `ExecutionPolicy.prepareWorkspace()` → wraps worktree setup from `auto-worktree.ts` and `auto-start.ts`
- `ExecutionPolicy.selectModel()` → wraps `selectAndApplyModel()` from `auto-model-selection.ts`
- `ExecutionPolicy.verify()` → wraps `runPostUnitVerification()` from `auto-verification.ts`
- `ExecutionPolicy.recover()` → wraps recovery logic from `auto-recovery.ts`, `auto-stuck-detection.ts`
- `ExecutionPolicy.closeout()` → wraps `closeoutUnit()` from `auto-unit-closeout.ts` and post-unit hooks

## Steps

1. Create `src/resources/extensions/gsd/engine-types.ts` with these types:
   - `EngineState` — generic engine state with fields: `phase: string`, `currentMilestoneId: string | null`, `activeSliceId: string | null`, `activeTaskId: string | null`, `isComplete: boolean`, `raw: unknown` (carries the engine-specific full state, e.g. `GSDState` for dev). Keep it deliberately minimal — S02 proves whether more fields are needed.
   - `StepContract` — what a step/unit must satisfy: `unitType: string`, `unitId: string`, `prompt: string`
   - `DisplayMetadata` — TUI display data: `engineLabel: string`, `currentPhase: string`, `progressSummary: string`, `stepCount: { completed: number; total: number } | null`
   - `EngineDispatchAction` — engine-polymorphic dispatch: `{ action: "dispatch"; step: StepContract } | { action: "stop"; reason: string; level: "info" | "warning" | "error" } | { action: "skip" }`. This is separate from the existing `DispatchAction` in `auto-dispatch.ts` to avoid import cycles.
   - `ReconcileResult` — `{ outcome: "continue" | "milestone-complete" | "pause" | "stop"; reason?: string }`
   - `RecoveryAction` — `{ outcome: "retry" | "skip" | "stop" | "pause"; reason?: string }`
   - `CloseoutResult` — `{ committed: boolean; artifacts: string[] }`
   - `CompletedStep` — `{ unitType: string; unitId: string; startedAt: number; finishedAt: number }`

2. Create `src/resources/extensions/gsd/workflow-engine.ts` with the `WorkflowEngine` interface:
   - `deriveState(basePath: string): Promise<EngineState>`
   - `resolveDispatch(state: EngineState, context: { basePath: string }): Promise<EngineDispatchAction>`
   - `reconcile(state: EngineState, completedStep: CompletedStep): Promise<ReconcileResult>`
   - `getDisplayMetadata(state: EngineState): DisplayMetadata`
   - Add a `readonly engineId: string` property for identification (e.g., "dev", "custom")

3. Create `src/resources/extensions/gsd/execution-policy.ts` with the `ExecutionPolicy` interface:
   - `prepareWorkspace(basePath: string, milestoneId: string): Promise<void>`
   - `selectModel(unitType: string, unitId: string, context: { basePath: string }): Promise<{ tier: string; modelDowngraded: boolean } | null>`
   - `verify(unitType: string, unitId: string, context: { basePath: string }): Promise<"continue" | "retry" | "pause">`
   - `recover(unitType: string, unitId: string, context: { basePath: string }): Promise<RecoveryAction>`
   - `closeout(unitType: string, unitId: string, context: { basePath: string; startedAt: number }): Promise<CloseoutResult>`

4. Run `npx tsc --noEmit` to verify all three files compile cleanly.

5. Verify no import cycles: confirm `engine-types.ts` has zero import statements referencing `./` paths (only `node:` or no imports at all).

## Must-Haves

- [ ] `engine-types.ts` is a leaf file — zero imports from existing GSD modules
- [ ] `workflow-engine.ts` imports only from `engine-types.ts`
- [ ] `execution-policy.ts` imports only from `engine-types.ts`
- [ ] All three files compile cleanly with `npx tsc --noEmit`
- [ ] `EngineDispatchAction` is a separate type from the existing `DispatchAction` in `auto-dispatch.ts`
- [ ] Method signatures are grounded in the actual functions they will wrap (documented in JSDoc)

## Verification

- `npx tsc --noEmit` completes with no errors
- `grep -c "from './" src/resources/extensions/gsd/engine-types.ts` returns 0

## Inputs

- S01-RESEARCH.md analysis of `deriveState()`, `resolveDispatch()`, `runPostUnitVerification()`, `selectAndApplyModel()`, and `closeoutUnit()` function signatures
- Existing `DispatchAction` type in `auto-dispatch.ts` (line 40): `{ action: "dispatch"; unitType: string; unitId: string; prompt: string } | { action: "stop"; ... } | { action: "skip" }`
- Existing `ModelSelectionResult` in `auto-model-selection.ts` (line 15): `{ routing: { tier: string; modelDowngraded: boolean } | null }`
- Existing `VerificationResult` in `auto-verification.ts` (line 37): `"continue" | "retry" | "pause"`
- Existing `CompletedUnit` in `auto/session.ts` (line 27): `{ type: string; id: string; startedAt: number; finishedAt: number }`

## Expected Output

- `src/resources/extensions/gsd/engine-types.ts` — 8 type/interface definitions, zero GSD imports
- `src/resources/extensions/gsd/workflow-engine.ts` — `WorkflowEngine` interface with 4 methods + `engineId` property
- `src/resources/extensions/gsd/execution-policy.ts` — `ExecutionPolicy` interface with 5 methods

## Observability Impact

- **No runtime signals change.** These are pure type files erased at runtime by `--experimental-strip-types`. No logs, metrics, or state transitions are affected.
- **Future agent inspection:** To verify these interfaces are correct, run `npx tsc --noEmit --project tsconfig.extensions.json`. To check the leaf-node constraint: `grep -c "from './" src/resources/extensions/gsd/engine-types.ts` must return 0.
- **Failure visibility:** If a downstream task imports these types incorrectly, the typecheck will emit errors pointing to the exact line. No runtime failure is possible from pure type files.
