# Requirements: GSD-2 Single-Writer State Architecture

**Defined:** 2026-03-22
**Core Value:** One sheriff in town — all state mutations flow through a single typed engine

## v1 Requirements

Requirements for v1.0 milestone. Each maps to roadmap phases.

### Engine Core

- [ ] **ENG-01**: WorkflowEngine class wraps SQLite with typed command handlers and transaction support
- [ ] **ENG-02**: SQLite schema v5 adds milestones, slices, tasks, verification_evidence tables
- [x] **ENG-03**: `deriveState()` returns typed workflow state from engine query in <1ms
- [ ] **ENG-04**: Each command validates preconditions, writes atomically, and renders projections

### Command API

- [ ] **CMD-01**: `complete_task()` writes summary, evidence, status in one atomic operation
- [ ] **CMD-02**: `complete_slice()` writes slice summary, UAT, and marks slice done atomically
- [ ] **CMD-03**: `plan_slice()` creates task plan for a slice with sequencing
- [ ] **CMD-04**: `save_decision()` records decision with rationale to decisions table
- [ ] **CMD-05**: `start_task()` marks task as in-progress with timestamp
- [ ] **CMD-06**: `record_verification()` stores verification evidence against a task
- [ ] **CMD-07**: `report_blocker()` records blocker description against a task

### Agent Tools

- [x] **TOOL-01**: 6+ agent-callable tools registered alongside existing markdown path
- [x] **TOOL-02**: Dual-write mode: tool calls and legacy markdown both produce consistent state
- [x] **TOOL-03**: Telemetry tracks tool-vs-manual-edit usage for migration validation

### Projections

- [ ] **PROJ-01**: Renderer produces *-PLAN.md from DB rows (byte-compatible with current format)
- [ ] **PROJ-02**: Renderer produces *-ROADMAP.md from DB rows
- [ ] **PROJ-03**: Renderer produces *-SUMMARY.md from summary records
- [ ] **PROJ-04**: Renderer produces STATE.md from engine.deriveState()
- [ ] **PROJ-05**: Corrupted/deleted projections regenerate from engine on demand

### State Manifest

- [x] **MAN-01**: `engine.snapshot()` produces atomic JSON dump of all state
- [x] **MAN-02**: `engine.restore(snapshot)` atomically replaces all state
- [x] **MAN-03**: `state-manifest.json` written after every command via atomicWriteSync
- [x] **MAN-04**: Fresh clone bootstraps DB from state-manifest.json (no markdown parsing needed)
- [x] **MAN-05**: State manifest is git-tracked and three-way mergeable

### Event Log

- [x] **EVT-01**: Append-only JSONL records every engine command with content hash
- [x] **EVT-02**: Fork-point detection identifies last common event between diverged logs
- [ ] **EVT-03**: Event log compaction archives milestone events on completion
- [ ] **EVT-04**: `engine.replay(event)` applies a command from another engine's log

### Worktree Sync

- [ ] **SYNC-01**: `syncProjectRootToWorktree()` uses snapshot restore instead of file copy + DB delete
- [ ] **SYNC-02**: `syncStateToProjectRoot()` uses snapshot + projection render
- [ ] **SYNC-03**: Advisory lock prevents concurrent worktree syncs from colliding
- [ ] **SYNC-04**: Event-based reconciliation replaces INSERT OR REPLACE on merge
- [x] **SYNC-05**: Conflicting entity modifications surfaced for human resolution (no silent data loss)

### Prompt Migration

- [ ] **PMG-01**: execute-task.md instructs agents to call `complete_task()` tool, not edit checkboxes
- [ ] **PMG-02**: complete-slice.md instructs agents to call `complete_slice()` tool
- [ ] **PMG-03**: plan-slice.md instructs agents to call `plan_slice()` tool
- [x] **PMG-04**: All remaining prompts migrated (complete-milestone, research, validate)
- [x] **PMG-05**: Agent writes to .gsd/ state files trigger warnings

### Migration

- [ ] **MIG-01**: `gsd migrate` converts legacy markdown projects to engine state
- [ ] **MIG-02**: Migration handles all .gsd/ directory shapes (no DB, stale DB, partial milestones)
- [ ] **MIG-03**: `deriveState()` switches to query WorkflowEngine (not markdown parsing)

### Doctor Reduction

- [ ] **DOC-01**: Remove checkbox/file mismatch reconciliation checks
- [ ] **DOC-02**: Remove placeholder summary generation
- [ ] **DOC-03**: Remove health scoring for bookkeeping failures
- [ ] **DOC-04**: Keep git health, disk health, environment health, provider health
- [ ] **DOC-05**: Add DB constraint violation detection and projection drift detection

