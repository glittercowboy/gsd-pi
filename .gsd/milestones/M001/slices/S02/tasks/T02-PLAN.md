---
estimated_steps: 5
estimated_files: 1
---

# T02: Wire resolveEngine into dispatchNextUnit and verify full regression

**Slice:** S02 — DevWorkflowEngine + Engine Resolution
**Milestone:** M001

## Description

Modify `dispatchNextUnit()` in `auto.ts` to call `resolveEngine()` and use engine methods for the initial state derivation and dispatch resolution. This is the critical integration step where the abstraction becomes real. The existing code paths remain as the internal implementation of `DevWorkflowEngine` methods — we're adding a layer of indirection, not rewriting logic. Every existing test must pass identically.

The modification scope is deliberately narrow — only two call sites change:
1. The initial `deriveState(s.basePath)` call becomes `engine.deriveState(s.basePath)` with `GSDState` extracted from `engineState.raw`
2. The `resolveDispatch({...})` call becomes `engine.resolveDispatch(engineState, { basePath: s.basePath })` with the result bridged back to the existing local variables

Everything else in `dispatchNextUnit()` stays exactly as-is: budget checks, idempotency, stuck detection, supervision, session creation, hooks, and the entire `handleAgentEnd` pipeline. The mid-function `state = await deriveState(s.basePath)` re-derivation calls (milestone transition, merge reconciliation) also stay as direct calls — they operate on the already-extracted `GSDState` and don't need engine routing.

**Critical constraint:** The `handleAgentEnd` → `postUnitPreVerification` → `runPostUnitVerification` → `postUnitPostVerification` pipeline is deeply entangled with `AutoSession` state mutations. Do NOT attempt to route this through engine/policy methods in this task. That's S03+ work.

**Relevant skills:** None needed — surgical modification of a single function.

## Steps

1. **Add imports to `auto.ts`.** At the top of the file, add: `import { resolveEngine } from "./engine-resolver.js";` and `import type { EngineState } from "./engine-types.js";`. Keep existing `deriveState` and `resolveDispatch` imports — they're still used by the mid-function re-derivation calls and by `DevWorkflowEngine` internally.

2. **Wire initial state derivation.** In `dispatchNextUnit()`, find the initial `deriveState` call (around line 1056, after `invalidateAllCaches()` and the health gate): Replace:
   ```
   let state = await deriveState(s.basePath);
   ```
   With:
   ```
   const { engine } = resolveEngine(s);
   const engineState = await engine.deriveState(s.basePath);
   let state = engineState.raw as GSDState;
   ```
   This preserves the `state` variable that all subsequent code uses. The `GSDState` import should already exist (verify — if not, it's in `types.ts`).

3. **Wire dispatch resolution.** Find the dispatch table call (around line 1373): Replace:
   ```
   const dispatchResult = await resolveDispatch({ basePath: s.basePath, mid, midTitle: midTitle!, state, prefs });
   ```
   With:
   ```
   const engineDispatch = await engine.resolveDispatch(engineState, { basePath: s.basePath });
   const dispatchResult = engineDispatch.action === "dispatch"
     ? { action: "dispatch" as const, unitType: engineDispatch.step.unitType, unitId: engineDispatch.step.unitId, prompt: engineDispatch.step.prompt }
     : engineDispatch.action === "stop"
       ? engineDispatch
       : { action: "skip" as const };
   ```
   This bridges `EngineDispatchAction` back to the shape that existing code expects (`DispatchAction`-like). The `engine` and `engineState` variables are in scope from step 2. Note: `engine.resolveDispatch()` internally calls `resolveDispatch()` from `auto-dispatch.ts` with a reconstructed `DispatchContext` — the chain is: `auto.ts` → `engine.resolveDispatch()` → `auto-dispatch.ts:resolveDispatch()`. The `mid`, `midTitle`, and `prefs` values are now supplied by the engine (from `EngineState.raw`) rather than by `auto.ts` directly. Verify that the engine's internal `DispatchContext` construction produces identical values.

4. **Handle engine scope for re-derivation calls.** The mid-function `state = await deriveState(s.basePath)` calls (milestone transition ~line 1148, merge reconciliation ~line 1217) stay as direct calls. After each, update `engineState` to stay consistent: `engineState = await engine.deriveState(s.basePath); state = engineState.raw as GSDState;` — OR — simpler: just declare `engineState` with `let` and reassign when `state` is re-derived. Actually, the simplest correct approach: change the initial `const engineState` to `let engineState` and after each `state = await deriveState(s.basePath)` re-derivation, manually construct the updated `engineState`: no — the engine should re-derive. Evaluate which approach is cleaner. The safest approach that preserves exact behavior: keep the direct `deriveState()` calls for re-derivation, and just update `engineState` to match: `engineState = { phase: state.phase, currentMilestoneId: state.activeMilestone?.id ?? null, activeSliceId: state.activeSlice?.id ?? null, activeTaskId: state.activeTask?.id ?? null, isComplete: state.phase === "complete", raw: state }`. This avoids calling engine.deriveState() multiple times and keeps the re-derivation paths identical to current behavior.

5. **Run full verification.** Execute in order:
   - `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors
   - `node --experimental-strip-types --test src/resources/extensions/gsd/tests/dev-engine-contract.test.ts` — contract tests still pass
   - `node --experimental-strip-types --test src/resources/extensions/gsd/tests/*.test.ts` — all 1862+ unit tests pass
   - Verify workflow-templates untouched: `rg "dev-workflow-engine|engine-resolver" src/resources/extensions/gsd/workflow-templates/ 2>/dev/null` returns empty
   - Verify leaf-node constraint: `grep -c "from './" src/resources/extensions/gsd/engine-types.ts` returns 0

## Must-Haves

- [ ] `dispatchNextUnit()` calls `resolveEngine(s)` to get engine instance
- [ ] Initial state derivation routes through `engine.deriveState()` with `GSDState` extracted from `raw`
- [ ] Dispatch resolution routes through `engine.resolveDispatch()` with `EngineDispatchAction` → `DispatchAction` bridge
- [ ] All mid-function `deriveState()` re-derivation calls keep `engineState` in sync
- [ ] `handleAgentEnd` pipeline is completely untouched
- [ ] All 1862+ unit tests pass — zero new failures
- [ ] All 23 integration tests pass — zero new failures
- [ ] Typecheck passes with 0 errors

## Verification

- `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/*.test.ts 2>&1 | tail -5` — passes (check for "fail 0" or equivalent)
- `rg "dev-workflow-engine|engine-resolver" src/resources/extensions/gsd/workflow-templates/` — empty (R017)
- `grep -c "from './" src/resources/extensions/gsd/engine-types.ts` — returns 0

## Inputs

- `src/resources/extensions/gsd/dev-workflow-engine.ts` — from T01: `DevWorkflowEngine` class
- `src/resources/extensions/gsd/dev-execution-policy.ts` — from T01: `DevExecutionPolicy` class
- `src/resources/extensions/gsd/engine-resolver.ts` — from T01: `resolveEngine()` function
- `src/resources/extensions/gsd/auto.ts` — the 1835-line main loop file, specifically `dispatchNextUnit()` starting ~line 981
- T01 contract tests passing confirms the engine/policy/resolver are correct in isolation

## Expected Output

- `src/resources/extensions/gsd/auto.ts` — modified: `dispatchNextUnit()` uses `resolveEngine()` for state derivation and dispatch resolution. Two new imports added. Two call sites changed. All other code paths unchanged.
