---
estimated_steps: 3
estimated_files: 1
---

# T03: Integration test — YAML file through full dispatch cycle

**Slice:** S04 — YAML Definitions + Run Snapshotting + GRAPH.yaml
**Milestone:** M001

## Description

Write the integration test that proves S04's demo outcome: a real YAML definition file is loaded, a run is created with an immutable DEFINITION.yaml snapshot and generated GRAPH.yaml, and the full 3-step dispatch cycle completes through CustomWorkflowEngine. This is the slice's proof artifact — it validates R006 (V1 schema), R007 (immutable snapshot), and R008 (GRAPH.yaml step tracking) together in one pipeline.

**Relevant skills:** None required.

## Steps

1. **Create `definition-run-integration.test.ts`** at `src/resources/extensions/gsd/tests/definition-run-integration.test.ts`:

   **Test: "Full pipeline: YAML definition → createRun → dispatch cycle → all steps complete"**
   - Create temp directory as basePath
   - Create `<basePath>/workflow-defs/` directory
   - Write a 3-step YAML definition file (`test-pipeline.yaml`) with:
     ```yaml
     version: 1
     name: "test-pipeline"
     description: "Integration test workflow"
     steps:
       - id: research
         name: "Research phase"
         prompt: "Research the topic"
         produces:
           - research.md
       - id: outline
         name: "Create outline"
         prompt: "Create an outline based on research"
         depends_on:
           - research
         produces:
           - outline.md
       - id: draft
         name: "Write draft"
         prompt: "Write the first draft from outline"
         depends_on:
           - outline
         produces:
           - draft.md
     ```
   - Call `loadDefinition(defsDir, "test-pipeline")` — assert returns 3 steps with correct ids
   - Call `createRun(basePath, "test-pipeline")` — assert returns `{ runDir, runId }`
   - **Verify DEFINITION.yaml snapshot (R007)**: read both source and snapshot bytes, `assert.deepEqual` on raw buffer content (exact byte copy)
   - **Verify GRAPH.yaml structure (R008)**: `readGraph(runDir)` — assert 3 steps, all "pending", correct dependencies (outline depends on research, draft depends on outline)
   - **Run dispatch cycle**: Create `CustomWorkflowEngine(runDir)`, loop 3 times:
     - `deriveState` → assert not complete
     - `resolveDispatch` → assert dispatch action with correct step id (research → outline → draft, respecting dependency order)
     - `reconcile` → assert "continue" for first two, "stop" for last
   - **Verify final state**: `deriveState` → assert `isComplete === true`; `resolveDispatch` → assert `action === "stop"`
   - **Verify on-disk state**: `readGraph(runDir)` — all 3 steps have `status: "complete"`
   - **Verify display metadata**: `getDisplayMetadata` shows workflow name from definition (not "Custom Pipeline")

   **Test: "createRun with nonexistent definition throws"**
   - Create temp basePath with no workflow-defs
   - Call `createRun(basePath, "nonexistent")` — assert throws with descriptive error

   **Test: "listRuns returns created runs"**
   - Create temp basePath, write a valid definition
   - Call `createRun` twice
   - Call `listRuns(basePath)` — assert returns 2 entries with correct definition names
   - Assert entries are ordered newest-first

   **Test: "DEFINITION.yaml snapshot is immune to source modification"**
   - Create run from a valid definition
   - Modify the source YAML file after createRun
   - Read DEFINITION.yaml from run directory — assert it still matches original content (not modified content)

2. **Run tests**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts`

3. **Full regression check**:
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-loader.test.ts` — all pass
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — 11/11 pass

## Must-Haves

- [ ] Full pipeline test: YAML → loadDefinition → createRun → 3-step dispatch cycle → all complete
- [ ] DEFINITION.yaml byte-identity verified (R007)
- [ ] GRAPH.yaml step structure verified before and after dispatch (R008)
- [ ] Dependency ordering verified (research before outline before draft)
- [ ] Display metadata shows definition name
- [ ] Negative test: nonexistent definition throws
- [ ] listRuns returns correct run metadata
- [ ] Snapshot immutability verified (source modification after createRun doesn't affect snapshot)

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts` — all pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-engine-integration.test.ts` — 11/11 still pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-loader.test.ts` — all still pass

## Inputs

- `src/resources/extensions/gsd/definition-loader.ts` — T01 output: `loadDefinition`, `validateDefinition`, types
- `src/resources/extensions/gsd/run-manager.ts` — T02 output: `createRun`, `listRuns`
- `src/resources/extensions/gsd/graph.ts` — T01 output: `readGraph`, `graphFromDefinition`
- `src/resources/extensions/gsd/custom-workflow-engine.ts` — T02 output: updated `getDisplayMetadata`
- Test pattern: `mkdtempSync`/`rmSync` with try/finally (from `custom-engine-integration.test.ts`)
- Loader: `--import ./src/resources/extensions/gsd/tests/resolve-ts.mjs` (L003)

## Expected Output

- `src/resources/extensions/gsd/tests/definition-run-integration.test.ts` — new file (~150 lines): 4 integration tests proving the full S04 pipeline

## Observability Impact

- **Signals changed:** No new runtime signals — this task adds tests, not production code.
- **Inspection:** Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/definition-run-integration.test.ts` to re-verify the full S04 pipeline at any time. Each test exercises all observable outputs from T01/T02 (DEFINITION.yaml byte identity, GRAPH.yaml step statuses, display metadata, error messages).
- **Failure visibility:** Test failures include assertion messages naming the specific requirement violated (R006/R007/R008) and the expected vs actual values.
