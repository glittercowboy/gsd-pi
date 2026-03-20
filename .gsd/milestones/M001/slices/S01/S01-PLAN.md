# S01: Interface Extraction + LoopDeps Decomposition

**Goal:** Define the `WorkflowEngine`, `ExecutionPolicy`, and decomposed LoopDeps sub-interfaces as additive TypeScript files alongside the existing auto-mode code, with zero behavior change to the existing system.
**Demo:** All 217+ existing tests pass. New interface files compile cleanly. Each engine/policy method maps to existing functions. Sub-interface groups cover all 45+ imports in `auto.ts`.

## Must-Haves

- `WorkflowEngine` interface with `deriveState()`, `resolveDispatch()`, `reconcile()`, `getDisplayMetadata()` methods
- `ExecutionPolicy` interface with `prepareWorkspace()`, `selectModel()`, `verify()`, `recover()`, `closeout()` methods
- Engine-polymorphic types: `EngineState`, `StepContract`, `DisplayMetadata`, `EngineDispatchAction`
- Role-based sub-interfaces in `loop-deps-groups.ts` covering all dependency clusters in `auto.ts`
- `AutoSession.activeEngineId` field with `reset()` and `toJSON()` coverage
- All existing tests pass with zero behavior change
- New files compile cleanly under `--experimental-strip-types`

## Proof Level

- This slice proves: contract (interfaces compile, existing tests pass, no behavior change)
- Real runtime required: no (additive types only, verified by type-checking and existing test suite)
- Human/UAT required: no

## Verification

- `npx tsc --noEmit` — all new files compile cleanly with no type errors
- `npm run test:unit` — all unit tests pass identically
- `npm run test:integration` — all integration tests pass identically
- `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` — new test file that verifies:
  - All interface files are importable
  - `EngineState` extends `GSDState` properly
  - Sub-interface groups collectively cover the dependency surface
  - `AutoSession.activeEngineId` exists and is covered by `reset()` and `toJSON()`

## Integration Closure

- Upstream surfaces consumed: `types.ts` (`GSDState`, `Phase`), `auto-dispatch.ts` (`DispatchAction`, `DispatchContext`), `auto-model-selection.ts` (`ModelSelectionResult`), `auto-verification.ts` (`VerificationResult`), `auto/session.ts` (`AutoSession`, `CompletedUnit`)
- New wiring introduced in this slice: none — interfaces are additive, not wired into `auto.ts` yet
- What remains before the milestone is truly usable end-to-end: S02 builds `DevWorkflowEngine` implementing these interfaces and wires the auto-loop to call engine methods polymorphically

## Tasks

- [x] **T01: Define engine types, WorkflowEngine interface, and ExecutionPolicy interface** `est:45m`
  - Why: These are the core abstractions (R001, R002) that enable pluggable workflows. They must exist before sub-interfaces or implementations can reference them. Pure type work with no imports from existing GSD modules (engine-types.ts is a leaf node).
  - Files: `src/resources/extensions/gsd/engine-types.ts`, `src/resources/extensions/gsd/workflow-engine.ts`, `src/resources/extensions/gsd/execution-policy.ts`
  - Do: Create `engine-types.ts` as a leaf file (no imports from existing GSD modules) with `EngineState`, `StepContract`, `DisplayMetadata`, `EngineDispatchAction`, `ReconcileResult`, `RecoveryAction`, `CloseoutResult`. Create `workflow-engine.ts` importing only from `engine-types.ts` with 4 methods. Create `execution-policy.ts` importing only from `engine-types.ts` with 5 methods. Method signatures must be grounded in research: `deriveState` returns `EngineState`, `resolveDispatch` returns `EngineDispatchAction`, etc. The `EngineDispatchAction` type is separate from the existing `DispatchAction` in `auto-dispatch.ts` to avoid import cycles — it will be the engine-polymorphic version that S02 bridges. Constraint: engine-types.ts must NOT import from any existing GSD module (`types.ts`, `auto-dispatch.ts`, etc.) to prevent import cycles.
  - Verify: `npx tsc --noEmit` passes with no errors from the new files
  - Done when: Three new files exist, compile cleanly, and have no imports from existing GSD modules except standard library types

