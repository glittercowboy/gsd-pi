# ADR-004: Single-Writer State Architecture

**Status:** Proposed
**Date:** 2026-03-22
**Deciders:** Jeremy McSwain
**Related:** [Issue #2041](https://github.com/gsd-build/gsd-2/issues/2041), ADR-001

## Context

GSD-2's state management is fighting itself. The repo declares state lives on disk in `.gsd/` markdown files, and auto-mode reads and writes those files to advance workflow. Simultaneously, prompts instruct agents to both produce substantive work _and_ perform bookkeeping — toggling plan and roadmap checkboxes, writing summary files with specific frontmatter, appending to decision logs. Post-unit code then runs doctor/rebuild/recovery passes to reconcile mismatches between these parallel representations.

One logical event — "task completed" — is smeared across multiple representations and multiple writers. That is classic split-brain state, just wearing a markdown mustache.

### The Five Redundant State Systems

| System | Location | Writer | Reader |
|--------|----------|--------|--------|
| In-memory `completedUnits[]` | Runtime | auto-mode loop | dispatch guards |
| `completed-units.json` | Disk | auto-post-unit | doctor, recovery |
| Markdown checkboxes | `*-PLAN.md`, `*-ROADMAP.md` | LLM via edit tool | `deriveState()`, doctor |
| Summary file existence | `*-SUMMARY.md` | LLM via write tool | artifact verification, state derivation |
| Runtime record JSON | Various `.json` files | session management | forensics, visualizer |

When these diverge — and they do, regularly — cascading failures occur.

### The Prompt Contract Problem

The repo's own prompt contracts are the smoking gun. `execute-task.md` explicitly tells the agent:

> "Mark T01 done in `S01-PLAN.md` (change `[ ]` to `[x]`)"
> "**You MUST mark T01 as `[x]` in PLAN.md AND write T01-SUMMARY.md before finishing.**"

`complete-slice.md` does the same for slice summary, UAT, and roadmap checkbox. Correctness depends on the model successfully doing brittle text surgery in markdown — regex-style find-and-replace on checkbox patterns — which is exactly the sort of thing models are mediocre at and silently wrong about. The LLM believes it performed the edit; the pattern didn't match; state becomes inconsistent.

### The Database That Already Failed

The codebase has explicit scar tissue from a previous DB attempt. In `state.ts:215-220`:

```typescript
// NOTE: We intentionally do NOT load from the SQLite DB here (#759).
// The DB's artifacts table is populated once during migrateFromMarkdown
// and is never updated when files change on disk (e.g. roadmap [x] updates,
// plan checkbox changes). Using stale DB content causes deriveState to
// return incorrect phase/slice state, leading to infinite skip loops.
```

The DB went stale because markdown remained the authoritative source and nothing enforced that DB updates happened on every mutation path. The problem was not "SQLite is bad." The problem was two writers with no single authority.

### Structured Tools Exist But Are Unused

Four structured tools are registered: `gsd_save_decision`, `gsd_save_summary`, `gsd_update_requirement`, `gsd_generate_milestone_id`. Only the last one is referenced in default prompts. The other three exist but the prompts instruct agents to manually edit markdown instead. The system already has the embryo of the right architecture — it just never committed to it.

### Quantified Impact

**Reconciliation-adjacent code in the codebase:**

| Category | Files | Lines |
|----------|-------|-------|
| State derivation (`state.ts`) | 1 | 868 |
| Doctor system (`doctor*.ts`) | 4 | 2,969 |
| Recovery code (`*-recovery.ts`, `crash-recovery.ts`) | 3 | 1,177 |
| Forensics (`forensics.ts`, `session-forensics.ts`) | 2 | 1,172 |
| File parsing/mutation (`files.ts`, `roadmap-*.ts`) | 3 | ~1,500 |
| Verification & closeout | 3 | 915 |
| Worktree state sync (`auto-worktree*.ts`) | 2 | 1,506 |
| **Total** | **~18** | **~10,107** |

**Blast radius:** 82 files / 430 occurrences of reconciliation patterns. 95 files / 748 occurrences of checkbox/completion state.

**48 non-fatal catch blocks** in `doctor-checks.ts` alone — errors silently swallowed across the reconciliation layer.

### Failure History

This is not random bug spray. It is a systemic signal:

- **#1558:** 20 units re-dispatched across phases because completion was not recognized
- **#1405:** complete-milestone looping because the unit key never made it to `completed-units.json`
- **#1063:** run-uat dispatched 7 times even though `S02-UAT-RESULT.md` existed and passed
- **#1576:** stale `STATE.md` + stale `completed-units.json`
- **#1466:** doctor itself needs more doctoring to catch "split-brain" state directories
- **#759:** DB abandoned as source of truth because it went stale behind markdown's back

## Decision

### Replace split-brain state with a single-writer command-driven state engine.

The architectural fix is not "swap markdown for SQLite." It is **single-writer architecture**: one runtime-owned state API through which all authoritative mutations must flow, with every projection derived from that committed state.

SQLite is a good backing store. But the conceptual boundary should be a **typed state engine**, not raw SQL scattered across files. The rest of the code depends on commands and queries, not on tables.

### The Three-Layer Architecture

```
┌──────────────────────────────────────────────────────┐
│                 Layer 1: Command API                  │
│            (What agents see and call)                 │
│                                                       │
│  complete_task(taskId, summary, evidence)             │
│  complete_slice(sliceId, summary, uat)                │
│  complete_milestone(milestoneId, summary)             │
│  plan_slice(milestoneId, sliceId, tasks)              │
│  start_task(taskId)                                   │
│  record_verification(taskId, checks, outcome)         │
│  save_decision(context, decision, rationale)          │
│  report_blocker(taskId, description)                  │
│  replan_slice(sliceId, reason, newTasks)              │
│                                                       │
│  Agents NEVER edit .gsd/ files for state purposes.    │
│  Each command is idempotent, validates preconditions,  │
│  writes atomically, emits an event, re-renders views. │
└───────────────────────┬──────────────────────────────┘
                        │ Typed commands
┌───────────────────────▼──────────────────────────────┐
│              Layer 2: State Engine                     │
│         (TypeScript owns ALL transitions)             │
│                                                       │
│  WorkflowEngine / StateStore class                    │
│  ┌─────────────────────────────────────┐              │
│  │  SQLite (backing store)             │              │
│  │  - milestones, slices, tasks        │              │
│  │  - decisions, requirements          │              │
│  │  - verification_evidence            │              │
│  │  - event_log (append-only)          │              │
│  └─────────────────────────────────────┘              │
│                                                       │
│  All mutations via command handlers.                  │
│  No direct SQL from outside the engine.               │
│  Transactions ensure atomicity.                       │
│  deriveState() = typed query method (<1ms).            │
│  Event emission after each committed transition.      │
└───────────────────────┬──────────────────────────────┘
                        │ Render after commit
┌───────────────────────▼──────────────────────────────┐
│            Layer 3: Markdown Projections               │
│       (Human-readable, regenerable, read-only)        │
│                                                       │
│  .gsd/ files become rendered views:                   │
│    *-PLAN.md    — task list with [x]/[ ] from DB      │
│    *-ROADMAP.md — slice list with [x]/[ ] from DB     │
│    *-SUMMARY.md — rendered from summary records       │
│    STATE.md     — rendered from engine.getState()     │
│    DECISIONS.md — rendered from decisions table       │
│                                                       │
│  Corruption/deletion → regenerate from engine.        │
│  Git-friendly diffs preserved for PR review.          │
│  Agents may read for context, never write for state.  │
└──────────────────────────────────────────────────────┘
```

### Core Principles

**1. One sheriff in town.** All state mutations go through the state engine's command interface. No markdown edits, no direct JSON writes, no in-memory arrays that disagree with disk. One writer, one truth.

**2. Commands, not file edits.** A completed task is one atomic operation: the command writes narrative fields, verification evidence, timestamps, and status in the authoritative store, then renders `T01-SUMMARY.md`, updates the plan projection to show `[x]`, and emits events for metrics/commits. If rendering fails, the command fails and rolls back.

**3. Separate workflow truth from operational telemetry.** Three categories are currently entangled:

| Category | Examples | Authority |
|----------|----------|-----------|
| Workflow state | Milestone/slice/task status, sequence, dependencies, active phase | State engine (authoritative) |
| Generated artifacts | Roadmap markdown, plan markdown, summaries, STATE.md | Projections (rendered from state) |
| Operational diagnostics | Activity logs, cost metrics, retries, health snapshots, git outcomes | Append-only telemetry |

Completion should never depend on a rendered file existing unless that file is itself created by the authoritative command.

**4. Work completed is decoupled from downstream housekeeping.** Issue #1405 shows exactly why: completion persistence must be independent of later closeout steps. The state engine records "task done" atomically. Git commit, worktree merge, branch cleanup — those are downstream effects that cannot invalidate already-completed state.

**5. Markdown is kept but demoted.** Humans can inspect and diff markdown in `.gsd/`. Agents can read it for context. But nobody treats those files as the thing that decides truth. They become views, not ledgers. Ledgers should not be editable by a stochastic intern with regex ambitions.

**6. Event sourcing lite.** Not full cathedral-grade event sourcing — just enough to record "command accepted," "state transitioned," "projections rendered." That gives replayability, auditability, and cheap debugging without making render files authoritative. Makes `/gsd forensics` far more trustworthy than inferring history from half-updated markdown.

### What Happens to Doctor

Doctor survives, but only as **infrastructure diagnostics**:

**Keep:**
- Git health (merge conflicts, worktrees, branches, remotes)
- Disk health (permissions, space, orphaned files)
- Environment health (Node version, native bindings, provider credentials)
- Symlink integrity, orphaned worktrees
- Event log corruption detection
- Projection drift detection (DB ↔ rendered markdown agreement → re-render if mismatch)

**Kill:**
- Checkbox/file mismatch reconciliation
- Placeholder summary generation
- "Self-healing" state drift fixes
- Health scoring and escalation for bookkeeping failures
- Stuck detection for completion-state disagreements
- `completed-units.json` orphan cleanup

If the architecture still needs a doctor to decide whether a task is done, the architecture is the patient.

### What Happens to completed-units.json

Replaced by two explicit concepts:

1. **Durable unit status** in the state engine (authoritative "is this done?")
2. **Append-only event log** for forensics (what happened during execution)

The failure reports around stale or missing `completed-units.json` are telling us that "was this unit completed?" and "what happened during execution?" are being conflated. Those must be separate. Unit status belongs in authoritative state. Forensics belong in an immutable log.

## Migration Strategy

### Phase 0: Foundation (Non-Breaking)

Add the `WorkflowEngine` class with typed command methods. Wire up `complete_task()` and `complete_slice()` as agent-callable tools. Both paths work: tools write to the engine (which persists to SQLite and renders markdown), and legacy markdown edits still function. Doctor validates both systems agree.

**Risk:** Minimal. Additive only. Existing behavior unchanged.

### Phase 1: Prompt Migration

Update prompt templates to call tools instead of editing markdown:
- `execute-task.md`: Replace "Mark T01 done in PLAN.md (change `[ ]` to `[x]`)" with "Call `complete_task(taskId, summary, evidence)`"
- `complete-slice.md`: Replace manual summary/UAT/checkbox steps with `complete_slice(sliceId, summary, uat)`
- Track which path was used (tool vs manual edit) via telemetry

**Risk:** Moderate. LLM compliance with new tool calls must be validated. Run both paths, compare outcomes.

### Phase 2: Tool Calls Mandatory

Prompts no longer mention manual checkbox editing. Manual `.gsd/` state edits by agents trigger warnings. `deriveState()` switches to query the state engine. `gsd migrate` command converts existing projects.

**Risk:** Moderate. Requires `gsd migrate` to be robust for all existing `.gsd/` directory shapes.

### Phase 3: Remove Parsing Code

Delete markdown-to-state parsing: `files.ts` checkbox logic, `roadmap-slices.ts` back-parsers, `parsePlan()` task reconstruction. `deriveState()` becomes a typed method on the engine. Doctor fix logic replaced by `engine.renderProjections()`.

**Risk:** Low (by this point, parsing code is dead code).

### Phase 4: Dead Code Cleanup

Remove reconciliation code, forensics for state drift, `completed-units.json` persistence, retry logic for checkbox failures. Reduce doctor to infrastructure health only.

**Risk:** Minimal (cleanup of confirmed dead code).

## Code Impact

### Estimated Deletions (~4,500–6,500 lines)

| Code | Lines | Replacement |
|------|-------|-------------|
| Doctor fix/reconciliation logic | ~800 | `engine.renderProjections()` |
| Health scoring/escalation for bookkeeping | ~430 | DB constraint violations |
| Markdown checkbox parsers (back-parsing) | ~300 | `engine.getState()` query |
| Checkbox mutation functions | ~200 | `UPDATE tasks SET status='done'` inside engine |
| `completed-units.json` tracking | ~150 | Durable status in engine |
| Stuck detection for state drift | ~75 | Impossible by construction |
| Placeholder summary generation | ~90 | Not needed |
| `deriveState()` markdown parsing | ~400 | Typed engine query |
| Reconciliation in auto-recovery | ~500 | Transaction rollback |
| Forensics for state inconsistency | ~600 | Event log query |
| Prompt bookkeeping instructions | ~1,000 | Tool schema definitions |
| `reconcilePlanCheckboxes()` worktree sync | ~78 | Engine handles state; projections re-rendered |

### Estimated Additions (~2,000–2,500 lines)

| New Code | Lines |
|----------|-------|
| `WorkflowEngine` class + command handlers | ~800 |
| SQLite schema + migrations | ~200 |
| Agent-callable tool implementations (6–9 tools) | ~400 |
| Markdown projection renderer (DB → `.md`) | ~400 |
| Migration command (`gsd migrate`) | ~300 |
| Event log infrastructure | ~200 |

### Net: –2,500 to –4,000 lines with dramatically improved reliability.

## Success Criteria

1. **Zero doctor fix runs in normal operation.** Doctor detects projection drift and re-renders. It never reconciles authoritative state.
2. **No "non-fatal" catch blocks for state inconsistency.** State is always consistent because there is one writer.
3. **Auto-mode never stops for bookkeeping failures.** `complete_task()` either succeeds atomically or fails with a clear, retryable error.
4. **Net code reduction of 2,500+ lines.**
5. **`deriveState()` executes in <1ms.** Typed query on the engine, not 868 lines of markdown parsing.
6. **No unbounded retry loops.** Tool calls succeed or fail; no "did the checkbox stick?" ambiguity. Hard cap of 3 retries on any completion tool.
7. **Forensics powered by event log, not markdown archaeology.**

## Implementation Priority

Start with `complete_task()`. This single tool eliminates:
- The most common failure mode (checkbox not toggled → state not recognized)
- The most expensive recovery path (artifact verification retry loops with no cap)
- The most wasteful token pattern (LLM reading entire PLAN.md to find one checkbox)

This one tool, deployed in Phase 0 dual-write mode, proves the architecture before committing to the full migration.

## Rejected Alternatives

### 1. "Just fix the prompts to be more explicit about checkboxes"

Treating the symptom, not the disease. Even perfect prompts would still rely on stochastic text surgery. The failure rate drops but never reaches zero, and the reconciliation code stays.

### 2. "Make SQLite the direct source of truth (raw SQL everywhere)"

This is what issue #759 tried. The problem was not SQLite — it was that markdown remained a parallel authority. Swapping which one is "primary" without eliminating the split-brain is not a fix. The engine must be the sole mutation path, with SQLite as its private implementation detail.

### 3. "Remove markdown entirely, go pure-DB"

Markdown serves real purposes: human readability, git diffs for PR review, agent context. The right answer is to demote it to a projection, not to kill it.

### 4. "Keep markdown as source of truth but improve doctor"

The doctor system is already 2,969 lines across 4 files with 48 non-fatal catch blocks. More doctoring is not the answer. If the architecture needs a doctor to decide whether a task is done, the architecture is the patient.

## References

- [Issue #2041: Replace Markdown-Based State Machine with Tool-Driven Database Architecture](https://github.com/gsd-build/gsd-2/issues/2041)
- [Issue #759: DB artifacts table goes stale, causes skip loops](state.ts:215-220)
- [Issue #1558: 20 units re-dispatched, completion not recognized](https://github.com/gsd-build/gsd-2/issues/1558)
- [Issue #1405: complete-milestone loops, unit key missing from completed-units.json](https://github.com/gsd-build/gsd-2/issues/1405)
- [Issue #1063: run-uat dispatched 7x despite passing UAT result](https://github.com/gsd-build/gsd-2/issues/1063)
- [Issue #1576: stale STATE.md + stale completed-units.json](https://github.com/gsd-build/gsd-2/issues/1576)
- [Issue #1466: doctor needs more doctoring for split-brain directories](https://github.com/gsd-build/gsd-2/issues/1466)
- ADR-001: Branchless Worktree Architecture (related complexity from state clobbering across branches)
