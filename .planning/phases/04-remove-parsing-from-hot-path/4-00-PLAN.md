---
phase: 04-remove-parsing-from-hot-path
plan: 00
type: execute
wave: 1
depends_on: []
files_modified:
  - src/resources/extensions/gsd/tests/doctor-runtime.test.ts
  - src/resources/extensions/gsd/tests/auto-recovery.test.ts
  - src/resources/extensions/gsd/tests/doctor-proactive.test.ts
  - src/resources/extensions/gsd/tests/import-boundary.test.ts
autonomous: true
requirements: [DOC-01, DOC-02, DOC-03, DOC-05, CLN-07]

must_haves:
  truths:
    - "Test cases for checkEngineHealth exist and can be run (RED phase — they fail until Plan 4-02 implements the function)"
    - "Import boundary tests exist verifying hot-path files do not import parse functions from files.ts"
    - "Regression tests exist verifying removed exports and removed check codes"
  artifacts:
    - path: "src/resources/extensions/gsd/tests/import-boundary.test.ts"
      provides: "Import boundary enforcement tests for CLN-07"
      contains: "legacy/parsers"
    - path: "src/resources/extensions/gsd/tests/doctor-runtime.test.ts"
      provides: "checkEngineHealth test cases for DOC-05"
      contains: "checkEngineHealth"
  key_links:
    - from: "src/resources/extensions/gsd/tests/doctor-runtime.test.ts"
      to: "src/resources/extensions/gsd/doctor-checks.ts"
      via: "import { checkEngineHealth }"
      pattern: "checkEngineHealth"
    - from: "src/resources/extensions/gsd/tests/import-boundary.test.ts"
      to: "src/resources/extensions/gsd/doctor-checks.ts"
      via: "file content read for import assertion"
      pattern: "readFileSync"
---

<objective>
Create the Wave 0 test scaffolds identified as gaps in 4-VALIDATION.md. These are the RED-phase tests that must exist before Plans 4-01, 4-02, and 4-03 implement the production code. Some tests will pass immediately (import boundary checks run against current code), others will fail until the corresponding plan implements the function (checkEngineHealth tests).

Purpose: Satisfies Nyquist gate — every plan's verify command has real test cases to run against. Without these, 4-02 Task 1 verify references `doctor-runtime` tests that don't cover checkEngineHealth, and 4-01/4-03 verify references `parsers|files` tests that don't cover import boundaries.
Output: 4 test files updated/created with Wave 0 test cases.
</objective>

<execution_context>
@/Users/jeremymcspadden/.claude/get-shit-done/workflows/execute-plan.md
@/Users/jeremymcspadden/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-remove-parsing-from-hot-path/4-CONTEXT.md
@.planning/phases/04-remove-parsing-from-hot-path/4-RESEARCH.md
@.planning/phases/04-remove-parsing-from-hot-path/4-VALIDATION.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add checkEngineHealth + regression tests to doctor-runtime.test.ts and removed-export tests to auto-recovery.test.ts</name>
  <files>
    src/resources/extensions/gsd/tests/doctor-runtime.test.ts
    src/resources/extensions/gsd/tests/auto-recovery.test.ts
    src/resources/extensions/gsd/tests/doctor-proactive.test.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/tests/doctor-runtime.test.ts
    src/resources/extensions/gsd/tests/auto-recovery.test.ts
    src/resources/extensions/gsd/tests/doctor-proactive.test.ts
    src/resources/extensions/gsd/doctor-checks.ts
    src/resources/extensions/gsd/auto-recovery.ts
    src/resources/extensions/gsd/doctor-proactive.ts
  </read_first>
  <action>
**In doctor-runtime.test.ts, add a new describe block "checkEngineHealth" with these tests (DOC-05):**

1. `test("reports db_orphaned_task when task references non-existent slice")` — Set up a test DB with a task row whose slice_id points to a non-existent slice. Call `checkEngineHealth(basePath, issues, fixes)`. Assert `issues.some(i => i.code === "db_orphaned_task")`.

2. `test("reports db_orphaned_slice when slice references non-existent milestone")` — Same pattern with an orphaned slice.

3. `test("reports db_done_task_no_summary when done task has no summary")` — Insert a task with `status: "done"` and `summary: null`. Assert issue code `db_done_task_no_summary`.

4. `test("reports db_duplicate_id when duplicate IDs exist")` — Insert duplicate milestone IDs. Assert issue code `db_duplicate_id`.

Note: These tests will fail (RED phase) until Plan 4-02 Task 1 creates the `checkEngineHealth` function. That's expected. If the import fails at test load time, wrap the import in a try/catch or use `describe.todo` to mark them as pending. Follow the existing test patterns in doctor-runtime.test.ts for DB setup/teardown.

**In doctor-runtime.test.ts, add regression test (DOC-01):**

5. `test("checkRuntimeHealth does not push orphaned_completed_units issues")` — Call `checkRuntimeHealth(basePath, issues, fixes)` and assert `issues.every(i => i.code !== "orphaned_completed_units")`. This passes immediately and guards against regression.

