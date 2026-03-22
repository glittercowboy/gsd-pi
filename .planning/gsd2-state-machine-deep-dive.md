# GSD2 State Machine — Full Buildup & Teardown Deep Dive

> Generated: 2026-03-21 via parallel agent trace of the full GSD2 codebase.

---

## THE STATE OBJECT

```typescript
GSDState {
  phase: Phase                    // Current phase (14 possible values)
  activeMilestone: { id, title }  // null if none
  activeSlice: { id, title }      // null if none
  activeTask: { id, title }       // null if none
  registry: MilestoneRegistryEntry[]  // all milestones + statuses
  nextAction: string              // human-readable description
  blockers: string[]
  recentDecisions: string[]
  progress: { milestones, slices, tasks }
}
```

State is **derived entirely from disk** on every iteration — no in-memory state machine. If it crashes, re-derive and continue.

### Phase Values (14 total)

| Phase | Meaning |
|-------|---------|
| `pre-planning` | No context/research/roadmap yet |
| `needs-discussion` | CONTEXT-DRAFT.md exists, needs discussion |
| `discussing` | Discussion in progress (reserved) |
| `researching` | Researching the milestone (reserved) |
| `planning` | Planning slice or roadmap |
| `executing` | Tasks in progress |
| `verifying` | Verification gates running |
| `summarizing` | Tasks done, waiting for slice summary |
| `advancing` | Transitioning to next slice (reserved) |
| `validating-milestone` | Milestone done, waiting for validation |
| `completing-milestone` | Validation passed, waiting for summary |
| `replanning-slice` | Blocker detected, slice needs replan |
| `complete` | All milestones done |
| `blocked` | Dependency blocker or unmet condition |

---

## FULL BUILDUP — Cold Start → Tasks Executing

```
DISK STATE                          DERIVED PHASE       DISPATCH
─────────────────────────────────────────────────────────────────
no .gsd/                            pre-planning        discuss-milestone
  ↓ agent writes CONTEXT.md
CONTEXT.md exists, no ROADMAP       pre-planning        research-milestone
  ↓ agent writes RESEARCH.md
CONTEXT + RESEARCH, no ROADMAP      pre-planning        plan-milestone
  ↓ agent writes M001-ROADMAP.md with [ ] S01, [ ] S02, [ ] S03
ROADMAP exists, S01 unchecked,      planning            research-slice
  no S01-PLAN.md                                        (unless skip pref)
  ↓ agent writes S01-RESEARCH.md
S01-RESEARCH exists, no PLAN        planning            plan-slice
  ↓ agent writes S01-PLAN.md + T01-PLAN.md, T02-PLAN.md...
S01-PLAN exists, T01 not [x]        executing           execute-task (T01)
  ↓ agent writes T01-SUMMARY.md + marks [x] T01 in PLAN
T01 [x], T02 not [x]               executing           execute-task (T02)
  ...continues per task...
```

### Worktree Buildup (happens once, at first dispatch)

```
1. createAutoWorktree()
2. git worktree add .gsd/worktrees/M001 -b milestone/M001
3. syncGsdStateToWorktree()  ← copy DECISIONS, REQUIREMENTS, milestones/ into worktree
4. chdir → worktree path, store originalBasePath
5. All subsequent agent work runs inside .gsd/worktrees/M001/
```

**Files synced INTO worktree (fresh branch only):**
- Root-level: DECISIONS.md, REQUIREMENTS.md, PROJECT.md, KNOWLEDGE.md, OVERRIDES.md, QUEUE.md, completed-units.json
- Entire `milestones/` directory (missing dirs only)
- `gsd.db` if exists

**On re-attach:** `reconcilePlanCheckboxes()` — forward-merge `[x]` states from project root → worktree (never downgrade).

---

## FULL TEARDOWN — Last Task → Milestone Merged

```
DISK STATE                          DERIVED PHASE         DISPATCH
─────────────────────────────────────────────────────────────────────
All T0N [x] in PLAN, no SUMMARY     summarizing           complete-slice
  ↓ agent writes S03-SUMMARY.md, S03-UAT.md, marks [x] S03 in ROADMAP
All slices [x] in ROADMAP,          validating-milestone  validate-milestone
  no VALIDATION.md
  ↓ agent writes M001-VALIDATION.md (verdict: pass)
All slices [x], VALIDATION terminal  completing-milestone  complete-milestone
  ↓ agent writes M001-SUMMARY.md
```

