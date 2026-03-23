---
phase: 05-dead-code-cleanup
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/resources/extensions/gsd/auto-recovery.ts
  - src/resources/extensions/gsd/auto-post-unit.ts
  - src/resources/extensions/gsd/forensics.ts
  - src/resources/extensions/gsd/auto/loop-deps.ts
  - src/resources/extensions/gsd/auto/phases.ts
  - src/resources/extensions/gsd/tests/auto-recovery.test.ts
  - src/resources/extensions/gsd/tests/idle-recovery.test.ts
  - src/resources/extensions/gsd/tests/validate-milestone.test.ts
  - src/resources/extensions/gsd/tests/replan-slice.test.ts
  - src/resources/extensions/gsd/tests/reactive-executor.test.ts
  - src/resources/extensions/gsd/tests/auto-loop.test.ts
autonomous: true
requirements:
  - CLN-02
  - CLN-03
  - CLN-05

must_haves:
  truths:
    - "selfHealRuntimeRecords does not exist anywhere in the codebase as a callable function"
    - "verifyExpectedArtifact does not exist anywhere in the codebase as a callable function"
    - "auto-post-unit.ts contains no doctor fix runs (runGSDDoctor call removed from postUnitPreVerification)"
    - "auto-post-unit.ts contains no STATE.md rebuild logic (rebuildState call removed from postUnitPreVerification)"
    - "All tests pass after removals"
  artifacts:
    - path: "src/resources/extensions/gsd/auto-recovery.ts"
      provides: "Recovery functions minus verifyExpectedArtifact, diagnoseExpectedArtifact, resolveExpectedArtifactPath"
      contains: "reconcileMergeState"
    - path: "src/resources/extensions/gsd/auto-post-unit.ts"
      provides: "Post-unit pipeline minus doctor run and STATE.md rebuild"
  key_links:
    - from: "src/resources/extensions/gsd/auto/phases.ts"
      to: "auto/loop-deps.ts"
      via: "verifyExpectedArtifact removed from deps interface"
      pattern: "no verifyExpectedArtifact in loop-deps"
    - from: "src/resources/extensions/gsd/forensics.ts"
      to: "auto-recovery.ts"
      via: "verifyExpectedArtifact import removed"
      pattern: "no import.*verifyExpectedArtifact"
---

<objective>
Remove selfHealRuntimeRecords, verifyExpectedArtifact (and its helpers), and the doctor-fix/STATE-rebuild blocks from auto-post-unit.ts.

Purpose: These functions are dead code since Phase 4 moved all state authority to the engine. Removing them reduces maintenance burden and enforces the single-writer architecture.
Output: Slimmed auto-recovery.ts, auto-post-unit.ts, forensics.ts, and updated loop-deps/phases.
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
  <name>Task 1: Remove verifyExpectedArtifact + selfHeal remnants from production code</name>
  <files>
    src/resources/extensions/gsd/auto-recovery.ts
    src/resources/extensions/gsd/auto-post-unit.ts
    src/resources/extensions/gsd/forensics.ts
    src/resources/extensions/gsd/auto/loop-deps.ts
    src/resources/extensions/gsd/auto/phases.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/auto-recovery.ts
    src/resources/extensions/gsd/auto-post-unit.ts
    src/resources/extensions/gsd/forensics.ts
    src/resources/extensions/gsd/auto/loop-deps.ts
    src/resources/extensions/gsd/auto/phases.ts
    src/resources/extensions/gsd/auto.ts
  </read_first>
  <action>
**auto-recovery.ts** — Remove these exported functions entirely:
- `resolveExpectedArtifactPath()` (lines ~54-131) — filesystem artifact path resolution
- `verifyExpectedArtifact()` (lines ~239-380) — filesystem artifact existence checks
- `diagnoseExpectedArtifact()` (lines ~382-434) — artifact diagnosis helper
- Remove the `selfHealRuntimeRecords removed` comment at line ~536
- Keep: `hasImplementationArtifacts()`, `reconcileMergeState()`, `buildLoopRemediationSteps()` — these are still used
- Remove any imports that become unused after these deletions (e.g., `clearPathCache`, `resolveGsdRootFile`, `resolveTasksDir`, `resolveTaskFiles` if only used by removed code)
- Check each import — only remove if no remaining code in the file uses it

