# S01: Engine Abstraction Layer

**Goal:** `WorkflowEngine` and `ExecutionPolicy` interfaces exist with full type contracts and `EngineState`, `EngineDispatchAction`, `DisplayMetadata` types; `engine-resolver.ts` routes sessions to engine/policy pairs by engine ID; `AutoSession` has `activeEngineId` property.
**Demo:** Unit tests pass proving all interface shapes, leaf-node constraints, resolver stub behavior, and `activeEngineId` lifecycle.

## Must-Haves

- `engine-types.ts` is a leaf node — zero imports from any GSD module (only `node:` allowed)
- `EngineState` has fields: `phase`, `currentMilestoneId`, `activeSliceId`, `activeTaskId`, `isComplete`, `raw` (typed `unknown`)
- `EngineDispatchAction` has `dispatch`, `stop`, `skip` variants
- `StepContract`, `DisplayMetadata`, `CompletedStep`, `ReconcileResult`, `RecoveryAction`, `CloseoutResult` types exported
- `WorkflowEngine` interface has `engineId` readonly property and methods: `deriveState`, `resolveDispatch`, `reconcile`, `getDisplayMetadata`
- `ExecutionPolicy` interface has methods: `prepareWorkspace`, `selectModel`, `verify`, `recover`, `closeout`
- `workflow-engine.ts` and `execution-policy.ts` import only from `engine-types.ts`
- `engine-resolver.ts` exports `ResolvedEngine` type and `resolveEngine()` function; S01 version throws for any input (no implementations exist yet)
- `AutoSession.activeEngineId` defaults to `null`, is cleared in `reset()`, appears in `toJSON()`

## Proof Level

- This slice proves: contract
- Real runtime required: no
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` — all contract tests pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-session-encapsulation.test.ts` — existing encapsulation tests still pass (validates `activeEngineId` in `reset()`)
- `node --experimental-strip-types -e "import('./src/resources/extensions/gsd/engine-resolver.ts').then(m => { try { m.resolveEngine({ activeEngineId: null }); process.exit(1) } catch(e) { process.exit(0) } })"` — resolver throws for any input (failure-path diagnostic)

## Integration Closure

- Upstream surfaces consumed: none (first slice)
- New wiring introduced in this slice: none — pure type contracts and a stub resolver
- What remains before the milestone is truly usable end-to-end: S02 (dev engine wrapper), S03 (YAML schema), S04 (custom engine + loop integration), S05-S09

## Tasks

- [x] **T01: Create engine type contracts and interface files** `est:20m`
  - Why: Establishes the four foundational files that all subsequent slices depend on — the leaf-node types, the `WorkflowEngine` interface, the `ExecutionPolicy` interface, and the stub resolver
  - Files: `src/resources/extensions/gsd/engine-types.ts`, `src/resources/extensions/gsd/workflow-engine.ts`, `src/resources/extensions/gsd/execution-policy.ts`, `src/resources/extensions/gsd/engine-resolver.ts`
  - Do: Port the four files from `feat/declarative-workflow-engine-v2` branch. `engine-types.ts`, `workflow-engine.ts`, and `execution-policy.ts` are taken as-is. `engine-resolver.ts` must be modified — remove all implementation imports (`DevWorkflowEngine`, `DevExecutionPolicy`, `CustomWorkflowEngine`, `CustomExecutionPolicy`), keep only the `ResolvedEngine` type export and `resolveEngine()` function that throws `"No engines registered — S02 provides DevWorkflowEngine"` for any input. Verify `engine-types.ts` has zero imports from GSD modules.
  - Verify: `node -e "import('./src/resources/extensions/gsd/engine-types.ts')"` succeeds under `--experimental-strip-types`
  - Done when: all four files exist, parse cleanly, and `engine-types.ts` contains no `import` from `../` or `./` GSD paths

- [x] **T02: Add activeEngineId to AutoSession and write contract tests** `est:20m`
  - Why: Completes the slice by wiring `activeEngineId` into session lifecycle and proving all contracts via source-level assertion tests (the established pattern)
  - Files: `src/resources/extensions/gsd/auto/session.ts`, `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts`
  - Do: Add `activeEngineId: string | null = null` property to `AutoSession`. Add it to `reset()` (set to `null`) and `toJSON()`. Then write `engine-interfaces-contract.test.ts` following the same pattern as `auto-session-encapsulation.test.ts` — source-level regex assertions on all four new files plus runtime assertions on `AutoSession.activeEngineId` and `resolveEngine()` behavior.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` passes AND `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-session-encapsulation.test.ts` still passes
  - Done when: contract test file exists with assertions for all must-haves; both test suites pass with 0 failures

## Observability / Diagnostics

- **Resolver failure signal**: `resolveEngine()` throws with a structured message (`"No engines registered — S02 provides DevWorkflowEngine"`) that identifies the missing capability. Downstream callers can catch and surface this to the agent.
- **Inspection surface**: All four type files are pure declarations with no side effects. Correctness is verified by source-level contract tests (regex assertions on the file contents) — the test file itself is the diagnostic artifact.
- **Failure visibility**: If `engine-types.ts` gains a GSD import, the contract test fails with an explicit assertion naming the leaf-node constraint. If `resolveEngine()` stops throwing, the runtime assertion in the contract test catches it.
- **activeEngineId lifecycle**: `AutoSession.toJSON()` includes `activeEngineId`, making it visible in session snapshots and debug dumps.
- **Redaction**: No secrets or user data in these type contracts — no redaction needed.

## Files Likely Touched

- `src/resources/extensions/gsd/engine-types.ts` (new)
- `src/resources/extensions/gsd/workflow-engine.ts` (new)
- `src/resources/extensions/gsd/execution-policy.ts` (new)
- `src/resources/extensions/gsd/engine-resolver.ts` (new)
- `src/resources/extensions/gsd/auto/session.ts` (modify)
- `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` (new)