### Milestone Teardown Sequence (triggered after complete-milestone finishes)

```
1.  autoCommitDirtyState()          ← commit any loose files in worktree
2.  reconcileWorktreeDb()           ← merge SQLite DBs
3.  syncWorktreeStateBack()         ← copy ALL milestones/ back to project root
4.  clearProjectRootStateFiles()    ← remove untracked files that block merge
5.  chdir → originalBasePath
6.  resolveIntegrationBranch()      ← find main/master (never hardcoded)
7.  git checkout <main>
8.  git merge --squash milestone/M001
9.  auto-resolve .gsd/ conflicts    ← worktree version wins
10. git commit "feat(M001): <title>"
11. rm .git/SQUASH_MSG              ← prevents corrupt_merge_state doctor issue
12. git push                        [optional: git.auto_push pref]
13. gh pr create                    [optional: git.auto_pr pref]
14. git worktree remove .gsd/worktrees/M001
15. git branch -d milestone/M001
16. invalidateAllCaches()
17. deriveState() → M002 becomes active OR phase: "complete"
```

**Files synced OUT of worktree (before merge):**
- Root-level: DECISIONS.md, REQUIREMENTS.md, PROJECT.md, KNOWLEDGE.md, OVERRIDES.md, QUEUE.md, completed-units.json
- ALL milestone directories (not just current — handles next-milestone artifacts)
- Every slice .md, every task SUMMARY.md recursively

**Dirty worktree handling:**
- Pre-teardown: auto-commit with "chore: auto-commit before milestone merge"
- Merge conflicts in `.gsd/`: auto-resolved (worktree wins)
- Merge conflicts in code: throw `MergeConflictError`, preserve branch, require manual resolution
- Nothing-to-commit safety: diff non-.gsd/ files; if code changes exist but nothing committed → throw error (data loss guard)

---

## LOOP STRUCTURE (one iteration)

```
while (s.active) {

  runPreDispatch()        ← derive state, detect milestone transition
    ↓
  runGuards()             ← health gate (doctor), session lock check
    ↓
  runDispatch()           ← evaluate 18 ordered rules → resolve unit
    ↓
  runUnit()               ← newSession() → sendMessage() → await agent_end
    ↓
  runFinalize()
    ├─ postUnitPreVerification()
    │   ├─ invalidateAllCaches()
    │   ├─ autoCommitCurrentBranch()
    │   ├─ runGSDDoctor(fix:true)
    │   ├─ rebuildState() [throttled 30s]
    │   └─ verifyExpectedArtifact() → "retry" if missing
    │
    ├─ runPostUnitVerification()   [execute-task only]
    │   ├─ runVerificationGate()  ← lint/typecheck/test
    │   ├─ captureRuntimeErrors()
    │   └─ → "continue" | "retry" | "pause"
    │
    └─ postUnitPostVerification()
        ├─ closeoutUnit()         ← metrics + activity log + memory extract
        ├─ checkPostUnitHooks()   → sidecar queue
        ├─ triageCaptures()       → sidecar queue
        └─ quickTaskDispatch()    → sidecar queue
}
```

### Bootstrap Sequence (before first dispatch)

```
1.  acquireSessionLock()
2.  ensureGitRepo()
3.  migrateLeacgy .gsd/
4.  manage .gitignore
5.  bootstrap .gsd/ directory
6.  readCrashLock() → synthesizeCrashRecovery() if dead process
7.  invalidateAllCaches()
8.  deriveState()
9.  recover stale worktree state (chdir fix)
10. guided flow gates (active work check, pre-planning validation)
11. set lifecycle flags (active, stepMode, verbose)
12. capture timing + models (originalModelId)
13. registerSigtermHandler()
14. captureIntegrationBranch()
15. enterWorktree for milestone
16. auto-migrate markdown → SQLite DB
17. initMetrics()
18. notify user, write session lock
19. collect secrets from manifest
20. remove stale git lock
21. → autoLoop()
```

---

## DISPATCH RULES (18 ordered, first match wins)

