---
estimated_steps: 5
estimated_files: 5
---

# T03: Wire context injection and verification into engine, policy, and resolver

**Slice:** S05 — Context Continuity + Verification Policies
**Milestone:** M001

## Description

Connects the pure functions from T01 (context-injector) and T02 (custom-verification) into the actual runtime classes. `CustomWorkflowEngine.resolveDispatch()` prepends injected context to step prompts. `CustomExecutionPolicy.verify()` loads the frozen definition and dispatches to the verification policy handler. `engine-resolver.ts` passes `runDir` to the policy constructor. Proves the full pipeline with an integration test that exercises context injection and verification through the dispatch/verify cycle.

This task delivers R009 (context continuity) and R010 (verification policies) at the integration level, and partially advances R015 (full pipeline).

**Relevant skills:** None required.

## Steps

1. **Modify `CustomWorkflowEngine` to inject context into dispatch prompts.**
   - In `resolveDispatch()`, after identifying the next step, load the full `WorkflowDefinition` from `DEFINITION.yaml` in the run directory. The definition is already parsed in `deriveState()` — to avoid double-parsing, attach the full parsed definition (not just the name) to `EngineState.raw._definition`.
   - Modify `deriveState()`: after successfully parsing `DEFINITION.yaml`, store the full parsed definition object on `_definition` (currently only stores `{ name: definitionName }`). Use the `loadDefinition`-style parsing — or more simply, `parse(raw)` the YAML and do a minimal conversion since the file is already validated. Better approach: import `loadDefinition` is for a defsDir + name pattern. Since we have a single file path, either: (a) read+parse YAML manually and construct a `WorkflowDefinition`, or (b) change `_definition` to store the full parsed YAML and have `resolveDispatch` do the contextFrom lookup directly on the raw YAML. Simplest: parse DEFINITION.yaml with `parse()` from `yaml` package (already imported), convert steps' `context_from` to `contextFrom` and `produces`, and call `injectContext()`.
   - **Concrete approach:** In `resolveDispatch()`, parse `DEFINITION.yaml` directly (it's a small file, cheap to read). Build a minimal `WorkflowDefinition` object from it (reuse the conversion logic pattern from `loadDefinition`). Call `injectContext(nextStep.id, definition, this.runDir)`. If the result is non-empty, prepend it to `nextStep.prompt` with a newline separator.
   - Update `getDisplayMetadata()` to still work — it reads `_definition.name`, so ensure the `_definition` object on `raw` still has a `name` property. If you change `_definition` to the full definition, update the type cast in `getDisplayMetadata()`.

2. **Modify `CustomExecutionPolicy` to accept `runDir` and implement real `verify()`.**
   - Add `private readonly runDir: string` constructor parameter.
   - In `verify(unitType, unitId, context)`:
     - Read `DEFINITION.yaml` from `this.runDir` and parse it
     - Find the step matching `unitId` in the definition's steps array
     - Get the step's `verify` config and `produces` array
     - If no verify config → return `"continue"`
     - Call `runVerification(policy, this.runDir, produces)` from `custom-verification.ts`
     - Map `VerificationResult.result` to the return type: `"continue"`, `"retry"`, or `"pause"`
   - Import `runVerification` from `custom-verification.ts` and `VerifyPolicy` from `definition-loader.ts`
   - Import `parse` from `yaml`, `readFileSync`/`existsSync` from `node:fs`, `join` from `node:path`

3. **Update `engine-resolver.ts` to pass `runDir` to `CustomExecutionPolicy`.**
   - In the `id.startsWith("custom:")` branch, extract `runDir` (already done: `const runDir = id.slice("custom:".length)`)
   - Change `new CustomExecutionPolicy()` to `new CustomExecutionPolicy(runDir)`

4. **Write the integration test `context-verification-integration.test.ts`.**
   - New file at `src/resources/extensions/gsd/tests/context-verification-integration.test.ts`
   - **Test 1: Context injection appears in dispatch prompt.**
     - Write a 2-step YAML definition: step-1 produces `research.md`, step-2 has `context_from: [step-1]`
     - Call `createRun()` to snapshot it
     - Write `research.md` into the run directory (simulating step-1's output)
     - Complete step-1 via `engine.reconcile()`
     - Call `engine.resolveDispatch()` for step-2
     - Assert the dispatched prompt contains the content of `research.md` with the `## Context from prior steps` header
   - **Test 2: Verification policy is dispatched through `CustomExecutionPolicy.verify()`.**
     - Write a 2-step YAML definition: step-1 has no verify, step-2 has `verify: { policy: content-heuristic, min_size: 10 }`
     - Call `createRun()` to snapshot it
     - Construct `CustomExecutionPolicy(runDir)`
     - Call `policy.verify("custom-step", "step-2", { basePath: runDir })`
     - Without the artifact file existing → should return `"retry"`
     - Write a 20-byte file to the produces path in runDir
     - Call `policy.verify()` again → should return `"continue"`
   - **Test 3: shell-command verification through policy.**
     - Step with `verify: { policy: shell-command, command: "test -f output.md" }`
     - Verify returns `"retry"` when file doesn't exist, `"continue"` when it does
   - **Test 4: prompt-verify and human-review return "pause".**
     - Steps with `verify: { policy: prompt-verify, prompt: "Check quality" }` and `verify: { policy: human-review }`
     - Both return `"pause"` from `policy.verify()`

5. **Run regression tests.**
   - `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — all 11 existing tests must pass
   - `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts` — all 4 existing tests must pass
   - `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors

## Must-Haves

- [ ] `resolveDispatch()` prepends injected context from prior step artifacts to the step prompt
- [ ] `CustomExecutionPolicy.verify()` loads definition from `runDir`, dispatches to `runVerification()`
- [ ] `engine-resolver.ts` passes `runDir` to `CustomExecutionPolicy` constructor
- [ ] Integration test proves context appears in dispatched prompt
- [ ] Integration test proves all four verification policies return correct results through `CustomExecutionPolicy.verify()`
- [ ] All existing S03/S04 tests pass (zero regressions)
- [ ] `npx tsc --noEmit --project tsconfig.extensions.json` clean

## Verification

- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/context-verification-integration.test.ts` — all pass
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — all 11 pass
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts` — all 4 pass
- `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors

## Inputs

- `src/resources/extensions/gsd/context-injector.ts` — T01 output. `injectContext(stepId, definition, runDir, opts?)` returns formatted context string.
- `src/resources/extensions/gsd/custom-verification.ts` — T02 output. `runVerification(policy, runDir, produces)` returns `{ result, reason? }`.
- `src/resources/extensions/gsd/definition-loader.ts` — T01 output. `VerifyPolicy` type, `WorkflowDefinition`/`StepDefinition` types, `loadDefinition()`.
- `src/resources/extensions/gsd/custom-workflow-engine.ts` — current state: `resolveDispatch()` reads graph and returns prompt directly. Needs context injection prepended.
- `src/resources/extensions/gsd/custom-execution-policy.ts` — current state: stub `verify()` returns `"continue"`. Needs real implementation with `runDir` constructor param.
- `src/resources/extensions/gsd/engine-resolver.ts` — current state: constructs `CustomExecutionPolicy()` with no args. Needs `runDir` passed.
- `src/resources/extensions/gsd/run-manager.ts` — `createRun(basePath, definitionName)` returns `{ runId, runDir }`. Used in integration test.
- Key patterns: DEFINITION.yaml in runDir is the frozen definition. Parse with `yaml.parse()`. Steps use `context_from` (snake_case) in YAML, `contextFrom` (camelCase) in TypeScript. The `loadDefinition()` function works from a defsDir — for reading DEFINITION.yaml directly, parse YAML manually and apply the same snake_case→camelCase conversion for the fields needed by `injectContext()`.
- **Fragility note from S04:** `buildGSDStateStub()` accepts optional `definitionName` parameter. If attaching more to `_definition`, follow the same optional-param pattern.

## Observability Impact

- **New runtime signals:**
  - `resolveDispatch()` now includes injected context in the dispatch prompt — visible as `## Context from prior steps` header in the dispatched prompt string. Empty string (no injection) when `context_from` is absent or referenced artifacts don't exist.
  - `CustomExecutionPolicy.verify()` returns structured `"continue" | "retry" | "pause"` based on the step's verify policy — inspectable at the policy dispatch boundary. Returns `"continue"` when no verify config is defined.
- **Inspection surfaces:**
  - Dispatched prompt string from `resolveDispatch()` contains context injection output — agents can check for `## Context from prior steps` header to confirm injection occurred.
  - `verify()` return value directly reflects the verification outcome. For `"pause"`, the underlying `VerificationResult.reason` contains the prompt text or human-review message (though the policy interface only surfaces the `"pause"` string).
- **Failure modes:**
  - Missing DEFINITION.yaml in runDir causes `resolveDispatch()` to skip context injection silently (no crash, no injection). `verify()` returns `"continue"` (safe default) if DEFINITION.yaml is unreadable.
  - Invalid step ID passed to `verify()` returns `"continue"` (no verify config found = pass-through).

## Expected Output

- `src/resources/extensions/gsd/custom-workflow-engine.ts` — modified: `resolveDispatch()` calls `injectContext()` and prepends context to prompt
- `src/resources/extensions/gsd/custom-execution-policy.ts` — modified: constructor accepts `runDir`, `verify()` dispatches to `runVerification()`
- `src/resources/extensions/gsd/engine-resolver.ts` — modified: passes `runDir` to `CustomExecutionPolicy`
- `src/resources/extensions/gsd/tests/context-verification-integration.test.ts` — new integration test (~200-250 lines, 4 tests)
