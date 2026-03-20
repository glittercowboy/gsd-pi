# S04: YAML Definitions + Run Snapshotting + GRAPH.yaml

**Goal:** YAML workflow definitions load from `.gsd/workflow-defs/`, snapshot into frozen runs, and execute with step completion tracked in GRAPH.yaml.
**Demo:** A 3-step YAML definition file is loaded, a run is created (with DEFINITION.yaml snapshot + generated GRAPH.yaml), and the full dispatch cycle completes through CustomWorkflowEngine — proven by integration test.

## Must-Haves

- `definition-loader.ts` parses V1 YAML schema and validates required fields (version, name, steps[].id/name/prompt)
- `graphFromDefinition()` in `graph.ts` converts a `WorkflowDefinition` into a `WorkflowGraph` with all steps pending
- `run-manager.ts` creates run directories, snapshots DEFINITION.yaml via `copyFileSync`, generates initial GRAPH.yaml
- Schema validation rejects missing `version`, missing step `id`, and path-traversal in `produces`
- Schema validation accepts unknown fields silently (forward compatibility for S05/S06 fields)
- `getDisplayMetadata()` reads definition name instead of hardcoded "Custom Pipeline"
- Integration test proves full pipeline: YAML file → loadDefinition → createRun → dispatch cycle → all steps complete

## Proof Level

- This slice proves: integration
- Real runtime required: no (filesystem only, no auto-loop)
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-loader.test.ts` — all pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts` — all pass
- `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — 11/11 still pass (no regressions)

## Observability / Diagnostics

- Runtime signals: `loadDefinition` throws descriptive errors for schema violations; `createRun` returns `{ runDir, runId }` for tracing
- Inspection surfaces: GRAPH.yaml and DEFINITION.yaml in each run directory are human-readable YAML files
- Failure visibility: validation errors include specific field names and reasons (e.g., "Step at index 2 missing required field: id")
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `graph.ts` (readGraph/writeGraph/getNextPendingStep/markStepComplete), `custom-workflow-engine.ts` (CustomWorkflowEngine class), `engine-types.ts` (EngineState, DisplayMetadata)
- New wiring introduced in this slice: `graphFromDefinition()` bridges definition-loader types into graph.ts; `run-manager.ts` orchestrates snapshot + GRAPH.yaml generation; `getDisplayMetadata` reads `_definition` name from EngineState.raw
- What remains before the milestone is truly usable end-to-end: S05 (context continuity + verification policies), S06 (iteration/fan-out), S07 (CLI commands + LLM builder), S08 (dashboard + E2E)

## Tasks

- [x] **T01: Build definition-loader.ts and graphFromDefinition()** `est:25m`
  - Why: The pure data layer — parsing YAML definitions and converting them to WorkflowGraph — must exist before run-manager or integration tests can be written. Covers R006 (V1 schema with version:1).
  - Files: `src/resources/extensions/gsd/definition-loader.ts`, `src/resources/extensions/gsd/graph.ts`, `src/resources/extensions/gsd/tests/definition-loader.test.ts`
  - Do: Create `definition-loader.ts` with `loadDefinition(defsDir, name)` and `validateDefinition(parsed)`. Add `graphFromDefinition(def)` to `graph.ts`. Export `WorkflowDefinition` and `StepDefinition` types. YAML uses snake_case (`depends_on`, `context_from`), TypeScript uses camelCase. Accept but don't process S05/S06 fields. Validate: version===1, name is string, each step has id/name/prompt, produces paths don't contain `..`. Write unit tests covering valid schema, missing version, missing step fields, path traversal rejection, unknown field acceptance.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-loader.test.ts` — all pass; `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors
  - Done when: `loadDefinition` parses valid YAML, `validateDefinition` rejects invalid schemas, `graphFromDefinition` produces correct WorkflowGraph, all unit tests pass, zero type errors

- [x] **T02: Build run-manager.ts and update getDisplayMetadata** `est:20m`
  - Why: The run lifecycle layer — creating run directories, snapshotting definitions, generating GRAPH.yaml — is required before the full pipeline can be exercised. Covers R007 (immutable snapshot) and R008 (GRAPH.yaml generation from definitions).
  - Files: `src/resources/extensions/gsd/run-manager.ts`, `src/resources/extensions/gsd/custom-workflow-engine.ts`
  - Do: Create `run-manager.ts` with `createRun(basePath, definitionName, defsDir?)` and `listRuns(basePath)`. `createRun` does: mkdir `workflow-runs/<name>-<timestamp>-<4char random>/`, `copyFileSync` the source YAML as DEFINITION.yaml, call `graphFromDefinition` + `writeGraph` for initial GRAPH.yaml, return `{ runDir, runId }`. In `custom-workflow-engine.ts`, update `getDisplayMetadata` to read a `_definition` name from `EngineState.raw` (set in `buildGSDStateStub`) instead of hardcoded "Custom Pipeline", falling back to "Custom Pipeline" if absent.
  - Verify: `npx tsc --noEmit --project tsconfig.extensions.json` — 0 errors; `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — 11/11 still pass
  - Done when: `createRun` creates directory with DEFINITION.yaml snapshot and valid GRAPH.yaml, `listRuns` returns run metadata, `getDisplayMetadata` shows definition name, zero regressions on existing tests

- [x] **T03: Integration test — YAML file through full dispatch cycle** `est:20m`
  - Why: Proves the entire S04 pipeline works end-to-end: YAML definition → loadDefinition → createRun → CustomWorkflowEngine dispatch cycle → all steps complete. This is the slice's demo outcome and validates R006, R007, R008 together.
  - Files: `src/resources/extensions/gsd/tests/definition-run-integration.test.ts`
  - Do: Write integration test that: (1) writes a 3-step YAML definition to a temp workflow-defs dir, (2) calls loadDefinition, (3) calls createRun, (4) verifies DEFINITION.yaml exists and is byte-identical to source, (5) verifies GRAPH.yaml has 3 pending steps with correct dependencies, (6) runs the full deriveState → resolveDispatch → reconcile cycle 3 times through CustomWorkflowEngine, (7) verifies all steps complete on disk, (8) verifies getDisplayMetadata shows the workflow name from the definition. Include negative test: createRun with nonexistent definition throws.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts` — all pass
  - Done when: Integration test passes with all assertions, proving the full YAML → load → snapshot → dispatch → complete pipeline

## Files Likely Touched

- `src/resources/extensions/gsd/definition-loader.ts` (new)
- `src/resources/extensions/gsd/run-manager.ts` (new)
- `src/resources/extensions/gsd/graph.ts` (add graphFromDefinition)
- `src/resources/extensions/gsd/custom-workflow-engine.ts` (update getDisplayMetadata)
- `src/resources/extensions/gsd/tests/definition-loader.test.ts` (new)
- `src/resources/extensions/gsd/tests/definition-run-integration.test.ts` (new)