- [ ] **T02: Define LoopDeps sub-interfaces and add activeEngineId to AutoSession** `est:1h`
  - Why: R003 requires decomposing the dependency surface into logical groups. The sub-interfaces formalize the 45+ imports in `auto.ts` into typed role-based contracts. Adding `activeEngineId` to `AutoSession` enables S02's engine resolution. This is the riskiest task — if the grouping is wrong it creates coupling that S02 has to undo.
  - Files: `src/resources/extensions/gsd/loop-deps-groups.ts`, `src/resources/extensions/gsd/auto/session.ts`
  - Do: Read all 66 import statements in `auto.ts` and group them into role-based sub-interfaces. Start with the grouping from research (GitOps, StateOps, DispatchOps, ModelOps, BudgetOps, VerificationOps, RecoveryOps, SupervisionOps, PostUnitOps, DashboardOps, SessionOps, ObservabilityOps, HealthOps) but merge groups that are too small or tightly coupled. Each sub-interface should have typed method signatures matching the actual exported functions from those modules. Import types from existing modules where needed (this file CAN import from existing GSD modules — it wraps them). Add `activeEngineId: string | null` to `AutoSession` with default `null`, add it to `reset()`, and add it to `toJSON()`. The encapsulation test (`auto-session-encapsulation.test.ts`) will verify `reset()` coverage automatically.
  - Verify: `npx tsc --noEmit` passes. `npm run test:unit -- --test-name-pattern "session-encapsulation"` passes (verifies AutoSession invariants).
  - Done when: `loop-deps-groups.ts` exists with typed sub-interfaces covering all dependency clusters, `AutoSession` has `activeEngineId` field passing encapsulation tests

- [ ] **T03: Write contract test and run full test suite verification** `est:30m`
  - Why: R016 requires zero behavior change proven by the test suite. A contract test validates the new interfaces are well-formed and importable. Running the full suite proves no regressions.
  - Files: `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts`
  - Do: Write a test file using Node.js built-in test runner that: (1) imports all four new files and asserts they export the expected interfaces/types, (2) verifies `EngineState` has the expected shape fields, (3) verifies `WorkflowEngine` and `ExecutionPolicy` method names exist as interface properties, (4) verifies `AutoSession` has `activeEngineId` field. Then run `npm run test:unit` and `npm run test:integration` to prove zero regressions. If any test fails, investigate and fix — the failure is a bug in T01/T02, not an expected outcome.
  - Verify: `npm test` (runs both unit and integration) passes with zero failures. The new contract test passes.
  - Done when: All tests pass including the new contract test. Zero regressions in existing test suite.

## Observability / Diagnostics

- **Typecheck signal:** `npx tsc --noEmit --project tsconfig.extensions.json` must report zero errors from new files. Any regression here means an import cycle or type incompatibility was introduced.
- **Test signal:** `npm run test:unit` and `npm run test:integration` pass count must match pre-slice baseline (217+ tests). A test count decrease indicates an import broke an existing module.
- **Contract test:** `engine-interfaces-contract.test.ts` validates importability and shape of all new interfaces. Failure indicates a broken export, missing type, or naming mismatch.
- **Import cycle detection:** `grep -c "from './" engine-types.ts` returning >0 means the leaf-node constraint is violated, which will cause circular dependency issues in S02.
- **Failure visibility:** All new types are pure interfaces with no runtime code. If `--experimental-strip-types` fails on these files, the error will appear in the test runner output (Node.js strip-types error). No runtime state or logs to inspect — compilation and test pass/fail are the only diagnostic signals.

## Files Likely Touched

- `src/resources/extensions/gsd/engine-types.ts` (new)
- `src/resources/extensions/gsd/workflow-engine.ts` (new)
- `src/resources/extensions/gsd/execution-policy.ts` (new)
- `src/resources/extensions/gsd/loop-deps-groups.ts` (new)
- `src/resources/extensions/gsd/auto/session.ts` (modified — add `activeEngineId`)
- `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` (new)