**In auto-recovery.test.ts, add removed-export tests (DOC-02):**

6. `test("writeBlockerPlaceholder is not exported from auto-recovery")` — Dynamic import `../auto-recovery.js` and assert `typeof module.writeBlockerPlaceholder === "undefined"`. This will fail (RED) until Plan 4-03 removes the function.

7. `test("skipExecuteTask is not exported from auto-recovery")` — Same pattern.

**In doctor-proactive.test.ts, add projection drift test (DOC-03):**

8. `test("preDispatchHealthGate re-renders projections when event log is newer")` — Set up a fixture with a stale projection file (mtime in past) and an event log entry with a newer timestamp. Call `preDispatchHealthGate(basePath)`. Assert that `renderAllProjections` was called (or that the projection file was updated). This may require mocking `renderAllProjections`. This will fail (RED) until Plan 4-02 Task 2 adds the projection drift check. Use `describe.todo` if the setup is too complex to scaffold without the implementation.

Follow the existing test file conventions exactly (import style, describe/test nesting, setup/teardown patterns). Add copyright header to any new test file.
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -20</automated>
  </verify>
  <done>Test cases exist in doctor-runtime.test.ts (checkEngineHealth + regression), auto-recovery.test.ts (removed exports), and doctor-proactive.test.ts (projection drift). TypeScript compiles. Some tests may be RED (expected for Wave 0 scaffolds).</done>
</task>

<task type="auto">
  <name>Task 2: Create import-boundary.test.ts for CLN-07 enforcement</name>
  <files>
    src/resources/extensions/gsd/tests/import-boundary.test.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/tests/parsers.test.ts
    src/resources/extensions/gsd/files.ts
  </read_first>
  <action>
Create a new test file `src/resources/extensions/gsd/tests/import-boundary.test.ts` with:

- Copyright header: `// GSD Extension — Import Boundary Tests (CLN-07)` + `// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>`
- Uses `node:test` (describe, test) and `node:assert` — matching existing test file patterns.
- Uses `node:fs` readFileSync to read source file contents as strings.

**Tests (all static analysis — read file contents and check import lines):**

1. `test("legacy/parsers.ts exports parseRoadmap, parsePlan, parseSummary")` — Read `src/resources/extensions/gsd/legacy/parsers.ts` (if it exists). Assert it contains `export function parseRoadmap(`, `export function parsePlan(`, `export function parseSummary(`. This will fail (RED) until Plan 4-01 Task 1 creates the file.

2. `test("files.ts does not export parseRoadmap, parsePlan, or parseSummary")` — Read `src/resources/extensions/gsd/files.ts`. Assert it does NOT contain `export function parseRoadmap(` etc. This will fail (RED) until Plan 4-01 Task 1 removes them.

3. `test("doctor-checks.ts does not import from legacy/parsers")` — Read `src/resources/extensions/gsd/doctor-checks.ts`. Assert it does NOT contain `from "./legacy/parsers` or `from '../legacy/parsers`. This passes immediately (doctor-checks.ts currently imports from files.ts, not legacy/parsers — and after Plan 4-01, it won't import parse functions at all).

4. `test("auto-recovery.ts does not import from legacy/parsers")` — Same pattern. Hot-path files must never use legacy parsers.

5. `test("state.ts does not import parseRoadmap/parsePlan/parseSummary from files.ts")` — Read state.ts, find all `from "./files.js"` or `from '../files.js'` import lines, assert none contain parseRoadmap/parsePlan/parseSummary. This will fail (RED) until Plans 4-01 and 4-03 clean up state.ts.

Use `path.resolve(__dirname, "..")` to build absolute paths to the source files. Use `readFileSync(filePath, "utf-8")` for reading.
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -10 && npm run test:unit -- --test-name-pattern "import-boundary" 2>&1 | tail -20</automated>
  </verify>
  <done>import-boundary.test.ts exists with 5 tests. TypeScript compiles. Tests 3-4 pass immediately. Tests 1-2 and 5 are RED (expected — legacy/parsers.ts doesn't exist yet and files.ts still exports parse functions).</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` passes (test files compile)
- `npm run test:unit -- --test-name-pattern "import-boundary"` runs (some tests RED, some GREEN — that's expected for Wave 0)
- New test file `import-boundary.test.ts` exists
- `doctor-runtime.test.ts` contains `checkEngineHealth` test descriptions
- `auto-recovery.test.ts` contains `writeBlockerPlaceholder` removal test
</verification>

<success_criteria>
- All 4 test files compile with TypeScript
- Import boundary tests that check current code (tests 3-4) pass GREEN
- Test scaffolds for not-yet-implemented code (checkEngineHealth, removed exports) exist and are either RED or marked TODO
- Plans 4-01, 4-02, 4-03 verify commands will now exercise real test cases
</success_criteria>

<output>
After completion, create `.planning/phases/04-remove-parsing-from-hot-path/4-00-SUMMARY.md`
</output>