| # | Phase | → Unit |
|---|-------|--------|
| 1 | any (overrides pending) | `rewrite-docs` |
| 2 | `summarizing` | `complete-slice` |
| 3 | post-complete (UAT exists) | `run-uat` |
| 4 | post-complete (UAT non-PASS) | **stop** |
| 5 | post-complete (reassess) | `reassess-roadmap` |
| 6 | `needs-discussion` | `discuss-milestone` |
| 7 | `pre-planning` (no CONTEXT) | `discuss-milestone` |
| 8 | `pre-planning` (no RESEARCH) | `research-milestone` |
| 9 | `pre-planning` (has RESEARCH) | `plan-milestone` |
| 10 | `planning` (no slice RESEARCH) | `research-slice` |
| 11 | `planning` | `plan-slice` |
| 12 | `replanning-slice` | `replan-slice` |
| 13 | `executing` (parallel enabled) | `reactive-execute` |
| 14 | `executing` (plan missing) | `plan-slice` (recover) |
| 15 | `executing` | `execute-task` |
| 16 | `validating-milestone` | `validate-milestone` |
| 17 | `completing-milestone` | `complete-milestone` |
| 18 | `complete` | **stop** |

---

## UNIT TYPE CATALOGUE

| Unit Type | Triggered By | Artifacts Produced |
|-----------|--------------|-------------------|
| `discuss-milestone` | pre-planning / needs-discussion | M{mid}-CONTEXT.md |
| `research-milestone` | pre-planning (no RESEARCH) | M{mid}-RESEARCH.md |
| `plan-milestone` | pre-planning (has RESEARCH) | M{mid}-ROADMAP.md |
| `research-slice` | planning (no slice RESEARCH) | S{sid}-RESEARCH.md |
| `plan-slice` | planning | S{sid}-PLAN.md + T{tid}-PLAN.md files |
| `replan-slice` | replanning-slice | S{sid}-REPLAN.md + updated PLAN.md |
| `execute-task` | executing | T{tid}-SUMMARY.md + [x] in PLAN |
| `reactive-execute` | executing (parallel) | Multiple T{tid}-SUMMARY.md |
| `complete-slice` | summarizing | S{sid}-SUMMARY.md + UAT.md + [x] in ROADMAP |
| `run-uat` | post-complete (UAT file exists) | S{sid}-UAT-RESULT.md |
| `reassess-roadmap` | post-complete (reassess pref) | S{sid}-ASSESSMENT.md |
| `validate-milestone` | validating-milestone | M{mid}-VALIDATION.md |
| `complete-milestone` | completing-milestone | M{mid}-SUMMARY.md |
| `rewrite-docs` | any (OVERRIDES.md active) | Updated doc files |
| `triage-captures` | post-unit sidecar | Updated PLAN.md / REPLAN-TRIGGER.md |
| `quick-task` | post-triage sidecar | T{tid}-SUMMARY.md |
| `hook/*` | post-unit hook config | hook-specific |

---

## "DONE" CONDITIONS

### Task done
- T-SUMMARY.md exists on disk
- `[x]` in PLAN.md
- Verification gate passed (or advisory failure)

### Slice done
- All tasks `[x]` in PLAN
- S-SUMMARY.md written
- S-UAT.md written
- `[x]` in ROADMAP

### Milestone done
- All slices `[x]` in ROADMAP
- Every slice has SUMMARY.md
- Implementation artifacts exist (non-.gsd/ files)
- VALIDATION.md terminal (verdict: pass/needs-attention)
- M-SUMMARY.md written
→ squash merge to main branch

### Project done
- All milestones complete
- `phase: "complete"` from deriveState
- Loop exits

---

## POST-UNIT SEQUENCE (detailed)

### Pre-verification (runs after every unit)
```
1. parallel worker signal check
2. invalidateAllCaches()
3. file settle delay (100ms)
4. autoCommitCurrentBranch()
5. runGitHubSync() [non-blocking]
6. runGSDDoctor(fix:true, scope=slice, fixLevel="task"|"all")
7. rebuildState() [throttled 30s]
8. pruneDeadProcesses()
9. browser teardown (if open)
10. syncStateToProjectRoot() [if in worktree]
11. rewrite-docs completion [if unitType=rewrite-docs]
12. clearReactiveState() [if unitType=complete-slice]
13. post-triage resolution [if unitType=triage-captures]
14. verifyExpectedArtifact() → "retry" if missing
```

### Verification gate (execute-task only)
```
1. parse PLAN.md → extract verify: field
2. runVerificationGate() → lint/typecheck/test
3. captureRuntimeErrors() → blocking errors
4. runDependencyAudit() → npm audit warnings
5. auto-fix retry or pause if exhausted
```

