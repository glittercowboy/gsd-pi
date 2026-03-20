# S05: Context Continuity + Verification Policies

**Goal:** Steps inject prior step summaries via `context_from` and all four verification policies (content-heuristic, shell-command, prompt-verify, human-review) work through `CustomExecutionPolicy.verify()`.
**Demo:** A multi-step workflow where step-2 receives injected context from step-1's artifacts, and steps with verification policies return the correct outcomes — proven by integration test exercising the full dispatch loop.

## Must-Haves

- `context-injector.ts` pure function reads `contextFrom` step IDs, resolves `produces` paths from the definition, reads artifacts from the run directory, and returns a formatted context string with per-step headers and token budget truncation
- `VerifyPolicy` discriminated union type replaces `unknown` on `StepDefinition.verify`; `validateDefinition()` validates all four policy shapes
- `custom-verification.ts` implements all four verification policies: content-heuristic (file exists + min_size + pattern), shell-command (spawnSync + exit code), prompt-verify (returns "pause" with prompt in reason), human-review (returns "pause")
- `CustomWorkflowEngine.resolveDispatch()` prepends injected context to the step prompt
- `CustomExecutionPolicy` accepts `runDir`, loads the frozen definition, and dispatches to the correct verification policy
- `engine-resolver.ts` passes `runDir` to `CustomExecutionPolicy` constructor
- All existing S03/S04 tests pass (zero regressions)

## Proof Level

- This slice proves: integration
- Real runtime required: no (filesystem + spawnSync in tests)
- Human/UAT required: no

## Verification

- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/context-injector.test.ts` — all context injection unit tests pass
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-verification.test.ts` — all verification policy unit tests pass
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/context-verification-integration.test.ts` — integration test proves context injection in dispatch prompt + verification policy returns correct outcomes for a multi-step workflow
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/definition-loader.test.ts` — existing + new verify validation tests pass
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — existing S03/S04 tests pass (zero regressions)
- `npx tsc --noEmit --project tsconfig.extensions.json` — zero type errors

## Observability / Diagnostics

- Runtime signals: `injectContext()` returns empty string with no side effects when context_from is missing or artifacts don't exist — no silent data corruption. Verification policies return structured `"continue" | "retry" | "pause"` — inspectable at the policy dispatch boundary.
- Inspection surfaces: `cat <runDir>/DEFINITION.yaml` to see verify and context_from config per step. Context injector output is prepended to the step prompt — visible in the dispatched prompt string.
- Failure visibility: Content-heuristic returns `"retry"` with no diagnostic message (the caller knows the step failed verification). Shell-command captures stderr from `spawnSync` — available for debugging. Prompt-verify and human-review return `"pause"` with a reason string containing the verify prompt or a human review message.
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `definition-loader.ts` (`StepDefinition.contextFrom`, `StepDefinition.verify`, `StepDefinition.produces`), `run-manager.ts` (run directory structure with `DEFINITION.yaml`), `graph.ts` (`readGraph`), `custom-workflow-engine.ts` (`resolveDispatch`), `custom-execution-policy.ts` (`verify`), `engine-resolver.ts` (policy construction)
- New wiring introduced in this slice: `CustomWorkflowEngine.resolveDispatch()` calls `injectContext()` to prepend context to prompts. `CustomExecutionPolicy.verify()` loads the frozen definition and dispatches to verification policy handlers. `engine-resolver.ts` passes `runDir` to `CustomExecutionPolicy` constructor.
- What remains before the milestone is truly usable end-to-end: S06 (iteration/fan-out), S07 (CLI commands + LLM builder), S08 (dashboard + E2E validation)

## Tasks

- [x] **T01: Build context injector and type the VerifyPolicy field** `est:25m`
  - Why: Establishes the two data-layer foundations S05 needs — the `VerifyPolicy` discriminated union (replacing `unknown` on `StepDefinition.verify`) with validation, and the pure `injectContext()` function that reads artifacts from prior steps. Both are leaf modules with no engine dependencies.
  - Files: `src/resources/extensions/gsd/context-injector.ts`, `src/resources/extensions/gsd/definition-loader.ts`, `src/resources/extensions/gsd/tests/context-injector.test.ts`, `src/resources/extensions/gsd/tests/definition-loader.test.ts`
  - Do: (1) Add `VerifyPolicy` discriminated union type to `definition-loader.ts` and change `StepDefinition.verify` from `unknown` to `VerifyPolicy | undefined`. (2) Add verify field validation to `validateDefinition()` — accept all four valid shapes, reject invalid policy names and missing required fields, continue accepting missing verify (optional). (3) Create `context-injector.ts` with `injectContext(stepId, definition, runDir, opts?)` — looks up `contextFrom`, reads each referenced step's `produces` files from runDir, assembles with headers, truncates to token budget (default 50000 chars). (4) Add unit tests for both.
  - Verify: `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/context-injector.test.ts` passes AND `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/definition-loader.test.ts` passes (existing + new tests)
  - Done when: `injectContext()` returns formatted context from artifacts, `VerifyPolicy` type is exported, `validateDefinition()` validates all four verify shapes, all tests green, `npx tsc --noEmit --project tsconfig.extensions.json` clean