**auto-post-unit.ts** — Remove two blocks from `postUnitPreVerification()`:
1. Doctor fix block (lines ~185-241): Remove the entire `if (!opts?.skipDoctor) try { ... } catch` block that calls `runGSDDoctor`, `summarizeDoctorIssues`, `recordHealthSnapshot`, `checkHealEscalation`, and dispatches doctor-heal
2. STATE.md rebuild block (lines ~243-255): Remove the entire `if (!opts?.skipStateRebuild) { ... }` block that calls `rebuildState` and `autoCommitCurrentBranch`
3. Remove imports that become unused: `runGSDDoctor`, `rebuildState`, `summarizeDoctorIssues` from `./doctor.js`, `recordHealthSnapshot`, `checkHealEscalation` from `./doctor-proactive.js`, `autoCommitCurrentBranch` from `./git-service.js`, and the `STATE_REBUILD_MIN_INTERVAL_MS` constant
4. Remove `s.lastStateRebuildAt` usage if it only existed for the rebuild block
5. Remove the `verifyExpectedArtifact` import from `./auto-recovery.js` and the call at line ~363
6. Replace the `triggerArtifactVerified = verifyExpectedArtifact(...)` call with an engine query. Use dynamic import of workflow-engine.js, call `isEngineAvailable(s.basePath)`, and if available query task/slice status. If engine not available, default to `true` (lenient fallback). Per D-01, this caller does other useful work (retry-on evaluation), so keep the surrounding logic intact and only replace the dead call.
7. Keep the `completed-units.json` references in the retry-state-reset block (lines ~494-502) — those are removed in Plan 02

**forensics.ts** — Remove the `verifyExpectedArtifact` import and its usage:
- Remove `import { verifyExpectedArtifact } from "./auto-recovery.js";` at line 26
- Replace the two `verifyExpectedArtifact()` calls at lines ~418-419 with engine queries: use dynamic import of workflow-engine.js, check `isEngineAvailable(basePath)`, and query slice/task status. If engine not available, fall back to file existence check (`existsSync` on the expected path). Per D-01, the forensics caller does other work (building the diagnostic report), so only the dead calls are replaced.

**auto/loop-deps.ts** — Remove the `verifyExpectedArtifact` member from the deps interface:
- Remove the `verifyExpectedArtifact: (unitType: string, unitId: string, basePath: string) => boolean` member (~line 190)

**auto/phases.ts** — Remove all `verifyExpectedArtifact` usage:
- Remove `deps.verifyExpectedArtifact(...)` calls at lines ~537 and ~1129
- Replace with engine query: use `isEngineAvailable(s.basePath)` + `WorkflowEngine` task/slice status query. For the stale-key eviction at ~537, if engine says task is complete, treat as verified. For the post-dispatch verification at ~1129, same approach. Fall back to `true` if no engine.
- Remove the `verifyExpectedArtifact` property from any deps objects passed in test fixtures
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <acceptance_criteria>
    - `grep -r "verifyExpectedArtifact" src/resources/extensions/gsd/ --include="*.ts" -l` returns NO production files (only test files that test the removal)
    - `grep -r "selfHealRuntimeRecords" src/resources/extensions/gsd/ --include="*.ts" -l` returns NO files (comment was the only remnant)
    - `grep "runGSDDoctor\|rebuildState\|STATE_REBUILD" src/resources/extensions/gsd/auto-post-unit.ts` returns NO matches
    - `grep "resolveExpectedArtifactPath\|diagnoseExpectedArtifact" src/resources/extensions/gsd/auto-recovery.ts` returns NO matches
    - `npx tsc --noEmit` exits 0
  </acceptance_criteria>
  <done>verifyExpectedArtifact, diagnoseExpectedArtifact, resolveExpectedArtifactPath removed from auto-recovery.ts. Doctor fix and STATE.md rebuild removed from auto-post-unit.ts. forensics.ts and auto/phases.ts use engine queries instead. TypeScript compiles clean.</done>
</task>

<task type="auto">
  <name>Task 2: Update tests for removed functions</name>
  <files>
    src/resources/extensions/gsd/tests/auto-recovery.test.ts
    src/resources/extensions/gsd/tests/idle-recovery.test.ts
    src/resources/extensions/gsd/tests/validate-milestone.test.ts
    src/resources/extensions/gsd/tests/replan-slice.test.ts
    src/resources/extensions/gsd/tests/reactive-executor.test.ts
    src/resources/extensions/gsd/tests/auto-loop.test.ts
  </files>
  <read_first>
    src/resources/extensions/gsd/tests/auto-recovery.test.ts
    src/resources/extensions/gsd/tests/idle-recovery.test.ts
    src/resources/extensions/gsd/tests/validate-milestone.test.ts
    src/resources/extensions/gsd/tests/replan-slice.test.ts
    src/resources/extensions/gsd/tests/reactive-executor.test.ts
    src/resources/extensions/gsd/tests/auto-loop.test.ts
  </read_first>
  <action>
Per D-06/D-07/D-08, update test files that reference removed functions:

**auto-recovery.test.ts:**
- Remove `selfHealRuntimeRecords` from import at line 13 (if still imported)
- Remove `verifyExpectedArtifact` from import at line 10
- Delete all test blocks for `selfHealRuntimeRecords` (lines ~475-547: "selfHealRuntimeRecords clears stale dispatched records", "#1625: selfHealRuntimeRecords on resume")
- Delete all test blocks for `verifyExpectedArtifact` (lines ~202-470: every test starting with "verifyExpectedArtifact detects...", "verifyExpectedArtifact rejects...", "verifyExpectedArtifact accepts...", "verifyExpectedArtifact plan-slice...")
- Delete test blocks for removed exports (lines ~667-677: tests checking removed export names)
- Remove `resolveExpectedArtifactPath` and `diagnoseExpectedArtifact` from imports
- Keep all tests for `reconcileMergeState`, `buildLoopRemediationSteps`, `hasImplementationArtifacts` — those are retained functions

**idle-recovery.test.ts:**
- Remove `verifyExpectedArtifact` from import at line 7
- Delete the entire `verifyExpectedArtifact: complete-slice roadmap check` section (~lines 99-175)
- Delete the `verifyExpectedArtifact: hook unit types` section (~lines 242-256)
- Keep all other idle-recovery tests

**validate-milestone.test.ts:**
- Remove `verifyExpectedArtifact` from import at line 9
- Delete all `verifyExpectedArtifact` test blocks (~lines 274-349)
- Keep `resolveExpectedArtifactPath` tests ONLY if that function is still exported (it's being removed — so remove those tests too)
- Keep `buildLoopRemediationSteps` tests (that function is retained)

**replan-slice.test.ts:**
- Remove `verifyExpectedArtifact` from import at line 507
- Delete the two artifact verification test blocks (~lines 521-540)
- Keep `resolveExpectedArtifactPath` import only if still exported — remove it too

**reactive-executor.test.ts:**
- Delete the 4 test blocks that dynamically import `verifyExpectedArtifact` (~lines 373-430)
- Keep all other reactive-executor tests

**auto-loop.test.ts:**
- Remove `verifyExpectedArtifact: () => true` from deps objects at lines ~372 and ~2012
- Remove the `selfHealRuntimeRecords` ordering test at lines ~1104-1126
- Keep all other auto-loop tests
  </action>
  <verify>
    <automated>cd /Users/jeremymcspadden/Github/gsd-2/.claude/worktrees/single-writer-state-architecture && npx tsc --noEmit 2>&1 | head -20 && node --test src/resources/extensions/gsd/tests/auto-recovery.test.ts 2>&1 | tail -5</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "verifyExpectedArtifact" src/resources/extensions/gsd/tests/auto-recovery.test.ts` returns 0
    - `grep -c "selfHealRuntimeRecords" src/resources/extensions/gsd/tests/auto-recovery.test.ts` returns 0
    - `grep -c "selfHealRuntimeRecords" src/resources/extensions/gsd/tests/auto-loop.test.ts` returns 0
    - `grep -c "verifyExpectedArtifact" src/resources/extensions/gsd/tests/idle-recovery.test.ts` returns 0
    - `grep -c "verifyExpectedArtifact" src/resources/extensions/gsd/tests/validate-milestone.test.ts` returns 0
    - `grep -c "verifyExpectedArtifact" src/resources/extensions/gsd/tests/replan-slice.test.ts` returns 0
    - `grep -c "verifyExpectedArtifact" src/resources/extensions/gsd/tests/reactive-executor.test.ts` returns 0
    - `npx tsc --noEmit` exits 0
    - `node --test src/resources/extensions/gsd/tests/auto-recovery.test.ts` exits 0
  </acceptance_criteria>
  <done>All test blocks for removed functions (selfHealRuntimeRecords, verifyExpectedArtifact, resolveExpectedArtifactPath, diagnoseExpectedArtifact) deleted from test files. Remaining tests compile and pass.</done>
</task>

</tasks>

<verification>
- `grep -r "verifyExpectedArtifact\|selfHealRuntimeRecords\|diagnoseExpectedArtifact\|resolveExpectedArtifactPath" src/resources/extensions/gsd/ --include="*.ts"` returns zero matches
- `grep "runGSDDoctor\|rebuildState\|STATE_REBUILD" src/resources/extensions/gsd/auto-post-unit.ts` returns zero matches
- `npx tsc --noEmit` exits 0
- `node --test src/resources/extensions/gsd/tests/auto-recovery.test.ts` passes
- `node --test src/resources/extensions/gsd/tests/idle-recovery.test.ts` passes
</verification>

<success_criteria>
selfHealRuntimeRecords function body gone. verifyExpectedArtifact + helpers gone. auto-post-unit doctor/STATE blocks gone. All replaced callers use engine queries. All tests pass. TypeScript compiles clean.
</success_criteria>

<output>
After completion, create `.planning/phases/05-dead-code-cleanup/5-01-SUMMARY.md`
</output>