### Post-verification (runs after gate passes)
```
1. DB dual-write (markdown → SQLite)
2. checkPostUnitHooks() → sidecar queue
3. hook retry handling (if hook requested retry)
4. triageCaptures() → sidecar queue
5. quickTaskDispatch() → sidecar queue
6. closeoutUnit():
   ├─ snapshotUnitMetrics()
   ├─ saveActivityLog()
   └─ extractMemoriesFromUnit() [fire-and-forget]
```

---

## RECOVERY LADDER

| Failure | Attempts | Final Action |
|---------|----------|--------------|
| Artifact missing (any unit) | 3 retries | Write blocker placeholder, advance |
| Verification gate fail (execute-task) | 2 auto-fix retries | Pause auto-mode |
| Idle timeout (15min) | 2 steering messages | Write blocker, skip task |
| Hard timeout (30min) | 1 steering message | Write blocker, skip task |
| Loop error (consecutive) | 3 attempts | Hard stop |
| Cache stale (2nd loop error) | invalidateAllCaches() then retry | Hard stop at 3rd |
| .gsd/ merge conflict | Auto-resolve (worktree wins) | Continue merge |
| Code merge conflict | Throw MergeConflictError | Preserve branch, manual fix |
| Stale dispatched record (>1h) | selfHealRuntimeRecords() | Clear + re-dispatch |

---

## PAUSE / RESUME PROTOCOL

### Pause (user presses Escape)
```
1. clearUnitTimeout()
2. resolveAgentEndCancelled()
3. write .gsd/runtime/paused-session.json (milestone, worktree path, stepMode)
4. closeoutUnit()
5. releaseSessionLock() + clearLock()
6. deregisterSigtermHandler()
7. s.active = false, s.paused = true
```

### Resume (/gsd auto)
```
1. read paused-session.json
2. acquireSessionLock()
3. restore s.currentMilestoneId, s.stepMode, s.originalBasePath
4. re-enter worktree (if applicable)
5. registerSigtermHandler()
6. rebuildState()
7. runGSDDoctor(fix:true)
8. selfHealRuntimeRecords()
9. synthesizeCrashRecovery() → s.pendingCrashRecovery
10. → autoLoop()
```

---

## CRASH RECOVERY

On startup, if a dead lock file exists (PID not alive):
```
1. synthesizeCrashRecovery() from session file + activity logs
2. s.pendingCrashRecovery = reconstructed prompt
3. First unit dispatch prepends recovery context
4. clearLock()
```

Discarded if: milestone already complete, or no tool calls in session file.

---

## DERIVESTATE() ALGORITHM (summary)

```
1. findMilestoneIds()                   ← list .gsd/milestones/
2. nativeBatchParseGsdFiles()           ← batch parse all .md files (Rust native)
3. For each milestone:
   a. check PARKED → status: parked
   b. read + parse ROADMAP
   c. determine status: complete / active / pending
4. Determine terminal state (no active milestone → blocked/pre-planning/complete)
5. Find active slice: first incomplete with deps satisfied
6. Parse slice PLAN → find first incomplete task
7. Detect blockers (blocker_discovered in SUMMARY, REPLAN-TRIGGER)
8. Return GSDState (cached 100ms TTL per basePath)
```

Cache invalidated by `invalidateAllCaches()` → `invalidateStateCache() + clearPathCache() + clearParseCache() + clearArtifacts()`

---

## KEY SOURCE FILES

| Concept | File |
|---------|------|
| State derivation | `state.ts` |
| Phase/type definitions | `auto/types.ts` |
| Phase transition logic | `auto/phases.ts` |
| 18 dispatch rules | `auto-dispatch.ts` |
| Main loop | `auto/loop.ts` |
| Bootstrap | `auto-start.ts` |
| Unit execution | `auto/run-unit.ts` |
| Post-unit pipeline | `auto-post-unit.ts` |
| Unit closeout | `auto-unit-closeout.ts` |
| Verification gate | `auto-verification.ts` |
| Recovery logic | `auto-recovery.ts` |
| Timeout recovery | `auto-timeout-recovery.ts` |
| Worktree buildup/teardown | `auto-worktree.ts` |
| Worktree sync | `auto-worktree-sync.ts` |
| Worktree health | `worktree-health.ts` |
| Git self-heal | `git-self-heal.ts` |
| Cache management | `cache.ts` |
| Session state | `auto/session.ts` |
| Pause/stop | `auto.ts` |