- [x] **T02: Implement four verification policies with unit tests** `est:20m`
  - Why: Delivers the four verification policy handlers (R010) as pure functions in a standalone module, testable without engine wiring.
  - Files: `src/resources/extensions/gsd/custom-verification.ts`, `src/resources/extensions/gsd/tests/custom-verification.test.ts`
  - Do: (1) Create `custom-verification.ts` exporting a `runVerification(policy, runDir, produces)` dispatcher and four handler functions. `content-heuristic`: check each produces file exists in runDir, meets optional `minSize` bytes, contains optional `pattern` substring — returns "continue" if all pass, "retry" if any fail. `shell-command`: `spawnSync(command, { cwd: runDir, shell: true, timeout: 30000 })`, return "continue" on exit 0, "retry" otherwise — reject commands containing `..` for path traversal safety. `prompt-verify`: return `{ result: "pause", reason: <prompt text> }`. `human-review`: return `{ result: "pause", reason: "Human review required" }`. Return type is `{ result: "continue" | "retry" | "pause"; reason?: string }`. (2) No verify field → return `{ result: "continue" }`. (3) Write unit tests covering all success/failure paths for each policy.
  - Verify: `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-verification.test.ts` passes
  - Done when: All four policies return correct outcomes for valid/invalid inputs, no-verify defaults to continue, all tests green, `npx tsc --noEmit --project tsconfig.extensions.json` clean

- [x] **T03: Wire context injection and verification into engine, policy, and resolver** `est:25m`
  - Why: Connects T01/T02's pure functions into the actual engine/policy classes so that context injection happens during dispatch and verification happens through the execution policy interface. Proves the full pipeline with an integration test (R009, R010, R015 partial).
  - Files: `src/resources/extensions/gsd/custom-workflow-engine.ts`, `src/resources/extensions/gsd/custom-execution-policy.ts`, `src/resources/extensions/gsd/engine-resolver.ts`, `src/resources/extensions/gsd/tests/context-verification-integration.test.ts`
  - Do: (1) Modify `CustomWorkflowEngine.resolveDispatch()` to load the full `WorkflowDefinition` from `DEFINITION.yaml` (reuse the definition already parsed in `deriveState` by attaching it to `EngineState.raw._definition`), call `injectContext(stepId, definition, runDir)`, and prepend the result to `step.prompt`. (2) Add `runDir` constructor parameter to `CustomExecutionPolicy`. In `verify()`, load `DEFINITION.yaml` from `runDir`, find the step by `unitId`, and call `runVerification()` from `custom-verification.ts` with the step's verify policy and produces paths. (3) Update `engine-resolver.ts` to pass `runDir` to `new CustomExecutionPolicy(runDir)`. (4) Write integration test: create a 3-step YAML definition where step-2 has `context_from: [step-1]` and step-3 has `verify: { policy: shell-command, command: "test -f draft.md" }`. Run through `createRun` → dispatch loop. Assert step-2's dispatched prompt contains context from step-1's artifacts. Assert step-3's verification returns the expected result. (5) Run existing S03/S04 tests to confirm zero regressions.
  - Verify: `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/context-verification-integration.test.ts` passes AND `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` passes AND `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts` passes
  - Done when: Integration test proves context injection in dispatch prompt and verification policy dispatching through `CustomExecutionPolicy.verify()`. All existing tests pass. `npx tsc --noEmit --project tsconfig.extensions.json` clean.

## Files Likely Touched

- `src/resources/extensions/gsd/context-injector.ts` (new)
- `src/resources/extensions/gsd/custom-verification.ts` (new)
- `src/resources/extensions/gsd/definition-loader.ts` (modify — VerifyPolicy type + validation)
- `src/resources/extensions/gsd/custom-workflow-engine.ts` (modify — context injection in resolveDispatch)
- `src/resources/extensions/gsd/custom-execution-policy.ts` (modify — real verify implementation)
- `src/resources/extensions/gsd/engine-resolver.ts` (modify — pass runDir to policy)
- `src/resources/extensions/gsd/tests/context-injector.test.ts` (new)
- `src/resources/extensions/gsd/tests/custom-verification.test.ts` (new)
- `src/resources/extensions/gsd/tests/context-verification-integration.test.ts` (new)
- `src/resources/extensions/gsd/tests/definition-loader.test.ts` (modify — add verify validation tests)
