---
phase: 05-dead-code-cleanup
plan: 02
type: execute
wave: 2
depends_on:
  - 5-01
files_modified:
  - src/resources/extensions/gsd/unit-runtime.ts
  - src/resources/extensions/gsd/auto.ts
  - src/resources/extensions/gsd/auto-post-unit.ts
  - src/resources/extensions/gsd/auto-timeout-recovery.ts
  - src/resources/extensions/gsd/auto-timers.ts
  - src/resources/extensions/gsd/auto-worktree.ts
  - src/resources/extensions/gsd/auto/phases.ts
  - src/resources/extensions/gsd/guided-flow.ts
  - src/resources/extensions/gsd/commands-maintenance.ts
  - src/resources/extensions/gsd/doctor-checks.ts
  - src/resources/extensions/gsd/git-service.ts
  - src/resources/extensions/gsd/gitignore.ts
  - src/resources/extensions/gsd/auto/detect-stuck.ts
  - src/resources/extensions/gsd/tests/unit-runtime.test.ts
  - src/resources/extensions/gsd/tests/retry-state-reset.test.ts
  - src/resources/extensions/gsd/tests/doctor-runtime.test.ts
  - src/resources/extensions/gsd/tests/milestone-transition-state-rebuild.test.ts
  - src/resources/extensions/gsd/tests/auto-loop.test.ts
  - src/resources/extensions/gsd/tests/worktree-sync-milestones.test.ts
  - src/resources/extensions/gsd/tests/git-service.test.ts
autonomous: true
requirements:
  - CLN-01
  - CLN-04
  - CLN-06

must_haves:
  truths:
    - "completed-units.json is not read or written anywhere in the codebase"
    - "unit-runtime.ts file does not exist"
    - "Stuck detection no longer contains oscillation detection (Rule 3 removed, Rules 1+2 remain)"
    - "All tests pass after removals"
  artifacts:
    - path: "src/resources/extensions/gsd/auto/detect-stuck.ts"
      provides: "Stuck detection with Rules 1+2 only"
      contains: "Rule 1"
    - path: "src/resources/extensions/gsd/auto.ts"
      provides: "Auto-mode without unit-runtime imports"
  key_links:
    - from: "src/resources/extensions/gsd/auto.ts"
      to: "workflow-engine.js"
      via: "engine task status replaces unit-runtime"
      pattern: "no import.*unit-runtime"
    - from: "src/resources/extensions/gsd/auto/phases.ts"
      to: "workflow-engine.js"
      via: "engine replaces completed-units.json tracking"
      pattern: "no completed-units"
---

<objective>
Remove completed-units.json read/write paths, delete unit-runtime.ts, and remove oscillation detection (Rule 3) from detect-stuck.ts.

Purpose: completed-units.json and unit-runtime.ts are legacy tracking mechanisms replaced by the engine's task status queries. Oscillation detection (Rule 3) produces false positives and is no longer needed with engine-based stuck detection.
Output: Deleted unit-runtime.ts, cleaned all completed-units.json references, simplified detect-stuck.ts.
</objective>

<execution_context>
@/Users/jeremymcspadden/.claude/get-shit-done/workflows/execute-plan.md
@/Users/jeremymcspadden/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/05-dead-code-cleanup/5-CONTEXT.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Remove completed-units.json paths, delete unit-runtime.ts, remove oscillation detection</name>
  <files>
    src/resources/extensions/gsd/unit-runtime.ts
    src/resources/extensions/gsd/auto.ts
    src/resources/extensions/gsd/auto-post-unit.ts
    src/resources/extensions/gsd/auto-timeout-recovery.ts
    src/resources/extensions/gsd/auto-timers.ts
    src/resources/extensions/gsd/auto-worktree.ts
    src/resources/extensions/gsd/auto/phases.ts
    src/resources/extensions/gsd/guided-flow.ts
    src/resources/extensions/gsd/commands-maintenance.ts
    src/resources/extensions/gsd/doctor-checks.ts
    src/resources/extensions/gsd/git-service.ts
    src/resources/extensions/gsd/gitignore.ts
    src/resources/extensions/gsd/auto/detect-stuck.ts
    src/resources/extensions/gsd/prompts/forensics.md
  </files>
  <read_first>
    src/resources/extensions/gsd/unit-runtime.ts
    src/resources/extensions/gsd/auto.ts
    src/resources/extensions/gsd/auto-post-unit.ts
    src/resources/extensions/gsd/auto-timeout-recovery.ts
    src/resources/extensions/gsd/auto-timers.ts
    src/resources/extensions/gsd/auto-worktree.ts
    src/resources/extensions/gsd/auto/phases.ts
    src/resources/extensions/gsd/guided-flow.ts
    src/resources/extensions/gsd/commands-maintenance.ts
    src/resources/extensions/gsd/doctor-checks.ts
    src/resources/extensions/gsd/git-service.ts
    src/resources/extensions/gsd/gitignore.ts
    src/resources/extensions/gsd/auto/detect-stuck.ts
    src/resources/extensions/gsd/auto/loop-deps.ts
    src/resources/extensions/gsd/prompts/forensics.md
  </read_first>
  <action>
