# S06: Iteration with Durable Graph Expansion

**Goal:** A step with `iterate` pattern-matches items from a source artifact, expands into concrete instances in GRAPH.yaml, and dispatches them serially. Expansion is deterministic and frozen for the run.
**Demo:** A 3-step workflow (outline → draft-chapters [iterate] → review) fans out 3 chapter instances from an outline artifact. Each instance dispatches serially. The review step depends on all instances. Total dispatches: 1 + 3 + 1 = 5. Expanding twice from the same artifact produces byte-identical GRAPH.yaml.

## Must-Haves

- `IterateConfig` typed interface (`{ source: string; pattern: string }`) replaces `iterate?: unknown` on `StepDefinition`
- Validation in `validateDefinition()` enforces source (no `..` traversal) and pattern (valid regex with capture group)
- `expandIteration()` pure function materializes instances in a `WorkflowGraph` with deterministic zero-padded IDs (`<parentId>--001`)
- Parent step transitions to `"expanded"` status (new status value); expanded steps are never dispatched
- Downstream `dependsOn` references to the parent are rewritten to depend on all instance IDs
- `resolveDispatch()` triggers lazy expansion when a pending step has an iterate config, reads source artifact, applies regex, expands
- Idempotency guard: if instances already exist for a parent, skip re-expansion
- Empty pattern match returns `{ action: "stop" }` error rather than zero instances
- `getDisplayMetadata()` counts only non-expanded steps for progress
- Determinism proof: same artifact content → identical GRAPH.yaml on repeated expansion

## Proof Level

- This slice proves: integration (iterate expansion through real engine dispatch cycle)
- Real runtime required: no (filesystem-only integration tests)
- Human/UAT required: no

## Verification

- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/definition-loader.test.ts` — existing + new iterate validation tests pass
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/iteration-expansion.test.ts` — new unit + integration tests pass, including determinism proof
- `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — zero regressions on existing 11 engine tests
- `npx tsc --noEmit --project tsconfig.extensions.json` — zero type errors

## Observability / Diagnostics

- Runtime signals: `GraphStep.status === "expanded"` marks parent steps post-expansion; `GraphStep.parentStepId` marks instances for tracing lineage
- Inspection surfaces: `cat <runDir>/GRAPH.yaml` shows expanded instances with zero-padded IDs, parent references, and rewritten dependencies
- Failure visibility: `resolveDispatch()` returns `{ action: "stop", reason: "Iterate pattern matched no items..." }` on empty matches; `expandIteration()` is pure and deterministic — identical inputs always produce identical output

## Integration Closure

- Upstream surfaces consumed: `definition-loader.ts` (StepDefinition with iterate field), `graph.ts` (readGraph/writeGraph/getNextPendingStep/markStepComplete), `custom-workflow-engine.ts` (resolveDispatch/reconcile/getDisplayMetadata)
- New wiring introduced in this slice: `resolveDispatch()` gains lazy expansion logic triggered by iterate config on the next pending step
- What remains before the milestone is truly usable end-to-end: S07 (CLI commands + LLM builder), S08 (dashboard integration + final assembly)

## Tasks

- [x] **T01: Type iterate schema and add validation to definition-loader** `est:20m`
  - Why: The `iterate` field is currently `unknown` on `StepDefinition`. It must be typed as `IterateConfig` with validation before T02 can consume it for expansion logic.
  - Files: `src/resources/extensions/gsd/definition-loader.ts`, `src/resources/extensions/gsd/tests/definition-loader.test.ts`
  - Do: Add `IterateConfig = { source: string; pattern: string }` interface. Change `iterate?: unknown` to `iterate?: IterateConfig`. Add validation in `validateDefinition()`: if iterate present, source must be string without `..`, pattern must be string that compiles as valid regex and contains at least one capture group `(...)`. Existing test fixture `{ source: "file.md", pattern: "^## (.+)" }` already conforms — verify it still passes. Add new tests: valid iterate config, missing source, invalid regex, no capture group, path traversal rejection.
  - Verify: `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/definition-loader.test.ts` — all existing + new tests pass
  - Done when: `StepDefinition.iterate` is typed as `IterateConfig | undefined`, validation catches malformed configs, existing tests unbroken

- [x] **T02: Implement expandIteration() and "expanded" status in graph.ts** `est:30m`
  - Why: Core expansion logic — converts matched items into concrete step instances in the graph with deterministic IDs, rewrites downstream dependencies, and adds the "expanded" status that prevents parent steps from being dispatched.
  - Files: `src/resources/extensions/gsd/graph.ts`, `src/resources/extensions/gsd/tests/iteration-expansion.test.ts`
  - Do: Add `"expanded"` to `GraphStep.status` union. Add optional `parentStepId?: string` to `GraphStep` (serialized as `parent_step_id` in YAML). Implement `expandIteration(graph, stepId, items: string[], promptTemplate: string): WorkflowGraph` as a pure function: mark parent as "expanded", insert instances with IDs `<stepId>--<zeroPad3(i+1)>`, copy parent's dependsOn to each instance, rewrite any step whose dependsOn includes stepId to depend on all instance IDs instead. Update `getNextPendingStep()` to skip "expanded" steps. Update YAML serialization (writeGraph/readGraph) for new status value and optional `parent_step_id` field. Write unit tests: expansion produces correct instance count, IDs are deterministic and zero-padded, deps are rewritten, expanded steps are skipped by getNextPendingStep, roundtrip through writeGraph/readGraph preserves parentStepId, markStepComplete rejects expanded steps.
  - Verify: `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/iteration-expansion.test.ts` — all new tests pass; `node --experimental-strip-types --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — zero regressions
  - Done when: `expandIteration()` is exported from graph.ts, "expanded" status works end-to-end through YAML roundtrip, existing 11 engine tests still pass

