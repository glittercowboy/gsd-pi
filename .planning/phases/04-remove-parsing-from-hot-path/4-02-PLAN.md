---
phase: 04-remove-parsing-from-hot-path
plan: 02
type: execute
wave: 3
depends_on: [4-01]
files_modified:
  - src/resources/extensions/gsd/doctor-checks.ts
  - src/resources/extensions/gsd/doctor-proactive.ts
  - src/resources/extensions/gsd/doctor.ts
autonomous: true
requirements: [DOC-01, DOC-02, DOC-03, DOC-04, DOC-05]

must_haves:
  truths:
    - "gsd doctor no longer attempts checkbox/file mismatch reconciliation"
    - "gsd doctor no longer generates placeholder summaries"
    - "gsd doctor detects DB constraint violations (orphaned tasks, orphaned slices, done-tasks-without-summaries)"
    - "gsd doctor detects and auto-repairs projection drift"
    - "Health scoring no longer escalates on bookkeeping/reconciliation fix counts"
    - "Git health, disk health, environment health, provider health checks still run unchanged"
  artifacts:
    - path: "src/resources/extensions/gsd/doctor-checks.ts"
      provides: "checkRuntimeHealth without reconciliation + new checkEngineHealth"
      contains: "checkEngineHealth"
    - path: "src/resources/extensions/gsd/doctor-proactive.ts"
      provides: "preDispatchHealthGate with projection drift check, no bookkeeping escalation"
      contains: "projection"
    - path: "src/resources/extensions/gsd/doctor.ts"
      provides: "runGSDDoctor orchestration calling checkEngineHealth"
      contains: "checkEngineHealth"
  key_links:
    - from: "src/resources/extensions/gsd/doctor-checks.ts"
      to: "src/resources/extensions/gsd/gsd-db.ts"
      via: "_getAdapter() for DB constraint checks"
      pattern: "_getAdapter"
    - from: "src/resources/extensions/gsd/doctor-proactive.ts"
      to: "src/resources/extensions/gsd/workflow-events.ts"
      via: "readEvents for projection drift timestamp"
      pattern: "readEvents"
    - from: "src/resources/extensions/gsd/doctor-proactive.ts"
      to: "src/resources/extensions/gsd/workflow-projections.ts"
      via: "renderAllProjections for drift repair"
      pattern: "renderAllProjections"
---

<objective>
Gut reconciliation/bookkeeping checks from the doctor system and add engine-native diagnostics. Remove checkbox/file mismatch reconciliation (DOC-01), placeholder summary generation (DOC-02), bookkeeping health scoring (DOC-03). Keep infrastructure health checks (DOC-04). Add DB constraint violation detection and projection drift detection/repair (DOC-05).

Purpose: Doctor becomes an infrastructure diagnostics tool, not a state reconciliation tool. With the engine as single writer, state reconciliation is impossible by design.
Output: Cleaned doctor-checks.ts, doctor-proactive.ts, doctor.ts with new checkEngineHealth() function.
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
@.planning/phases/04-remove-parsing-from-hot-path/4-01-SUMMARY.md

<interfaces>
From src/resources/extensions/gsd/gsd-db.ts:
```typescript
export function _getAdapter(): DbAdapter | null;
export function isDbAvailable(): boolean;
```

From src/resources/extensions/gsd/workflow-engine.ts:
```typescript
export class WorkflowEngine {
  getMilestone(id: string): MilestoneRow | null;
  getMilestones(): MilestoneRow[];
  getSlice(milestoneId: string, sliceId: string): SliceRow | null;
  getSlices(milestoneId: string): SliceRow[];
  getTask(milestoneId: string, sliceId: string, taskId: string): TaskRow | null;
  getTasks(milestoneId: string, sliceId: string): TaskRow[];
  deriveState(): GSDState;
}
export function getEngine(basePath: string): WorkflowEngine;
export function isEngineAvailable(basePath: string): boolean;
```

From src/resources/extensions/gsd/workflow-events.ts:
```typescript
export function readEvents(logPath: string): WorkflowEvent[];
```

From src/resources/extensions/gsd/workflow-projections.ts:
```typescript
export function renderAllProjections(basePath: string, milestoneId: string): void;
```