**DELETE unit-runtime.ts** — The entire file (188 lines). All its exports (`writeUnitRuntimeRecord`, `readUnitRuntimeRecord`, `clearUnitRuntimeRecord`, `listUnitRuntimeRecords`, `inspectExecuteTaskDurability`, `formatExecuteTaskRecoveryStatus`, types `UnitRuntimePhase`, `ExecuteTaskRecoveryStatus`, `AutoUnitRuntimeRecord`) are dead code. Per D-02, the file's entire purpose was the removed functionality.

**auto.ts** — Remove all unit-runtime references:
- Remove `import { writeUnitRuntimeRecord, readUnitRuntimeRecord, clearUnitRuntimeRecord, ... } from "./unit-runtime.js"` (~line 60)
- Remove comment `// selfHealRuntimeRecords removed (D-05)` at line 88
- For each call site of `writeUnitRuntimeRecord`, `readUnitRuntimeRecord`, `clearUnitRuntimeRecord`: Per D-01, if the caller's entire purpose was managing the runtime record, delete the block. If the caller does other work, remove only the unit-runtime call. Replace with engine queries where the surrounding logic needs a status check (use `isEngineAvailable` + `WorkflowEngine` task status query).
- Remove `verifyExpectedArtifact` import at line 163 and calls at lines 943/1430 (if not already removed by Plan 01 — check first, skip if done)
- Remove `s.completedUnits` array tracking — find the state type that declares it and remove the field. Remove all `s.completedUnits.push(...)`, `s.completedUnits.filter(...)`, `s.completedUnits = []`, `s.completedUnits.length`

**auto-post-unit.ts** — Remove unit-runtime and completed-units.json references:
- Remove `import { writeUnitRuntimeRecord, clearUnitRuntimeRecord } from "./unit-runtime.js"` at line 37
- Remove all `writeUnitRuntimeRecord(...)` and `clearUnitRuntimeRecord(...)` calls
- Remove the `completed-units.json` flush block in the retry-state-reset section (lines ~494-502): remove `s.completedUnits = s.completedUnits.filter(...)` and the `completedKeysPath`/`atomicWriteSync` block. Keep the rest of the retry reset logic (plan uncheck, summary delete, retry artifact delete, cache invalidation).

**auto-timeout-recovery.ts** — Remove unit-runtime imports:
- Remove `import { ... } from "./unit-runtime.js"` at line 13
- Remove all calls to unit-runtime functions. Per D-01, if the caller block's only purpose is updating the runtime record, delete the block. If it does other work, remove only the dead call.

