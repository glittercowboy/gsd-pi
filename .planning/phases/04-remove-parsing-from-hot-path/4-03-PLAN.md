---
phase: 04-remove-parsing-from-hot-path
plan: 03
type: execute
wave: 3
depends_on: [4-01]
files_modified:
  - src/resources/extensions/gsd/auto-recovery.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/forensics.ts
  - src/resources/extensions/gsd/guided-flow.ts
  - src/resources/extensions/gsd/state.ts
autonomous: true
requirements: [DOC-01, DOC-02]

must_haves:
  truths:
    - "verifyExpectedArtifact uses engine queries for task/slice status, not markdown parsing"
    - "writeBlockerPlaceholder and skipExecuteTask are removed from auto-recovery.ts"
    - "selfHealRuntimeRecords is removed from auto-recovery.ts"
    - "All callers of removed functions are updated (auto.ts, guided-flow.ts)"
    - "forensics.ts uses event log queries instead of completed-units.json"
    - "state.ts hot-path parse calls are replaced with engine queries"
  artifacts:
    - path: "src/resources/extensions/gsd/auto-recovery.ts"
      provides: "Simplified recovery with engine queries, no markdown parsing"
    - path: "src/resources/extensions/gsd/forensics.ts"
      provides: "Event-log-based anomaly detection"
    - path: "src/resources/extensions/gsd/auto.ts"
      provides: "Updated callers of removed recovery functions"
  key_links:
    - from: "src/resources/extensions/gsd/auto-recovery.ts"
      to: "src/resources/extensions/gsd/workflow-engine.ts"
      via: "WorkflowEngine queries replacing parse calls"
      pattern: "WorkflowEngine"
    - from: "src/resources/extensions/gsd/forensics.ts"
      to: "src/resources/extensions/gsd/workflow-events.ts"
      via: "readEvents replacing loadCompletedKeys"
      pattern: "readEvents"
    - from: "src/resources/extensions/gsd/auto.ts"
      to: "src/resources/extensions/gsd/workflow-engine.ts"
      via: "engine.reportBlocker replacing writeBlockerPlaceholder/skipExecuteTask"
      pattern: "reportBlocker"
---

<objective>
Remove split-brain recovery functions from auto-recovery.ts (writeBlockerPlaceholder, skipExecuteTask, selfHealRuntimeRecords), simplify verifyExpectedArtifact to use engine queries, update all callers in auto.ts and guided-flow.ts, and replace completed-units.json inspection in forensics.ts with event log queries. Also clean up remaining parse calls in state.ts.

