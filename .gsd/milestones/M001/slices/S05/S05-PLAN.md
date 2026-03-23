# S05: Warm/cold callers + flag files + pre-M002 migration

**Goal:** All non-hot-path parseRoadmap/parsePlan callers migrated to DB queries with lazy parser fallback. REPLAN.md and REPLAN-TRIGGER.md flag-file detection in deriveStateFromDb() replaced with DB table/column queries. migrateHierarchyToDb() populates v8 planning columns from parsed markdown.
**Demo:** `grep -rn 'import.*parseRoadmap\|import.*parsePlan' src/resources/extensions/gsd/*.ts | grep -v '/tests/' | grep -v 'md-importer' | grep -v 'files.ts'` returns only lazy `createRequire` references and markdown-renderer.ts lazy imports. Flag-file phase detection works without disk files when DB is seeded.

## Must-Haves

- Schema v10 adds `replan_triggered_at TEXT` column to slices table (both CREATE TABLE DDL and migration block)
- `deriveStateFromDb()` uses `getReplanHistory()` for REPLAN detection and `replan_triggered_at` column for REPLAN-TRIGGER detection instead of `resolveSliceFile()` disk checks
- `triage-resolution.ts` `executeReplan()` writes `replan_triggered_at` column in addition to disk file
- `migrateHierarchyToDb()` passes `planning: { vision, successCriteria, boundaryMapMarkdown }` to `insertMilestone()`, `planning: { goal }` to `insertSlice()`, and `files`/`verify` to `insertTask()`
- All 13 warm/cold caller files have module-level `parseRoadmap`/`parsePlan` imports replaced with `isDbAvailable()` gate + lazy `createRequire` fallback (or dynamic import for async callers)
- `markdown-renderer.ts` validation moves parser import from module-level to lazy `createRequire` (keeps parser calls — they're intentional disk-vs-DB comparison)
- CONTINUE.md and CONTEXT-DRAFT.md migration NOT touched per D003 (locked, non-revisable)
- All existing tests pass (no regressions)

## Proof Level

- This slice proves: integration (DB queries replace parser calls across 13+ files)
- Real runtime required: no (unit tests with seeded DBs prove behavior)
- Human/UAT required: no

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flag-file-db.test.ts` — flag-file DB migration tests pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-recover.test.ts` — extended recovery tests pass (v8 column population)
- `grep -rn 'import.*parseRoadmap\|import.*parsePlan\|import.*parseRoadmapSlices' src/resources/extensions/gsd/*.ts | grep -v '/tests/' | grep -v 'md-importer' | grep -v 'files.ts'` — returns zero module-level imports (only lazy createRequire references)
- Regression suites: doctor.test.ts, auto-recovery.test.ts, auto-dashboard.test.ts, derive-state-db.test.ts, derive-state-crossval.test.ts, planning-crossval.test.ts, markdown-renderer.test.ts all pass

## Observability / Diagnostics

- Runtime signals: `replan_triggered_at` column on slices table records when triage writes a replan trigger; `replan_history` table rows indicate completed replans — both queryable via SQL
- Inspection surfaces: `SELECT id, replan_triggered_at FROM slices WHERE milestone_id = :mid` shows trigger state; `SELECT * FROM replan_history WHERE milestone_id = :mid AND slice_id = :sid` shows replan completion
- Failure visibility: `isDbAvailable()` gate in all migrated callers writes to stderr when falling back to parser — detectable in logs
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `getReplanHistory()` from S03, `getMilestoneSlices()`/`getSliceTasks()`/`getTask()` from S01/S02, `isDbAvailable()` + lazy `createRequire` pattern from S04
- New wiring introduced: `replan_triggered_at` column writer in `triage-resolution.ts`, v8 column population in `migrateHierarchyToDb()`
- What remains before the milestone is truly usable end-to-end: S06 (parser deprecation + cleanup — removes dead parser code from hot paths)

## Tasks

- [x] **T01: Schema v10 + flag-file DB migration in deriveStateFromDb** `est:45m`
  - Why: The architecturally novel piece — REPLAN.md and REPLAN-TRIGGER.md detection in `deriveStateFromDb()` must use DB queries instead of disk-file checks. Schema v10 adds the `replan_triggered_at` column. Triage-resolution must also write the column.
  - Files: `src/resources/extensions/gsd/gsd-db.ts`, `src/resources/extensions/gsd/state.ts`, `src/resources/extensions/gsd/triage-resolution.ts`, `src/resources/extensions/gsd/tests/flag-file-db.test.ts`
  - Do: (1) Bump SCHEMA_VERSION to 10, add `replan_triggered_at TEXT DEFAULT NULL` to slices CREATE TABLE DDL and v10 migration block. (2) Update `SliceRow` interface and `rowToSlice()`. (3) In `deriveStateFromDb()`, replace `resolveSliceFile(... "REPLAN")` with `getReplanHistory(mid, sid).length > 0` check, replace `resolveSliceFile(... "REPLAN-TRIGGER")` with checking `getSlice(mid, sid)?.replan_triggered_at`. (4) In `triage-resolution.ts` `executeReplan()`, after writing the disk file, also write the `replan_triggered_at` column via `UPDATE slices SET replan_triggered_at = :ts`. (5) Write `flag-file-db.test.ts` testing: blocker→replan detection via DB (no disk file), REPLAN-TRIGGER via DB column (no disk file), loop protection (replan_history exists = no replanning phase).
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flag-file-db.test.ts`
  - Done when: deriveStateFromDb returns phase='replanning-slice' from DB-only data (no REPLAN.md or REPLAN-TRIGGER.md on disk) and returns phase='executing' when replan_history exists (loop protection). SCHEMA_VERSION=10.

- [ ] **T02: Extend migrateHierarchyToDb with v8 column population** `est:30m`
  - Why: Existing projects migrating to the DB need their parsed ROADMAP/PLAN data written into the v8 planning columns so DB queries return meaningful data. The `gsd recover` test must verify this.
  - Files: `src/resources/extensions/gsd/md-importer.ts`, `src/resources/extensions/gsd/tests/gsd-recover.test.ts`
  - Do: (1) In `migrateHierarchyToDb()`, extend the `insertMilestone()` call to pass `planning: { vision: roadmap.vision, successCriteria: roadmap.successCriteria, boundaryMapMarkdown: boundaryMapSection }` where `boundaryMapMarkdown` is the raw "## Boundary Map" section extracted from the roadmap content. (2) Extend `insertSlice()` calls to pass `planning: { goal: plan.goal }` from the parsed plan (when plan exists). (3) Extend `insertTask()` calls to pass `planning: { files: task.files, verify: task.verify }` from TaskPlanEntry. (4) Extend `gsd-recover.test.ts` to assert: after recover, milestone has non-empty `vision`; slice has non-empty `goal`; task has populated `files` array and `verify` string.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-recover.test.ts`
  - Done when: migrateHierarchyToDb populates vision, successCriteria, boundaryMapMarkdown on milestones; goal on slices; files and verify on tasks. Recovery test proves it.

- [ ] **T03: Migrate warm/cold callers batch 1 — doctor, visualizer, workspace, dashboard, guided-flow** `est:40m`
  - Why: Seven files with straightforward parseRoadmap/parsePlan usage need the S04 isDbAvailable + lazy createRequire pattern applied.
  - Files: `src/resources/extensions/gsd/doctor.ts`, `src/resources/extensions/gsd/doctor-checks.ts`, `src/resources/extensions/gsd/visualizer-data.ts`, `src/resources/extensions/gsd/workspace-index.ts`, `src/resources/extensions/gsd/dashboard-overlay.ts`, `src/resources/extensions/gsd/auto-dashboard.ts`, `src/resources/extensions/gsd/guided-flow.ts`
  - Do: For each file: (1) Remove module-level `parseRoadmap`/`parsePlan` from the import statement. (2) At each call site, add `isDbAvailable()` gate calling `getMilestoneSlices()`/`getSliceTasks()` for the DB path. (3) Add lazy `createRequire`-based fallback loading the parser for non-DB path. (4) For `parsePlan().filesLikelyTouched` aggregation in callers: collect `.files` arrays from `getSliceTasks()` results. (5) Keep other non-parser imports (loadFile, parseSummary, etc.) as module-level. Note: these files are async or synchronous — check each. For async callers, dynamic `import()` is also acceptable. Follow the exact pattern from `dispatch-guard.ts` (S04).
  - Verify: `grep -n 'import.*parseRoadmap\|import.*parsePlan' src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/doctor-checks.ts src/resources/extensions/gsd/visualizer-data.ts src/resources/extensions/gsd/workspace-index.ts src/resources/extensions/gsd/dashboard-overlay.ts src/resources/extensions/gsd/auto-dashboard.ts src/resources/extensions/gsd/guided-flow.ts` returns zero results. Existing test suites pass.
  - Done when: Zero module-level parseRoadmap/parsePlan imports in these 7 files. All existing tests for these files pass.

- [ ] **T04: Migrate warm/cold callers batch 2 — auto-prompts, auto-recovery, auto-direct-dispatch, auto-worktree, reactive-graph, markdown-renderer + final verification** `est:50m`
  - Why: The remaining 6 files include auto-prompts.ts (6 parser calls, 1649 lines, highest complexity) and markdown-renderer.ts (intentional parser usage → lazy import only). Final grep verification confirms zero module-level parser imports remain.
  - Files: `src/resources/extensions/gsd/auto-prompts.ts`, `src/resources/extensions/gsd/auto-recovery.ts`, `src/resources/extensions/gsd/auto-direct-dispatch.ts`, `src/resources/extensions/gsd/auto-worktree.ts`, `src/resources/extensions/gsd/reactive-graph.ts`, `src/resources/extensions/gsd/markdown-renderer.ts`
  - Do: (1) **auto-prompts.ts** — all functions are async, so use dynamic `import("./gsd-db.js")` pattern (already used in this file for decisions/requirements). For `inlineDependencySummaries`: replace `parseRoadmap(roadmapContent).slices.find(s => s.id === sid)?.depends` with `getSlice(mid, sid)?.depends`. For `checkNeedsReassessment`/`checkNeedsRunUat`: replace `parseRoadmap().slices` with `getMilestoneSlices(mid)`, map `s.done` to `s.status === 'complete'`. For `buildCompleteMilestonePrompt`/`buildValidateMilestonePrompt`: replace slice iteration with `getMilestoneSlices()`. For `buildResumeContextListing` parsePlan: replace with `getSliceTasks()` to find incomplete tasks. Keep `parseSummary`, `parseContinue`, `loadFile`, `parseTaskPlanFile` imports — those aren't in scope. (2) **auto-recovery.ts** — the `parsePlan` at line 370 replaces with `getSliceTasks()` to check task plan files exist. The `parseRoadmap` at line 407 is already inside an `!isDbAvailable()` block — leave it, just move to lazy import. (3) **auto-direct-dispatch.ts** — replace 2 `parseRoadmap` calls with `getMilestoneSlices()` behind `isDbAvailable()` gate. (4) **auto-worktree.ts** — replace 1 `parseRoadmap` call with `getMilestoneSlices()`. (5) **reactive-graph.ts** — replace 1 `parsePlan` call with `getSliceTasks()`. Also uses `parseTaskPlanIO` — keep that as-is (not a planning parser). (6) **markdown-renderer.ts** — move `parseRoadmap`/`parsePlan` from module-level import to lazy `createRequire` (the parser calls are intentional disk-vs-DB comparison in `findStaleArtifacts()`). (7) Run final grep to confirm zero module-level parser imports remain across all non-test, non-md-importer, non-files.ts source files.
  - Verify: `grep -rn 'import.*parseRoadmap\|import.*parsePlan\|import.*parseRoadmapSlices' src/resources/extensions/gsd/*.ts | grep -v '/tests/' | grep -v 'md-importer' | grep -v 'files.ts'` returns zero results. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-recovery.test.ts` passes.
  - Done when: Zero module-level parseRoadmap/parsePlan/parseRoadmapSlices imports in any non-test, non-md-importer, non-files.ts source file. All existing test suites pass.

## Files Likely Touched

- `src/resources/extensions/gsd/gsd-db.ts`
- `src/resources/extensions/gsd/state.ts`
- `src/resources/extensions/gsd/triage-resolution.ts`
- `src/resources/extensions/gsd/md-importer.ts`
- `src/resources/extensions/gsd/doctor.ts`
- `src/resources/extensions/gsd/doctor-checks.ts`
- `src/resources/extensions/gsd/visualizer-data.ts`
- `src/resources/extensions/gsd/workspace-index.ts`
- `src/resources/extensions/gsd/dashboard-overlay.ts`
- `src/resources/extensions/gsd/auto-dashboard.ts`
- `src/resources/extensions/gsd/guided-flow.ts`
- `src/resources/extensions/gsd/reactive-graph.ts`
- `src/resources/extensions/gsd/auto-direct-dispatch.ts`
- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/auto-recovery.ts`
- `src/resources/extensions/gsd/auto-prompts.ts`
- `src/resources/extensions/gsd/markdown-renderer.ts`
- `src/resources/extensions/gsd/tests/flag-file-db.test.ts`
- `src/resources/extensions/gsd/tests/gsd-recover.test.ts`