**auto-timers.ts** — Remove unit-runtime imports:
- Remove `import { readUnitRuntimeRecord, writeUnitRuntimeRecord } from "./unit-runtime.js"` at line 10
- Remove/replace all calls. Timer progress tracking that wrote to unit-runtime records should be deleted if no other code reads those records (they don't — the engine is authoritative).

**auto-worktree.ts** — Remove completed-units.json from file lists:
- Remove `"completed-units.json"` from the sync file list at line 164
- Remove the comment about completed-units.json at line 312
- Remove `"completed-units.json"` from the file list at line 321

**auto/phases.ts** — Remove completed-units.json tracking:
- Remove the milestone-transition block that writes `[]` to `completed-units.json` (~lines 280-286)
- Remove `s.completedUnits = []` at line 283
- Remove `s.completedUnits.length` usage at lines ~1009, ~1040, ~1047
- Remove `s.completedUnits.push(...)` at line ~1131
- Remove the truncation + flush block (~lines 1137-1144)
- For `s.completedUnits.length` used in logging: replace with a count from the engine if needed, or just remove the logged field
- Remove `import { atomicWriteSync }` if it becomes unused

**guided-flow.ts** — Remove the selfHeal comment:
- Remove `// selfHealRuntimeRecords removed (D-05)` at line 685

**commands-maintenance.ts** — Remove completed-units.json from `gsd skip`:
- Remove the `completedKeysFile` logic (~lines 225-257) that reads/writes completed-units.json for the skip command
- Replace with engine command: use dynamic import of workflow-engine.js, mark the task as skipped via engine (if a skip command exists) or simply record a decision. If no engine skip API exists, remove the completed-units.json write and add a comment that skip tracking now uses the engine's task status.

**doctor-checks.ts** — Remove completed-units.json from checked paths:
- Remove `".gsd/completed-units.json"` from the runtime health check file list at line 642

**git-service.ts** — Remove completed-units.json from gitignore/untrack lists:
- Remove `".gsd/completed-units.json"` from the `RUNTIME_FILES` or equivalent list at line 196

**gitignore.ts** — Remove completed-units.json from gitignore entries:
- Remove `".gsd/completed-units.json"` at line 29

**auto/detect-stuck.ts** — Remove Rule 3 (oscillation detection):
- Delete lines 44-57 (the `// Rule 3: Oscillation` block)
- Update the JSDoc comment at lines 13-15 to only mention Rule 1 and Rule 2
- Keep the function signature unchanged

**prompts/forensics.md** — Remove completed-units.json references:
- Remove the line mentioning `completed-units.json` at line 35
- Remove any other references to `completed-units.json` in the prompt (line 91)
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <acceptance_criteria>
    - `test ! -f src/resources/extensions/gsd/unit-runtime.ts && echo "DELETED"` prints DELETED
    - `grep -r "completed-units\.json" src/resources/extensions/gsd/ --include="*.ts" --include="*.md" -l` returns NO production files (test files handled in Task 2)
    - `grep -r "unit-runtime" src/resources/extensions/gsd/ --include="*.ts" -l` returns NO production files (only test files)
    - `grep "Rule 3\|Oscillation\|oscillat" src/resources/extensions/gsd/auto/detect-stuck.ts` returns NO matches
    - `grep "Rule 1" src/resources/extensions/gsd/auto/detect-stuck.ts` returns a match (Rule 1 preserved)
    - `grep "Rule 2" src/resources/extensions/gsd/auto/detect-stuck.ts` returns a match (Rule 2 preserved)
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>unit-runtime.ts deleted. completed-units.json not referenced in any production code. Oscillation detection (Rule 3) removed from detect-stuck.ts. Rules 1+2 preserved. TypeScript compiles clean.</done>
</task>

<task type="auto">
  <name>Task 2: Update tests for removed unit-runtime, completed-units.json, and oscillation</name>
  <files>
    src/resources/extensions/gsd/tests/unit-runtime.test.ts
    src/resources/extensions/gsd/tests/retry-state-reset.test.ts
    src/resources/extensions/gsd/tests/doctor-runtime.test.ts
    src/resources/extensions/gsd/tests/milestone-transition-state-rebuild.test.ts
    src/resources/extensions/gsd/tests/auto-loop.test.ts
    src/resources/extensions/gsd/tests/worktree-sync-milestones.test.ts
    src/resources/extensions/gsd/tests/git-service.test.ts
    src/resources/extensions/gsd/tests/auto-supervisor.test.mjs
    src/resources/extensions/gsd/tests/continue-here.test.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/tests/unit-runtime.test.ts
    src/resources/extensions/gsd/tests/retry-state-reset.test.ts
    src/resources/extensions/gsd/tests/doctor-runtime.test.ts
    src/resources/extensions/gsd/tests/milestone-transition-state-rebuild.test.ts
    src/resources/extensions/gsd/tests/auto-loop.test.ts
    src/resources/extensions/gsd/tests/worktree-sync-milestones.test.ts
    src/resources/extensions/gsd/tests/git-service.test.ts
    src/resources/extensions/gsd/tests/auto-supervisor.test.mjs
    src/resources/extensions/gsd/tests/continue-here.test.ts
  </read_first>
  <action>
Per D-06/D-07/D-08:

**DELETE unit-runtime.test.ts** — Per D-07, the entire test file tests only removed functionality. Delete the file.

**retry-state-reset.test.ts:**
- Remove all `completed-units.json` references and assertions (~lines 47-49, 152-159, 228, 251-253, 274, 301)
- Remove test blocks that ONLY test completed-units.json behavior. For blocks that test both retry logic AND completed-units.json, keep the retry logic tests and remove only the completed-units.json assertions.
- Remove `writeFileSync` calls that create completed-units.json test fixtures
- If the entire file only tests completed-units.json behavior, delete it per D-07. Otherwise keep the retained test blocks.

**doctor-runtime.test.ts:**
- Remove test blocks that reference completed-units.json (~lines 273-290, 359-363, 389-416)
- Remove any `writeFileSync` calls creating completed-units.json
- Per D-08, keep test blocks that test other doctor check functionality

**milestone-transition-state-rebuild.test.ts:**
- This file tests completed-units.json reset during milestone transition (lines 46-127)
- Per D-07, if the entire file only tests completed-units.json behavior, delete it
- If it tests other milestone transition behavior too, keep those tests per D-08

**auto-loop.test.ts:**
- Remove the `detectStuck: Rule 3 — oscillation` test block (~line 1467-1477)
- Remove the `detectStuck: Rule 3 — non-oscillation` test block (~line 1478-1486)
- Keep all Rule 1 and Rule 2 detectStuck tests
- Remove `completedUnits` from any mock state objects in autoLoop test fixtures
- Remove `verifyExpectedArtifact: () => true` from deps objects (may already be done by Plan 01 — check first)

**worktree-sync-milestones.test.ts:**
- Remove test block 13 (~lines 458-514) that tests completed-units.json syncing
- Keep all other worktree sync tests

**git-service.test.ts:**
- Remove `".gsd/completed-units.json"` from test expectations at line 264
- Remove test blocks that create/check completed-units.json (~lines 412-460, 1113-1140)
- Per D-08, keep other git-service tests in the same file

**auto-supervisor.test.mjs:**
- Remove `import { writeUnitRuntimeRecord, readUnitRuntimeRecord } from '../unit-runtime.ts'` at line 6
- Remove any test logic using unit-runtime functions

**continue-here.test.ts:**
- Remove `import { writeUnitRuntimeRecord, readUnitRuntimeRecord, clearUnitRuntimeRecord } from "../unit-runtime.js"` at lines ~167 and ~207
- Remove test logic that uses unit-runtime functions. Per D-08, keep other continue-here tests.
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -20 && node --test src/resources/extensions/gsd/tests/auto-loop.test.ts 2>&1 | tail -5</automated>
  </verify>
  <acceptance_criteria>
    - `test ! -f src/resources/extensions/gsd/tests/unit-runtime.test.ts && echo "DELETED"` prints DELETED
    - `grep -r "completed-units\.json" src/resources/extensions/gsd/tests/ --include="*.ts" --include="*.mjs"` returns NO matches
    - `grep -r "unit-runtime" src/resources/extensions/gsd/tests/ --include="*.ts" --include="*.mjs"` returns NO matches
    - `grep "oscillat\|Rule 3" src/resources/extensions/gsd/tests/auto-loop.test.ts` returns NO matches
    - `npx tsc --noEmit` exits 0
    - `node --test src/resources/extensions/gsd/tests/auto-loop.test.ts` exits 0
  </acceptance_criteria>
  <done>unit-runtime.test.ts deleted. All test references to completed-units.json, unit-runtime, and oscillation detection removed. Remaining tests compile and pass.</done>
</task>

</tasks>

<verification>
- `grep -r "completed-units\.json" src/resources/extensions/gsd/ --include="*.ts" --include="*.mjs" --include="*.md"` returns zero matches
- `grep -r "unit-runtime" src/resources/extensions/gsd/ --include="*.ts" --include="*.mjs"` returns zero matches
- `grep "oscillat\|Rule 3" src/resources/extensions/gsd/auto/detect-stuck.ts` returns zero matches
- `test ! -f src/resources/extensions/gsd/unit-runtime.ts` succeeds
- `test ! -f src/resources/extensions/gsd/tests/unit-runtime.test.ts` succeeds
- `npx tsc --noEmit` exits 0
- All remaining tests pass
</verification>

<success_criteria>
completed-units.json not referenced anywhere. unit-runtime.ts deleted. Oscillation detection removed, Rules 1+2 preserved. All tests pass. TypeScript compiles clean.
</success_criteria>

<output>
After completion, create `.planning/phases/05-dead-code-cleanup/5-02-SUMMARY.md`
</output>