Purpose: The last hot-path files still referencing markdown parsers or split-brain recovery logic are cleaned up. After this, no dispatch/state-derivation path touches markdown parsers.
Output: Simplified auto-recovery.ts, updated auto.ts callers, event-log-based forensics.ts, clean state.ts.
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
  reportBlocker(milestoneId: string, sliceId: string, taskId: string, description: string): void;
}
export function getEngine(basePath: string): WorkflowEngine;
export function isEngineAvailable(basePath: string): boolean;
```

From src/resources/extensions/gsd/workflow-events.ts:
```typescript
export interface WorkflowEvent {
  ts: string;
  cmd: string;
  params: Record<string, unknown>;
  hash: string;
  actor?: string;
}
export function readEvents(logPath: string): WorkflowEvent[];
```

From src/resources/extensions/gsd/workflow-projections.ts:
```typescript
export function renderAllProjections(basePath: string, milestoneId: string): void;
```

Functions being REMOVED from auto-recovery.ts:
- writeBlockerPlaceholder(unitType, unitId, basePath, reason) — replaced by engine.reportBlocker()
- skipExecuteTask(basePath, milestoneId, sliceId, taskId, reason) — replaced by engine.reportBlocker()
- selfHealRuntimeRecords(basePath, ctx) — no replacement needed, engine is authoritative

Functions being KEPT in auto-recovery.ts (per D-06):
- resolveExpectedArtifactPath() — path resolution, not state parsing
- reconcileMergeState() — git infrastructure health
- hasImplementationArtifacts() — git inspection, not state
- buildLoopRemediationSteps() — user-facing recovery guidance
- verifyExpectedArtifact() — simplified to engine queries (not removed)

Current callers of removed functions (from grep):
- auto.ts line 88: import { selfHealRuntimeRecords }
- auto.ts line 164: writeBlockerPlaceholder
- auto.ts line 166: skipExecuteTask
- auto.ts lines 1107, 1148, 1182: await selfHealRuntimeRecords(...)
- auto.ts lines 1442-1443: writeBlockerPlaceholder, skipExecuteTask (re-exported or used)
- guided-flow.ts line 692: function selfHealRuntimeRecords (separate local copy)
- guided-flow.ts line 887: selfHealRuntimeRecords(basePath, ctx)
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Simplify auto-recovery.ts — remove functions + rewrite verifyExpectedArtifact</name>
  <files>
    src/resources/extensions/gsd/auto-recovery.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/auto-recovery.ts
    src/resources/extensions/gsd/workflow-engine.ts
    src/resources/extensions/gsd/workflow-projections.ts
  </read_first>
  <action>
**Remove functions per D-05:**

1. Remove `writeBlockerPlaceholder()` (approx lines 423-463). Delete the entire function body and export.

2. Remove `skipExecuteTask()` (approx lines 495-542). Delete the entire function body and export.

3. Remove `selfHealRuntimeRecords()` (approx lines 662-729). Delete the entire function body and export. This includes all "stale record cleanup" logic.

4. Remove the `clearParseCache()` call inside `verifyExpectedArtifact()` (the parse cache clearing is no longer needed since we no longer parse). Keep the `clearParseCache` export in files.ts — other callers may use it.

**Simplify verifyExpectedArtifact() per D-07:**

The function currently has ~175 lines covering many unit type branches. Modify it branch-by-branch:

a. **`execute-task` branch** (approx lines 331-348): Currently reads plan markdown and checks checkboxes. Replace with:
   ```typescript
   if (isEngineAvailable(basePath) && mid && sid && tid) {
     const engine = new WorkflowEngine(basePath);
     const taskRow = engine.getTask(mid, sid, tid);
     if (!taskRow || taskRow.status !== "done") return false;
     if (!taskRow.summary) return false;
     // Self-healing: re-render projection if file missing
     const projPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
     if (projPath && !existsSync(projPath)) {
       try { renderAllProjections(basePath, mid); } catch { /* non-fatal */ }
     }
     return true;
   }
   ```

b. **`complete-slice` branch** (approx lines 380-407): Currently parses roadmap and checks checkbox. Replace with:
   ```typescript
   if (isEngineAvailable(basePath) && mid && sid) {
     const engine = new WorkflowEngine(basePath);
     const sliceRow = engine.getSlice(mid, sid);
     if (!sliceRow || sliceRow.status !== "done") return false;
     // UAT file existence check remains (projection artifact)
     return true;
   }
   ```

c. **`plan-slice` branch** (approx lines 354-372): Currently uses `parsePlan()` to check if tasks exist. Replace with:
   ```typescript
   if (isEngineAvailable(basePath) && mid && sid) {
     const engine = new WorkflowEngine(basePath);
     const tasks = engine.getTasks(mid, sid);
     return tasks.length > 0;
   }
   ```

d. **Other branches** (research-slice, validate-milestone, rewrite-docs, etc.): These do file-existence checks using `existsSync`, not markdown parsing. Leave them as-is — they're already correct.

e. If the engine is NOT available (legacy project that somehow hasn't been migrated), fall back to the file-existence check only (not checkbox inspection). The old checkbox-reading logic is removed entirely.

**Add imports:**
```typescript
import { WorkflowEngine, isEngineAvailable } from "./workflow-engine.js";
import { renderAllProjections } from "./workflow-projections.js";
```

Remove parseRoadmap/parsePlan imports (should already be gone from Plan 01; verify).

**Important per Pitfall 3:** verifyExpectedArtifact is a sync function. WorkflowEngine constructor is sync. `new WorkflowEngine(basePath)` is a static import at the top of the file — no dynamic import needed. auto-recovery.ts does not import from workflow-engine.ts currently (confirmed in research), so there's no circular dependency risk.
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -30 && npm run test:unit -- --test-name-pattern "auto-recovery" 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `auto-recovery.ts` does NOT contain `export function writeBlockerPlaceholder(`
    - `auto-recovery.ts` does NOT contain `export function skipExecuteTask(`
    - `auto-recovery.ts` does NOT contain `export function selfHealRuntimeRecords(`
    - `auto-recovery.ts` does NOT contain `parseRoadmap` or `parsePlan`
    - `auto-recovery.ts` contains `import { WorkflowEngine, isEngineAvailable } from "./workflow-engine.js"`
    - `auto-recovery.ts` contains `engine.getTask(` inside verifyExpectedArtifact
    - `auto-recovery.ts` contains `engine.getSlice(` inside verifyExpectedArtifact
    - `auto-recovery.ts` contains `engine.getTasks(` inside verifyExpectedArtifact
    - `auto-recovery.ts` still contains `export function resolveExpectedArtifactPath(`
    - `auto-recovery.ts` still contains `export function reconcileMergeState(`
    - `auto-recovery.ts` still contains `export function hasImplementationArtifacts(`
    - `auto-recovery.ts` still contains `export function buildLoopRemediationSteps(`
    - TypeScript compiles (may have errors in auto.ts callers — fixed in Task 2)
  </acceptance_criteria>
  <done>auto-recovery.ts has no split-brain recovery functions. verifyExpectedArtifact uses engine queries for task/slice/plan-slice status. Self-healing re-renders missing projections.</done>
</task>

<task type="auto">
  <name>Task 2: Update callers of removed functions (auto.ts, guided-flow.ts, state.ts) + forensics</name>
  <files>
    src/resources/extensions/gsd/auto.ts
    src/resources/extensions/gsd/guided-flow.ts
    src/resources/extensions/gsd/state.ts
    src/resources/extensions/gsd/forensics.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/auto.ts
    src/resources/extensions/gsd/guided-flow.ts
    src/resources/extensions/gsd/state.ts
    src/resources/extensions/gsd/forensics.ts
    src/resources/extensions/gsd/workflow-events.ts
  </read_first>
  <action>
**auto.ts — update callers of removed recovery functions:**

1. Remove imports of `selfHealRuntimeRecords`, `writeBlockerPlaceholder`, `skipExecuteTask` from auto-recovery.js (lines 88, 164, 166).

2. Replace `selfHealRuntimeRecords(s.basePath, ctx)` calls (lines ~1107, ~1148, ~1182) with no-ops or remove entirely. The engine is authoritative — stale record cleanup is meaningless. If the call sites are in a recovery path that should still do something, replace with a simple comment: `// Engine is authoritative — no stale record cleanup needed`.

3. Replace `writeBlockerPlaceholder(...)` and `skipExecuteTask(...)` usage (lines ~1442-1443 and wherever they're called) with `engine.reportBlocker()`:
   ```typescript
   const { WorkflowEngine } = await import("./workflow-engine.js");
   const engine = new WorkflowEngine(basePath);
   engine.reportBlocker(milestoneId, sliceId, taskId, reason);
   ```
   Use dynamic import here (auto.ts already uses dynamic imports for workflow-engine per Phase 1 decision 1-04).

4. If `writeBlockerPlaceholder` or `skipExecuteTask` are re-exported from auto.ts (lines ~1442-1443 suggest they might be), remove those re-exports.

**guided-flow.ts — update local selfHealRuntimeRecords:**

1. guided-flow.ts has its own local `selfHealRuntimeRecords()` function (line ~692) that is NOT the same as auto-recovery.ts's version. Read it to understand what it does.
2. If it's doing stale record cleanup (clearing dispatched records), it's also dead logic. Remove the function and its call site (line ~887).
3. If it's doing something engine-independent (like clearing lock files), keep it but rename to avoid confusion.

**state.ts — remove remaining parse calls:**

The parse imports were stripped in Plan 01, and usage sites were commented out with TODOs. Now replace them with engine queries:

1. Line ~152: `parseRoadmap(content)` — this is in the non-engine path of deriveState. Since Phase 3 completed auto-migration (deriveState now queries engine first), this code path is only hit for projects without an engine DB. Keep it as a fallback but import parseRoadmap from `"./legacy/parsers.js"` (this IS the legacy fallback path — it's permitted to use legacy parsers for projects that haven't been migrated).

2. Lines ~326, ~337: `parseRoadmap(rc)` — same fallback path logic. If these are inside the engine-available branch, replace with engine queries. If they're in the non-engine fallback branch, import from legacy/parsers.js.

3. Line ~376: `parseSummary(summaryContent)` — determine if this is in the engine path or fallback. If engine path, replace with `engine.getTask()` or `engine.getMilestone()`. If fallback, use legacy/parsers.js.

4. Lines ~730, ~822: `parsePlan(...)`, `parseSummary(...)` — same analysis. Replace engine-path calls with engine queries. Keep fallback-path calls but import from legacy/parsers.js.

**IMPORTANT for state.ts:** The non-engine fallback path in deriveState is legitimate — it handles projects that haven't been migrated yet (pre-engine projects). This path SHOULD use parsers from `legacy/parsers.js`. The key constraint is: the engine-available path must NOT use parsers. Audit each call site to determine which path it's in.

**forensics.ts — replace completed-units.json with event log per D-15, D-16:**

1. Replace `loadCompletedKeys()` (line ~293-301) — this reads completed-units.json. Replace the function body to read from event log instead:
   ```typescript
   import { readEvents } from "./workflow-events.js";
   // Replace loadCompletedKeys with event log query
   const events = readEvents(path.join(basePath, ".gsd", "event-log.jsonl"));
   const completeTaskEvents = events.filter(e => e.cmd === "complete_task");
   ```

2. Replace `detectMissingArtifacts()` (line ~367-391) — this uses completed-units.json keys to check for missing files. Replace with event-log-based detection using the pattern from RESEARCH.md Pattern 4:
   - Build task completion counts from event log
   - Detect stuck loops (same task completed >1 time)
   - Check for task events without corresponding projection files on disk

3. Import `readEvents` from `"./workflow-events.js"`.

4. Remove the `completed-units.json` file read. Note: do NOT delete the completed-units.json file itself — that's Phase 5 (CLN-01).
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -30 && npm run test:unit 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `auto.ts` does NOT contain `import { selfHealRuntimeRecords` or `import { writeBlockerPlaceholder` or `import { skipExecuteTask` from auto-recovery
    - `auto.ts` does NOT contain `selfHealRuntimeRecords(` as a function call
    - `auto.ts` does NOT contain `writeBlockerPlaceholder(` as a function call (replaced with engine.reportBlocker or removed)
    - `auto.ts` does NOT contain `skipExecuteTask(` as a function call
    - `guided-flow.ts` does NOT contain `selfHealRuntimeRecords` (local version removed)
    - `state.ts` does NOT import `parseRoadmap` or `parsePlan` or `parseSummary` from `"./files.js"` — only from `"./legacy/parsers.js"` if in fallback path
    - `forensics.ts` contains `import { readEvents } from "./workflow-events.js"`
    - `forensics.ts` does NOT contain `completed-units.json` as a file read target (or loadCompletedKeys referencing it)
    - TypeScript compiles (`npx tsc --noEmit` exits 0)
    - Full test suite passes (`npm run test:unit` exits 0)
  </acceptance_criteria>
  <done>All callers of removed recovery functions updated. state.ts engine path uses no parsers. forensics.ts uses event log instead of completed-units.json. Full test suite green.</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` passes
- `npm run test:unit` passes (full suite)
- `grep -rn 'selfHealRuntimeRecords\|skipExecuteTask\|writeBlockerPlaceholder' src/resources/extensions/gsd/auto.ts src/resources/extensions/gsd/auto-recovery.ts` returns empty (no definitions or calls)
- `grep -rn 'from "./files.js".*parseRoadmap\|from "./files.js".*parsePlan\|from "./files.js".*parseSummary' src/resources/extensions/gsd/state.ts src/resources/extensions/gsd/doctor-checks.ts src/resources/extensions/gsd/auto-recovery.ts` returns empty
- `grep -n 'loadCompletedKeys\|completed-units.json' src/resources/extensions/gsd/forensics.ts` returns empty or only comments
</verification>

<success_criteria>
- writeBlockerPlaceholder, skipExecuteTask, selfHealRuntimeRecords are gone from auto-recovery.ts
- verifyExpectedArtifact uses engine.getTask/getSlice/getTasks for status checks
- All callers in auto.ts updated (selfHealRuntimeRecords removed, blockers use engine.reportBlocker)
- forensics.ts reads event log instead of completed-units.json
- state.ts engine path has zero parse calls; fallback path uses legacy/parsers.js
- Full TypeScript compilation and test suite pass
</success_criteria>

<output>
After completion, create `.planning/phases/04-remove-parsing-from-hot-path/4-03-SUMMARY.md`
</output>