### Dead Code Cleanup

- [ ] **CLN-01**: Remove completed-units.json read/write paths
- [ ] **CLN-02**: Remove selfHealRuntimeRecords() from auto-recovery.ts
- [ ] **CLN-03**: Remove verifyExpectedArtifact() filesystem checks (use engine query)
- [ ] **CLN-04**: Remove unit-runtime.ts inspection (replaced by engine task status)
- [ ] **CLN-05**: Simplify auto-post-unit.ts (remove doctor fix runs, STATE.md rebuild)
- [ ] **CLN-06**: Remove oscillation detection from stuck detection (keep same-error-twice)
- [ ] **CLN-07**: Move markdown parsers to legacy/ (preserve for gsd migrate only)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Advanced Event Sourcing

- **ADV-01**: Full event replay for time-travel debugging
- **ADV-02**: Event-driven notifications for external integrations
- **ADV-03**: Cross-project state federation

### Extended Tools

- **EXT-01**: `replan_slice()` command for mid-execution plan changes
- **EXT-02**: `complete_milestone()` command with full audit trail

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full CQRS / event sourcing | Overkill for CLI tool — "event sourcing lite" sufficient |
| Remove markdown files entirely | Markdown serves real purposes: human readability, git diffs, PR review |
| New user-facing workflow features | This milestone is architecture-only |
| Provider-specific optimizations | Engine is provider-agnostic by design |
| Enterprise patterns (DI containers, abstract factories) | Per VISION.md — this is a CLI tool, not a Spring application |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENG-01 | Phase 1 | Pending |
| ENG-02 | Phase 1 | Pending |
| ENG-03 | Phase 1 | Pending |
| ENG-04 | Phase 1 | Pending |
| CMD-01 | Phase 1 | Pending |
| CMD-02 | Phase 1 | Pending |
| CMD-03 | Phase 1 | Pending |
| CMD-04 | Phase 1 | Pending |
| CMD-05 | Phase 1 | Pending |
| CMD-06 | Phase 1 | Pending |
| CMD-07 | Phase 1 | Pending |
| TOOL-01 | Phase 1 | Pending |
| TOOL-02 | Phase 1 | Pending |
| TOOL-03 | Phase 1 | Pending |
| PROJ-01 | Phase 1 | Pending |
| PROJ-02 | Phase 1 | Pending |
| PROJ-03 | Phase 1 | Pending |
| PROJ-04 | Phase 1 | Pending |
| PROJ-05 | Phase 1 | Pending |
| MAN-01 | Phase 1 | Pending |
| MAN-02 | Phase 1 | Pending |
| MAN-03 | Phase 1 | Pending |
| MAN-04 | Phase 1 | Pending |
| MAN-05 | Phase 1 | Pending |
| EVT-01 | Phase 1 | Pending |
| EVT-02 | Phase 1 | Pending |
| EVT-03 | Phase 3 | Pending |
| EVT-04 | Phase 2 | Pending |
| SYNC-01 | Phase 2 | Pending |
| SYNC-02 | Phase 2 | Pending |
| SYNC-03 | Phase 2 | Pending |
| SYNC-04 | Phase 3 | Pending |
| SYNC-05 | Phase 3 | Pending |
| PMG-01 | Phase 2 | Pending |
| PMG-02 | Phase 2 | Pending |
| PMG-03 | Phase 2 | Pending |
| PMG-04 | Phase 3 | Complete (3-02) |
| PMG-05 | Phase 3 | Complete (3-02) |
| MIG-01 | Phase 3 | Pending |
| MIG-02 | Phase 3 | Pending |
| MIG-03 | Phase 3 | Pending |
| DOC-01 | Phase 4 | Pending |
| DOC-02 | Phase 4 | Pending |
| DOC-03 | Phase 4 | Pending |
| DOC-04 | Phase 4 | Pending |
| DOC-05 | Phase 4 | Pending |
| CLN-01 | Phase 5 | Pending |
| CLN-02 | Phase 5 | Pending |
| CLN-03 | Phase 5 | Pending |
| CLN-04 | Phase 5 | Pending |
| CLN-05 | Phase 5 | Pending |
| CLN-06 | Phase 5 | Pending |
| CLN-07 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 47 total
- Mapped to phases: 47
- Unmapped: 0

---
*Requirements defined: 2026-03-22*
*Last updated: 2026-03-22 after roadmap creation — all 47 requirements mapped*
