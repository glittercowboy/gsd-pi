# Roadmap: GSD-2 Single-Writer State Architecture

## Overview

This milestone replaces GSD-2's split-brain markdown state with a command-driven engine backed by SQLite. Five phases move from building the engine foundation and team infrastructure, through migrating sync and prompts to use it, through enforcing event-based reconciliation, through stripping markdown parsing from the hot path, and finally through removing dead code. Each phase is independently shippable with the dual-write bridge keeping legacy projects working throughout.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Engine Foundation + Team Infrastructure** - Build WorkflowEngine, command API, agent tools, projections, state manifest, and event log foundation
- [x] **Phase 2: Sync Migration + Prompt Migration** - Migrate worktree sync to snapshot/restore and migrate key prompts to tool calls (completed 2026-03-22)
- [ ] **Phase 3: Event Reconciliation + Mandatory Tools** - Replace INSERT OR REPLACE with event-based merge, complete prompt migration, add gsd migrate
- [ ] **Phase 4: Remove Parsing from Hot Path** - Reduce doctor to infrastructure checks and move markdown parsers to legacy
- [ ] **Phase 5: Dead Code Cleanup** - Remove all dead code unlocked by prior phases (~4,600 lines)

## Phase Details

### Phase 1: Engine Foundation + Team Infrastructure
**Goal**: WorkflowEngine is operational with typed commands, agent tools registered, projections rendering from DB, and state manifest + event log infrastructure ready for team workflows
**Depends on**: Nothing (first phase)
**Requirements**: ENG-01, ENG-02, ENG-03, ENG-04, CMD-01, CMD-02, CMD-03, CMD-04, CMD-05, CMD-06, CMD-07, TOOL-01, TOOL-02, TOOL-03, PROJ-01, PROJ-02, PROJ-03, PROJ-04, PROJ-05, MAN-01, MAN-02, MAN-03, MAN-04, MAN-05, EVT-01, EVT-02
**Success Criteria** (what must be TRUE):
  1. A task can be completed via `complete_task()` tool call and the change appears in the rendered PLAN.md with no manual checkbox editing
  2. `deriveState()` returns typed workflow state by querying WorkflowEngine in under 1ms, confirmed by test
  3. After any command executes, `state-manifest.json` is written atomically and a fresh clone can bootstrap DB from it without parsing any markdown
  4. The event log records every engine command with content hash and fork-point detection identifies diverged logs
  5. Corrupted or deleted projection files are regenerated from engine on demand without data loss
**Plans:** 5 plans

Plans:
- [x] 1-01-PLAN.md — Schema v5 migration + WorkflowEngine class skeleton
- [x] 1-02-PLAN.md — All 7 command handlers (complete_task through report_blocker)
- [x] 1-03-PLAN.md — Projection renderers (PLAN, ROADMAP, SUMMARY, STATE markdown)
- [x] 1-04-PLAN.md — Agent tool registration + deriveState() engine bridge + telemetry
- [x] 1-05-PLAN.md — State manifest (snapshot/restore) + JSONL event log (fork-point detection)

### Phase 2: Sync Migration + Prompt Migration
**Goal**: Worktree sync uses snapshot/restore (not file copy + DB delete), advisory locking prevents collision, and the three highest-traffic prompts instruct agents to use tools instead of file edits
**Depends on**: Phase 1
**Requirements**: SYNC-01, SYNC-02, SYNC-03, PMG-01, PMG-02, PMG-03, EVT-04
**Success Criteria** (what must be TRUE):
  1. `syncProjectRootToWorktree()` and `syncStateToProjectRoot()` use snapshot/restore — no DB delete calls in the sync path
  2. Concurrent worktree sync attempts are blocked by advisory lock with no data corruption
  3. An agent executing a task calls `complete_task()` as its final step rather than editing a checkbox — confirmed via telemetry
  4. `engine.replay(event)` applies a command from another engine's event log correctly