Doctor issue type (used by all checks):
```typescript
interface DoctorIssue {
  severity: "error" | "warning" | "info";
  code: string;
  scope: string;
  unitId: string;
  message: string;
  fixable: boolean;
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Remove reconciliation checks from doctor-checks.ts + add checkEngineHealth()</name>
  <files>
    src/resources/extensions/gsd/doctor-checks.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/doctor-checks.ts
    src/resources/extensions/gsd/workflow-engine.ts
    src/resources/extensions/gsd/gsd-db.ts
    src/resources/extensions/gsd/workflow-events.ts
    src/resources/extensions/gsd/workflow-projections.ts
  </read_first>
  <action>
**Removals from checkRuntimeHealth() per D-01:**

1. Remove orphaned completed-units key validation (approximately lines 503-546 — the section that reads completed-units.json keys and checks if corresponding files exist). This was compensating for split-brain state. Look for code referencing `completed-units.json`, `orphaned_completed_units`, or `completedKeys`.

2. Remove STATE.md drift detection and repair (approximately lines 650-850 — the section that compares STATE.md content against derived state and rewrites it). Look for code referencing `state_md_drift`, `state_md_stale`, `buildStateMarkdown`, or `STATE.md` content comparison. Keep the simple "STATE.md missing" file-existence check but replace the fix with a call to `renderStateProjection(basePath)` from workflow-projections.ts (import it).

3. Remove any check that calls `verifyExpectedArtifact()` for checkbox state verification. These are internal to checkRuntimeHealth and reference `verifyExpectedArtifact` from auto-recovery.ts.

4. Remove the `parseRoadmap` usage sites in checkGitHealth (lines ~57, ~104 — these parse roadmaps for orphaned worktree and stale branch checks). Replace with engine queries:
   - Line ~57 (orphaned worktree check): Replace `parseRoadmap(roadmapContent).slices.find(...)` with `engine.getSlice(milestoneId, sliceId)` check. Use `const { WorkflowEngine } = await import("./workflow-engine.js")` if checkGitHealth is async, or static import if sync. Guard with `isEngineAvailable(basePath)`.
   - Line ~104 (stale branch check): Same pattern — replace parseRoadmap call with engine.getSlice() query.

**Keeps per D-02:** crash lock cleanup (auto.lock), stranded lock directories, stale parallel sessions, stale hook state cleanup, activity log bloat/archival, gitignore drift, snapshot ref pruning. DO NOT touch these sections.

**New function: checkEngineHealth() per D-08, D-09, D-10:**

Add a new exported function `checkEngineHealth(basePath: string, issues: DoctorIssue[], fixesApplied: string[])` that runs:

1. **DB constraint violation detection** (runs only in full doctor, not pre-dispatch per D-10):
   - Guard: `if (!isDbAvailable()) return;`
   - Get adapter: `const adapter = _getAdapter()!;`
   - Wrap all queries in try/catch (non-fatal per established pattern).

   a. Orphaned tasks (task.slice_id points to non-existent slice):
   ```sql
   SELECT t.id, t.slice_id, t.milestone_id
   FROM tasks t
   LEFT JOIN slices s ON t.milestone_id = s.milestone_id AND t.slice_id = s.id
   WHERE s.id IS NULL
   ```
   Push issue with `code: "db_orphaned_task"`, `severity: "error"`, `fixable: false`.

   b. Orphaned slices (slice.milestone_id points to non-existent milestone):
   ```sql
   SELECT s.id, s.milestone_id
   FROM slices s
   LEFT JOIN milestones m ON s.milestone_id = m.id
   WHERE m.id IS NULL
   ```
   Push issue with `code: "db_orphaned_slice"`, `severity: "error"`, `fixable: false`.

   c. Tasks marked complete without summaries:
   ```sql
   SELECT id, slice_id, milestone_id FROM tasks
   WHERE status = 'done' AND (summary IS NULL OR summary = '')
   ```
   Push issue with `code: "db_done_task_no_summary"`, `severity: "warning"`, `fixable: false`.

   d. Duplicate entity IDs (safety check):
   ```sql
   SELECT id, COUNT(*) as cnt FROM milestones GROUP BY id HAVING cnt > 1
   ```
   (Repeat for slices and tasks tables.)
   Push issue with `code: "db_duplicate_id"`, `severity: "error"`, `fixable: false`.

2. **Projection drift detection** (also runs in pre-dispatch per D-10):
   - Get most recent event from the event log: `const events = readEvents(eventLogPath)` where eventLogPath is `path.join(basePath, ".gsd", "event-log.jsonl")`.
   - If no events, skip.
   - Get `lastEventTs = new Date(events[events.length - 1]!.ts).getTime()`.
   - For each active milestone (`engine.getMilestones().filter(m => m.status === "active")`):
     - Check if the ROADMAP.md projection file exists and compare its mtime to lastEventTs.
     - If missing or stale (eventTs > mtime): call `renderAllProjections(basePath, milestoneId)` in a try/catch, push to fixesApplied.
   - This is non-fatal — any error is silently caught.

Add imports at the top of doctor-checks.ts:
```typescript
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { readEvents } from "./workflow-events.js";
import { renderAllProjections, renderStateProjection } from "./workflow-projections.js";
import { isEngineAvailable, WorkflowEngine } from "./workflow-engine.js";
```

Remove the import of parseRoadmap from files.js (should already be done by Plan 01).
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -30 && npm run test:unit -- --test-name-pattern "doctor" 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `doctor-checks.ts` contains `export function checkEngineHealth(`
    - `doctor-checks.ts` contains `db_orphaned_task`
    - `doctor-checks.ts` contains `db_orphaned_slice`
    - `doctor-checks.ts` contains `db_done_task_no_summary`
    - `doctor-checks.ts` contains `db_duplicate_id`
    - `doctor-checks.ts` contains `renderAllProjections`
    - `doctor-checks.ts` does NOT contain `orphaned_completed_units`
    - `doctor-checks.ts` does NOT contain `parseRoadmap`
    - `doctor-checks.ts` does NOT contain `state_md_drift` or `state_md_stale` (unless renamed to projection-based check)
    - `doctor-checks.ts` contains `import { _getAdapter, isDbAvailable } from "./gsd-db.js"`
    - `doctor-checks.ts` contains `import { readEvents } from "./workflow-events.js"`
    - TypeScript compiles (`npx tsc --noEmit` exits 0)
  </acceptance_criteria>
  <done>checkRuntimeHealth has no reconciliation checks. checkEngineHealth exists with all 4 DB constraint checks and projection drift detection. parseRoadmap calls replaced with engine queries.</done>
</task>

<task type="auto">
  <name>Task 2: Remove bookkeeping escalation from doctor-proactive.ts + add pre-dispatch projection drift</name>
  <files>
    src/resources/extensions/gsd/doctor-proactive.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/doctor-proactive.ts
    src/resources/extensions/gsd/doctor-checks.ts
    src/resources/extensions/gsd/workflow-events.ts
    src/resources/extensions/gsd/workflow-projections.ts
  </read_first>
  <action>
**Removals from doctor-proactive.ts per D-04:**

1. Remove health scoring that includes reconciliation fix counts. Look for `consecutiveErrorUnits` tracking that counts "state drift" errors, and any escalation gate that references "consecutive error units caused by state drift" or "bookkeeping failures". The pattern is: if N consecutive units had state-drift fixes, escalate to full doctor. This is dead logic — state drift cannot happen with the engine.

2. Keep: health snapshot recording (writeHealthSnapshot), trend detection (detectTrend or similar), pre-dispatch health gate for git/merge state (preDispatchHealthGate checking git status, merge conflicts).

**Addition per D-10: Pre-dispatch projection drift check:**

In `preDispatchHealthGate()`, add a projection drift check that runs BEFORE dispatch:
- Import `readEvents` from `./workflow-events.js`
- Import `renderAllProjections` from `./workflow-projections.js`
- Import `isEngineAvailable, WorkflowEngine` from `./workflow-engine.js`
- After existing git/merge checks, add:
  ```typescript
  // Projection drift repair (fast, <50ms per D-10)
  try {
    if (isEngineAvailable(basePath)) {
      const eventLogPath = path.join(basePath, ".gsd", "event-log.jsonl");
      const events = readEvents(eventLogPath);
      if (events.length > 0) {
        const lastEventTs = new Date(events[events.length - 1]!.ts).getTime();
        const engine = new WorkflowEngine(basePath);
        for (const milestone of engine.getMilestones()) {
          if (milestone.status !== "active") continue;
          const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
          if (!roadmapPath || !existsSync(roadmapPath)) {
            renderAllProjections(basePath, milestone.id);
            fixesApplied.push(`re-rendered missing projections for ${milestone.id}`);
            continue;
          }
          const projectionMtime = statSync(roadmapPath).mtimeMs;
          if (lastEventTs > projectionMtime) {
            renderAllProjections(basePath, milestone.id);
            fixesApplied.push(`re-rendered stale projections for ${milestone.id}`);
          }
        }
      }
    }
  } catch { /* non-fatal — projection drift repair must never block dispatch */ }
  ```
  Use the appropriate path resolution function already available in the codebase (`resolveMilestoneFile` from paths.ts or equivalent).
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -20 && npm run test:unit -- --test-name-pattern "doctor-proactive" 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `doctor-proactive.ts` does NOT contain escalation logic for "state drift" or "bookkeeping" fix counts
    - `doctor-proactive.ts` contains `renderAllProjections` (projection drift repair in pre-dispatch)
    - `doctor-proactive.ts` contains `readEvents` (event log timestamp for drift detection)
    - `doctor-proactive.ts` still contains `preDispatchHealthGate` function
    - `doctor-proactive.ts` still contains health snapshot recording function
    - TypeScript compiles (`npx tsc --noEmit` exits 0)
  </acceptance_criteria>
  <done>doctor-proactive.ts has no bookkeeping escalation. preDispatchHealthGate includes fast projection drift repair. Health snapshot and trend detection preserved.</done>
</task>

<task type="auto">
  <name>Task 3: Wire checkEngineHealth into runGSDDoctor + remove parse calls from doctor.ts</name>
  <files>
    src/resources/extensions/gsd/doctor.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/doctor.ts
    src/resources/extensions/gsd/doctor-checks.ts
  </read_first>
  <action>
1. In doctor.ts, add import for the new checkEngineHealth function:
   ```typescript
   import { checkEngineHealth } from "./doctor-checks.js";
   ```

2. In `runGSDDoctor()`, add a call to `checkEngineHealth(basePath, issues, fixesApplied)` after the existing `checkRuntimeHealth()` call. This ensures DB constraint checks run as part of full doctor (not pre-dispatch, per D-10).

3. Remove all `parseRoadmap`, `parsePlan`, `parseSummary` usage in doctor.ts. The Plan 01 summary should confirm that parse imports were already removed. Now remove/replace the actual call sites:
   - Line ~377: `parseRoadmap(roadmapContent)` — this is in the slice verification section. Replace with engine query: `const engine = new WorkflowEngine(basePath); const slices = engine.getSlices(milestoneId);`
   - Line ~632: `parseRoadmap(roadmapContent)` — this is in the summary/completion section. Replace with engine query.
   - Line ~751: `parsePlan(planContent)` — this is in the must-haves verification section. Replace with engine query: `const tasks = engine.getTasks(milestoneId, sliceId);`
   - For each replacement, guard with `isEngineAvailable(basePath)` and fall back gracefully (skip the check) if engine not available.

4. Remove placeholder summary generation (D-03): Find any code in doctor.ts that generates placeholder summaries (writing default/stub SUMMARY.md files for incomplete tasks). The engine's `completeTask()` atomically creates summaries — if no summary exists, the task isn't complete. Remove the placeholder generation entirely.

5. Add imports:
   ```typescript
   import { isEngineAvailable, WorkflowEngine } from "./workflow-engine.js";
   ```

6. Remove the `parsePlan, parseRoadmap, parseSummary` from the files.js import line (should already be stripped by Plan 01; verify and clean up any remaining TODO comments).
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -20 && npm run test:unit -- --test-name-pattern "doctor" 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `doctor.ts` contains `import { checkEngineHealth } from "./doctor-checks.js"`
    - `doctor.ts` contains `checkEngineHealth(` call inside runGSDDoctor
    - `doctor.ts` does NOT contain `parseRoadmap(`
    - `doctor.ts` does NOT contain `parsePlan(`
    - `doctor.ts` does NOT contain `parseSummary(`
    - `doctor.ts` does NOT contain `placeholder` in the context of summary generation
    - `doctor.ts` contains `WorkflowEngine` or `isEngineAvailable` (engine queries replacing parse calls)
    - TypeScript compiles (`npx tsc --noEmit` exits 0)
    - Doctor tests pass (`npm run test:unit -- --test-name-pattern "doctor"`)
  </acceptance_criteria>
  <done>runGSDDoctor calls checkEngineHealth for DB constraint + projection drift checks. All parseRoadmap/parsePlan/parseSummary calls in doctor.ts replaced with engine queries. Placeholder summary generation removed.</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` passes
- `npm run test:unit -- --test-name-pattern "doctor"` passes
- `grep -rn 'parseRoadmap\|parsePlan\|parseSummary' src/resources/extensions/gsd/doctor-checks.ts src/resources/extensions/gsd/doctor.ts src/resources/extensions/gsd/doctor-proactive.ts` returns empty
- `grep -n 'checkEngineHealth' src/resources/extensions/gsd/doctor-checks.ts src/resources/extensions/gsd/doctor.ts` shows export in doctor-checks.ts and call in doctor.ts
</verification>

<success_criteria>
- Doctor no longer does checkbox/file reconciliation (DOC-01)
- Doctor no longer generates placeholder summaries (DOC-02)
- Health scoring has no bookkeeping escalation (DOC-03)
- Git/disk/env/provider health checks still work (DOC-04)
- checkEngineHealth detects orphaned tasks/slices, done-tasks-without-summaries, duplicate IDs, and projection drift (DOC-05)
- Pre-dispatch health gate includes fast projection drift repair
- All TypeScript compiles clean, all doctor tests pass
</success_criteria>

<output>
After completion, create `.planning/phases/04-remove-parsing-from-hot-path/4-02-SUMMARY.md`
</output>