- [x] **T03: Wire expansion into resolveDispatch() and prove with integration test** `est:35m`
  - Why: Closes the loop — connects the typed iterate config (T01) and expansion logic (T02) into the real engine dispatch cycle, then proves the full fan-out workflow works end-to-end with a determinism proof.
  - Files: `src/resources/extensions/gsd/custom-workflow-engine.ts`, `src/resources/extensions/gsd/tests/iteration-expansion.test.ts`
  - Do: In `resolveDispatch()`, after reading the graph and getting nextStep: check if DEFINITION.yaml has an `iterate` config for that step's ID. If yes and step status is "pending" (not yet expanded): (1) read the source artifact from runDir using iterate.source path, (2) apply the regex pattern with global flag extracting capture group 1 (or group 0 if no groups), (3) if no matches, return `{ action: "stop", reason: "Iterate pattern matched no items..." }`, (4) idempotency guard — if instances with parentStepId matching this step already exist in graph, skip expansion, (5) call `expandIteration()` with matched items and the step's prompt as template (replacing `{{item}}` with each item), (6) `writeGraph()` the expanded graph, (7) re-read graph and re-query `getNextPendingStep()` to return the first instance. Update `getDisplayMetadata()` to exclude expanded steps from total count (count only steps where status !== "expanded"). Add integration tests in `iteration-expansion.test.ts`: (a) Full 3-step workflow (outline → draft-chapters[iterate] → review) — outline produces artifact with 3 chapters, expansion creates 3 instances, all dispatch serially, review depends on all 3 instances, total 5 dispatches; (b) Determinism proof — expand twice from same artifact, serialize both GRAPH.yaml, assert byte equality; (c) Empty match returns stop action; (d) Idempotency — calling resolveDispatch twice doesn't double-expand.
  - Verify: All four verification commands from slice-level Verification section pass. `npx tsc --noEmit --project tsconfig.extensions.json` — zero type errors.
  - Done when: A workflow with iterate fans out correctly through the real engine, determinism proof passes, all existing tests still pass, zero type errors

## Files Likely Touched

- `src/resources/extensions/gsd/definition-loader.ts`
- `src/resources/extensions/gsd/graph.ts`
- `src/resources/extensions/gsd/custom-workflow-engine.ts`
- `src/resources/extensions/gsd/tests/definition-loader.test.ts`
- `src/resources/extensions/gsd/tests/iteration-expansion.test.ts`