**Plans:** 3 plans

Plans:
- [x] 2-01-PLAN.md — Advisory sync lock + engine.replay() method
- [x] 2-02-PLAN.md — Sync function migration (snapshot/restore with locking)
- [x] 2-03-PLAN.md — Prompt migration (3 prompts to tool-call instructions)

### Phase 3: Event Reconciliation + Mandatory Tools
**Goal**: Worktree merge uses event-based reconciliation (no more INSERT OR REPLACE), remaining prompts migrated to tools, agent writes to state files produce warnings, and legacy projects can migrate via `gsd migrate`
**Depends on**: Phase 2
**Requirements**: SYNC-04, SYNC-05, PMG-04, PMG-05, MIG-01, MIG-02, MIG-03, EVT-03
**Success Criteria** (what must be TRUE):
  1. Merging two diverged worktrees applies events in order and surfaces any conflicting entity modifications for human review — no silent data loss
  2. An agent that directly writes to a .gsd/ state file receives a warning directing it to use the tool API
  3. `gsd migrate` successfully converts a legacy markdown-only project to engine state, handling all known .gsd/ directory shapes
  4. `deriveState()` queries WorkflowEngine exclusively — no markdown parsing in the call path
  5. Event log compaction archives milestone events on completion, keeping the active log bounded
**Plans:** 5 plans

Plans:
- [x] 3-01-PLAN.md — Event-based reconciliation (reconcileWorktreeLogs replaces reconcileWorktreeDb)
- [x] 3-02-PLAN.md — Write intercept + remaining prompt migration (complete-milestone.md + audit)
- [ ] 3-03-PLAN.md — Legacy markdown to engine migration (gsd migrate + auto-trigger in deriveState)
- [ ] 3-04-PLAN.md — Event log compaction (archive milestone events on completion)
- [x] 3-05-PLAN.md — Conflict resolution CLI (gsd resolve-conflict command)

### Phase 4: Remove Parsing from Hot Path
**Goal**: Doctor is reduced to infrastructure diagnostics only (git, disk, environment, provider, DB constraints, projection drift) and markdown parsers are moved to legacy/ for use only by `gsd migrate`
**Depends on**: Phase 3
**Requirements**: DOC-01, DOC-02, DOC-03, DOC-04, DOC-05, CLN-07
**Success Criteria** (what must be TRUE):
  1. Running `gsd doctor` no longer attempts checkbox/file mismatch reconciliation or generates placeholder summaries
  2. `gsd doctor` detects DB constraint violations and projection drift and reports them as actionable diagnostics
  3. Markdown parser imports outside of `legacy/` and `gsd migrate` paths produce a lint or import error
**Plans**: TBD

### Phase 5: Dead Code Cleanup
**Goal**: All code made dead by Phases 1-4 is removed, leaving no completed-units.json paths, no selfHeal, no checkbox mutations, and no oscillation detection
**Depends on**: Phase 4
**Requirements**: CLN-01, CLN-02, CLN-03, CLN-04, CLN-05, CLN-06
**Success Criteria** (what must be TRUE):
  1. `completed-units.json` is not read or written anywhere in the codebase
  2. `selfHealRuntimeRecords()` does not exist in the codebase
  3. `auto-post-unit.ts` contains no doctor fix runs or STATE.md rebuild logic
  4. Stuck detection no longer contains oscillation detection — only same-error-twice detection remains
  5. Net line deletion across the milestone is at least 4,000 lines with all tests passing
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Engine Foundation + Team Infrastructure | 5/5 | Complete | 2026-03-22 |
| 2. Sync Migration + Prompt Migration | 3/3 | Complete | 2026-03-22 |
| 3. Event Reconciliation + Mandatory Tools | 5/5 | In progress | - |
| 4. Remove Parsing from Hot Path | 0/TBD | Not started | - |
| 5. Dead Code Cleanup | 0/TBD | Not started | - |
