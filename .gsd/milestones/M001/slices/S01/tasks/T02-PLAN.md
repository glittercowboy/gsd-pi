---
estimated_steps: 4
estimated_files: 2
skills_used:
  - test
---

# T02: Add activeEngineId to AutoSession and write contract tests

**Slice:** S01 — Engine Abstraction Layer
**Milestone:** M001

## Description

Add the `activeEngineId` property to `AutoSession` and write the contract test file that validates all S01 deliverables. The test uses source-level regex assertions (the established pattern from `auto-session-encapsulation.test.ts`) to verify interface shapes at test time, since TypeScript interfaces are erased by `--experimental-strip-types` at runtime.

The `activeEngineId` property follows the existing AutoSession maintenance rule: add as a class property, clear in `reset()`, include in `toJSON()`. The existing `auto-session-encapsulation.test.ts` will automatically validate that `activeEngineId` appears in `reset()` — that test must continue to pass.

## Steps

1. Modify `src/resources/extensions/gsd/auto/session.ts`:
   - Add `activeEngineId: string | null = null` property in the "Lifecycle" section (after `verbose`)
   - Add `this.activeEngineId = null;` in `reset()` under the "Lifecycle" comment block
   - Add `activeEngineId: this.activeEngineId,` in `toJSON()` return object

2. Run the existing encapsulation test to confirm it still passes with the new property: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-session-encapsulation.test.ts`

3. Create `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` with these test groups:

   **Import smoke tests** (4 tests):
   - Dynamic `import()` of `engine-types.ts` succeeds
   - Dynamic `import()` of `workflow-engine.ts` succeeds
   - Dynamic `import()` of `execution-policy.ts` succeeds
   - Dynamic `import()` of `engine-resolver.ts` succeeds

   **Leaf-node constraint** (1 test):
   - Read `engine-types.ts` source, assert zero `import` lines from `../` or `./` paths (only `node:` allowed)

   **EngineState shape** (1 test):
   - Regex on `engine-types.ts` source verifies fields: `phase`, `currentMilestoneId`, `activeSliceId`, `activeTaskId`, `isComplete`, `raw`
   - Verify `raw: unknown` (not a GSD-specific type)

   **EngineDispatchAction shape** (1 test):
   - Source contains `action: "dispatch"`, `action: "stop"`, `action: "skip"` variants

   **WorkflowEngine interface shape** (1 test):
   - Source contains `engineId`, `deriveState`, `resolveDispatch`, `reconcile`, `getDisplayMetadata`

   **ExecutionPolicy interface shape** (1 test):
   - Source contains `prepareWorkspace`, `selectModel`, `verify`, `recover`, `closeout`

   **Resolver stub behavior** (2 tests):
   - `resolveEngine({ activeEngineId: null })` throws with "No engines registered"
   - `resolveEngine({ activeEngineId: "dev" })` also throws (no engines in S01)
   - `ResolvedEngine` type is exported (source check)

   **AutoSession.activeEngineId** (3 tests):
   - `new AutoSession().activeEngineId` is `null` by default
   - After `reset()`, `activeEngineId` is `null`
   - `toJSON()` output includes `activeEngineId`

   Use `node:test` and `node:assert/strict`. Read source files using `readFileSync` relative to `__dirname`. Follow the exact conventions of `auto-session-encapsulation.test.ts`.

4. Run the contract test: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts`

## Must-Haves

- [ ] `activeEngineId` defaults to `null` on a fresh `AutoSession`
- [ ] `activeEngineId` is cleared to `null` in `reset()`
- [ ] `activeEngineId` appears in `toJSON()` output
- [ ] Existing `auto-session-encapsulation.test.ts` still passes (0 failures)
- [ ] Contract test covers all 4 new files with import smoke tests
- [ ] Contract test verifies leaf-node constraint on `engine-types.ts`
- [ ] Contract test verifies `resolveEngine()` throws in S01

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` — all tests pass, 0 failures
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-session-encapsulation.test.ts` — still passes, 0 failures

## Inputs

- `src/resources/extensions/gsd/auto/session.ts` — existing AutoSession class to modify
- `src/resources/extensions/gsd/engine-types.ts` — created by T01, validated by this test
- `src/resources/extensions/gsd/workflow-engine.ts` — created by T01, validated by this test
- `src/resources/extensions/gsd/execution-policy.ts` — created by T01, validated by this test
- `src/resources/extensions/gsd/engine-resolver.ts` — created by T01, validated by this test
- `src/resources/extensions/gsd/tests/auto-session-encapsulation.test.ts` — reference for test pattern

## Expected Output

- `src/resources/extensions/gsd/auto/session.ts` — modified with `activeEngineId` property
- `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` — new contract test file

## Observability Impact

- **activeEngineId in session snapshots**: `AutoSession.toJSON()` now includes `activeEngineId`, making the currently selected engine visible in diagnostic dumps and session JSON. A future agent can inspect `s.toJSON().activeEngineId` to determine which engine is driving the loop.
- **Contract test as diagnostic artifact**: `engine-interfaces-contract.test.ts` itself is the inspection surface — running it verifies all four engine files have the expected shapes, the leaf-node constraint holds, and the resolver still throws. Any shape drift will produce a named assertion failure identifying the specific contract violation.
- **Failure visibility**: If `activeEngineId` is removed from `reset()`, the existing `auto-session-encapsulation.test.ts` invariant 3 fails with an explicit message naming the missing property. If it's removed from `toJSON()`, the contract test's "appears in toJSON() output" assertion fails.
