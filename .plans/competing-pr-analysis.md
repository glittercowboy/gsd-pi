# Competing PR Analysis: Single-Writer State Architecture

**Date:** 2026-03-23
**Analyst:** Claude Opus 4.6
**PRs Compared:**
- **PR #2141** (glittercowboy/Lex) — "Tool-driven write-side state transitions"
- **PRs #2217–#2222 + #2246** (jeremymcs) — "Single-writer state architecture" (6-PR stack)

---

## Executive Summary

Two developers independently converged on the same diagnosis: **GSD's markdown-mutation state machine is fundamentally broken.** Both identified the same root cause — agents performing brittle text surgery on markdown checkboxes creates split-brain state that cascading doctor/recovery/reconciliation code (10K+ lines) tries and fails to fix. Both proposed the same architectural solution: **single-writer state with SQLite-backed atomic commands where TypeScript owns all state transitions and markdown becomes a rendered view.**

The implementations diverge significantly in scope, layering, and migration strategy. Both produced independent ADRs — **Issue #2041** (Lex) and **ADR-004** (Jeremy) — which are compared in detail in Section 1A below.

---

## 1A. Competing ADR Comparison

Both ADRs document the same problem with remarkable overlap, but differ in architectural prescription and implementation detail.

### ADR Attribution

| | Lex's ADR (Issue #2041) | Jeremy's ADR (ADR-004) |
|---|---|---|
| **Location** | GitHub Issue #2041 | `docs/ADR-004-single-writer-state-architecture.md` |
| **Date** | 2026-03-22 | 2026-03-22 |
| **Length** | ~480 lines | ~317 lines |
| **Referenced by** | PR #2141 | PRs #2217–#2246 |

### Problem Diagnosis Overlap (Nearly Identical)

Both ADRs identify:
- The same 5 redundant state systems (in-memory array, completed-units.json, markdown checkboxes, summary file existence, runtime records)
- The same prompt contract problem (agents told to regex-toggle checkboxes)
- The same `state.ts:215-220` scar tissue where the DB was abandoned (#759)
- The same doctor code quantification (~3K+ lines of reconciliation)
- The same failure history (issues #759, #1063, #1405, #1558, #1576)

**Lex's ADR adds:** Quantified band-aid evidence (90 non-fatal catch blocks, 60+ issue references in code, 24 checkbox mutation call sites). Specific line-number citations for doctor fixes. Deeper cost accounting (~5,900 lines total).

**Jeremy's ADR adds:** The "Five Redundant State Systems" table with clear writer/reader attribution. The "48 non-fatal catch blocks in doctor-checks.ts alone" metric. The explicit three-layer architecture diagram. Quantified blast radius (82 files / 430 reconciliation pattern occurrences).

### Architectural Prescription (Key Differences)

| Dimension | Lex's ADR (#2041) | Jeremy's ADR (ADR-004) |
|-----------|-------------------|------------------------|
| **Core framing** | "Tool-driven database architecture" | "Single-writer command-driven state engine" |
| **Conceptual boundary** | Tool handlers with DB transactions | Typed state engine abstraction (WorkflowEngine) |
| **Tool schema richness** | Rich schemas with domain-specific fields (`oneLiner`, `narrative`, `forwardIntelligence`, `requirementsAdvanced`) | Minimal schemas focused on state transition params |
| **Tool count planned** | ~8 tool handlers (complete-task, plan-slice, complete-slice, plan-milestone, complete-milestone, research-*) | 17 tool calls covering every agent interaction |
| **Event sourcing** | Not mentioned | "Event sourcing lite" — append-only event log for audit trail and fork-point detection |
| **Worktree coordination** | Not addressed in ADR | Advisory sync locks + event replay for cross-worktree reconciliation |
| **Migration phases** | 5 phases (Foundation → Prompts → Mandatory → Remove parsing → Cleanup) | 5 phases (Foundation → Sync → Doctor → Dead code → Full API) |
| **Success criteria** | 5 criteria (identical to Jeremy's) | 7 criteria (adds forensics and retry cap) |
| **Code impact estimate** | ~2,500+ lines removed | Net –2,500 to –4,000 lines |
| **Doctor treatment** | "Remove or gut" — ~800 lines of fix logic | "Keep for infrastructure diagnostics" — explicit keep/kill lists |
| **Rejected alternatives** | Not listed | 4 explicitly rejected alternatives with rationale |
| **Three-layer diagram** | Implicit in description | Explicit ASCII architecture diagram (Command API → State Engine → Markdown Projections) |

### Lex's ADR Strengths Over Jeremy's

1. **Richer tool schemas.** The `complete_task` schema includes `forwardIntelligence`, `observabilitySurfaces`, `patternsEstablished` — capturing domain knowledge the LLM produces naturally. Jeremy's schemas are lean state-transition params. Lex's approach captures more value from each tool call.

2. **Deeper code archaeology.** Specific line-number citations (e.g., "doctor.ts:801-816", "auto-recovery.ts:331-348") for every reconciliation function. This makes the case more auditable.

3. **Full SQL schema in ADR.** The proposed table definitions are in the ADR itself, making it a self-contained specification. Jeremy's ADR describes tables conceptually but delegates schema to implementation.

4. **Band-aid quantification.** "90 non-fatal catch blocks", "60+ issue references", "24 calls to checkbox mutation functions" — concrete metrics that Jeremy's ADR doesn't provide at the same granularity.

### Jeremy's ADR Strengths Over Lex's

1. **Architectural abstraction.** The three-layer architecture (Command API → State Engine → Projections) establishes a clear conceptual boundary. Lex's ADR describes tool handlers with DB transactions but doesn't name or formalize the engine abstraction. This matters for future contributors who need to understand where new tools go.

2. **Event sourcing lite.** The event log for fork-point detection and forensics is entirely absent from Lex's ADR. For a tool that uses worktrees heavily, cross-worktree state coordination is a critical gap.

3. **Explicit rejected alternatives.** Four alternatives with specific rationale for rejection — including "Just fix the prompts" and "Make SQLite the direct source of truth" — which preempts common pushback.

4. **Doctor keep/kill taxonomy.** Jeremy's ADR explicitly lists what doctor keeps (git health, disk health, environment health, projection drift detection) vs. what it kills. Lex's ADR says "remove or gut" without specifying what survives.

5. **The "one sheriff in town" principle.** Jeremy's ADR distills the core insight into a memorable principle: "If the architecture still needs a doctor to decide whether a task is done, the architecture is the patient." Lex's ADR has similar sentiment but less pithy framing.

6. **Scope completeness.** Jeremy's ADR envisions 17 tools covering every agent interaction. Lex's ADR describes ~8 tools. The ADR's own logic argues for complete coverage — partial coverage preserves the split-brain in uncovered paths.

### Where Both ADRs Agree Exactly

- Zero doctor fix runs in normal operation
- No "non-fatal" catch blocks for state inconsistency
- Auto-mode never stops for bookkeeping failures
- Net code reduction of 2,000-2,500+ lines
- `deriveState()` executes in <1ms
- Markdown files become rendered views, never parsed back for state
- SQLite transactions for atomic state transitions
- Phased migration with filesystem fallback

---

## 1. Architectural Comparison

### PR #2141 (Lex) — "Pragmatic Surgical"

| Dimension | Detail |
|-----------|--------|
| **Pattern** | Direct tool handlers with DB transactions |
| **Scope** | 2 tool calls: `gsd_complete_task`, `gsd_slice_complete` |
| **Layers** | Tool handler → DB transaction → Markdown render → Cache invalidation |
| **New modules** | 3 (`markdown-renderer.ts`, `tools/complete-task.ts`, `tools/complete-slice.ts`) |
| **Schema** | v4→v7 (milestones/slices/tasks/verification_evidence tables) |
| **Lines** | +8,828 / -1,441 (54 files) |
| **Tests** | 12 new test files, 189-assertion cross-validation suite |
| **Doctor** | Removed 7 reconciliation issue codes, ~800 lines deleted |
| **Migration** | Auto-migration via `md-importer.ts` on first access |
| **Delivery** | Single monolithic PR, 4 commits |

**Architecture pattern:** Each tool handler is a self-contained operation:
1. Validate inputs (ID format, parent existence)
2. DB transaction (INSERT OR REPLACE)
3. Render markdown to disk (summary file, checkbox toggle)
4. Store rendered markdown back in DB for crash recovery
5. Invalidate caches

**Key insight:** Starts with the highest-impact operations (task/slice completion) that cause 80%+ of state drift failures, leaving milestone/roadmap operations for later.

### PR Stack #2217–#2246 (Jeremy) — "Full Architecture"

| Dimension | Detail |
|-----------|--------|
| **Pattern** | Event-sourcing-lite engine with typed commands, projections, and event log |
| **Scope** | 17 tool calls covering ALL agent-workflow interactions |
| **Layers** | Tool Registration → WorkflowEngine → Command Handlers → DB Transaction → Event Log → Projections → Manifest |
| **New modules** | 10+ (`workflow-engine.ts`, `workflow-commands.ts`, `workflow-events.ts`, `workflow-projections.ts`, `workflow-manifest.ts`, `workflow-engine-schema.ts`, `workflow-migration.ts`, `workflow-reconcile.ts`, `sync-lock.ts`, `write-intercept.ts`, `workflow-logger.ts`, `engine-types.ts`, `engine-resolver.ts`, `legacy/parsers.ts`) |
| **Schema** | Engine-specific tables + event log |
| **Lines** | +10,990 / -3,900 (PR #2246 alone; cumulative across stack much larger) |
| **Tests** | 18+ engine test files, cross-validation suite |
| **Doctor** | Parser relocation to `legacy/`, reconciliation replaced with `checkEngineHealth()` |
| **Migration** | Phased: Foundation → Sync → Doctor cleanup → Dead code → Build fixes → Full API |
| **Delivery** | 6 sequential PRs with dependencies |
| **Documentation** | ADR-004, SINGLE-WRITER-STATE-MAP.md |

**Architecture pattern:** Three-layer architecture:
1. **Command API** — What agents see and call (17 typed tools)
2. **State Engine** — TypeScript-owned WorkflowEngine with SQLite backing
3. **Markdown Projections** — Human-readable rendered views

**Key insight:** Full coverage of every agent interaction point, not just task/slice completion. Includes write interception (catching rogue agent writes), advisory sync locks for worktrees, event replay for cross-worktree reconciliation.

---

## 2. Scope Coverage Analysis

### What each PR covers

| Workflow Interaction | PR #2141 | Stack #2246 |
|---------------------|----------|-------------|
| Complete task | `gsd_complete_task` | `gsd_complete_task` |
| Complete slice | `gsd_slice_complete` | `gsd_complete_slice` |
| Plan slice (task definition) | — | `gsd_plan_slice` |
| Start task | — | `gsd_start_task` |
| Record verification | — | `gsd_record_verification` |
| Save decision | — | `gsd_save_decision` |
| Report blocker | — | `gsd_report_blocker` |
| Create milestone | — | `gsd_create_milestone` |
| Plan milestone (roadmap) | — | `gsd_plan_milestone` |
| Complete milestone | — | `gsd_complete_milestone` |
| Validate milestone | — | `gsd_validate_milestone` |
| Update roadmap | — | `gsd_update_roadmap` |
| Save context | — | `gsd_save_context` |
| Save research | — | `gsd_save_research` |
| Save requirements | — | `gsd_save_requirements` |
| Save UAT result | — | `gsd_save_uat_result` |
| Save knowledge | — | `gsd_save_knowledge` |
| Undo task | CLI command | — |
| Reset slice | CLI command | — |
| DB recovery | `gsd recover` | Event replay |
| Rogue file detection | `detectRogueFileWrites()` | `write-intercept.ts` |

**Gap in #2141:** 15 workflow interactions still rely on agents writing markdown directly. The ADR explicitly warns that `plan-milestone` (agents writing ROADMAP.md in table format instead of checkbox format) causes `parseRoadmap()` to find 0 slices, breaking auto-mode. PR #2141 doesn't address this.

**Gap in Stack:** No CLI undo-task/reset-slice commands. No `gsd recover` equivalent (relies on event replay instead). The undo story is less developed.

---

## 3. File Overlap & Merge Conflict Analysis

### HIGH Severity Conflicts (6 files)

| File | #2141 Approach | Stack Approach | Verdict |
|------|---------------|----------------|---------|
| `state.ts` | +510 lines: `deriveStateFromDb()` SQL rewrite with filesystem fallback | Engine-backed `deriveState()` delegating to WorkflowEngine | **Irreconcilable** — fundamentally different derivation paths |
| `gsd-db.ts` | +638 lines: schema v5–v7 tables, hierarchy CRUD functions | Engine schema tables, different column set | **Irreconcilable** — both extend DB differently |
| `auto-recovery.ts` | -134 lines: reference `gsd recover` in remediation | Rewrite for engine health checks | **Irreconcilable** — different recovery model |
| `auto-worktree.ts` | Shared WAL via `resolveProjectRootDbPath()` | Advisory sync locks + event replay | **Irreconcilable** — different concurrency model |
| `auto.ts` | Minor (-2 lines) | Major rewrite for engine integration | **Resolvable** but requires stack's version |
| `auto-timeout-recovery.ts` | Minor changes | Major changes for engine | **Resolvable** |

### MEDIUM Severity Conflicts (8 files)

| File | Notes |
|------|-------|
| `auto-post-unit.ts` | Both add rogue detection but via different mechanisms |
| `commands-maintenance.ts` | Both add recovery commands but different ones |
| `commands/catalog.ts` | Both register new commands |
| `commands/handlers/ops.ts` | Both add operation handlers |
| `doctor.ts` | Both gut reconciliation but leave different remnants |
| `doctor-types.ts` | Both remove completion transition codes |
| `undo.ts` | #2141 adds undo-task/reset-slice; Stack makes different changes |
| Prompt files (5) | Both rewrite prompts for tool calls — different tool names |

### Delete/Modify Conflicts

| File | #2141 | Stack |
|------|-------|-------|
| `roadmap-mutations.ts` | **DELETED** | Not touched (may still be imported) |
| `doctor-task-done-missing-summary-slice-loop.test.ts` | **DELETED** | Not touched |

### Unique Files (No Conflict)

- **#2141 only:** `markdown-renderer.ts`, `tools/complete-slice.ts`, `tools/complete-task.ts`, `bootstrap/db-tools.ts`
- **Stack only:** All `workflow-*.ts` modules, `sync-lock.ts`, `write-intercept.ts`, `engine-*.ts`, `legacy/parsers.ts`, ADR-004, plus 30+ other modified files

**Bottom line:** These PRs are **not mergeable together.** One must be chosen as the base, and specific features from the other cherry-picked.

---

## 4. Regression Risk Analysis

### PR #2141 Regression Risks

| Risk | Severity | Description |
|------|----------|-------------|
| Partial coverage gap | HIGH | Only 2/17 tool calls covered. Agents still write markdown for plan-milestone, complete-milestone, etc. — the exact pattern the PR argues is broken |
| Schema migration fragility | MEDIUM | v4→v7 jump with no intermediate migration path. Existing projects with v5 or v6 data from other features could break |
| Bidirectional markdown render | MEDIUM | `markdown-renderer.ts` (721 lines) maintains two-way sync between DB and markdown. This is the exact split-brain pattern the ADR warns against — just with different writers |
| Doctor removal without replacement | MEDIUM | 800 lines of reconciliation deleted, but 15 workflow paths still produce markdown directly. What catches drift in uncovered paths? |
| Monolithic PR reviewability | LOW | 8,828 additions in one PR. Comment from igouss: "the PRs that AI generate are huge, and impossible to review" |

### Stack #2217–#2246 Regression Risks

| Risk | Severity | Description |
|------|----------|-------------|
| Build regression cascade | HIGH | PR 5/6 (#2222) exists **solely** to fix build failures and 26 test regressions from PRs 1–4. This means the incremental PRs don't independently compile/pass |
| Over-engineering | HIGH | 10+ new modules, IPolymorphicEngine interface, engine-resolver pattern. The complexity budget is high for what is fundamentally "use tools instead of file writes" |
| Layer count | MEDIUM | Tool → Engine → Command → Transaction → Event Log → Projection → Manifest — 7 layers for each operation. Debugging through this stack is non-trivial |
| Event log scalability | MEDIUM | Append-only event log + compaction. For a local CLI tool this is significant operational complexity |
| Dependency chain fragility | MEDIUM | 6 sequential PRs where each depends on the previous. If any PR needs rework, all downstream PRs need rebasing |
| Pass-through commands | LOW | `gsd_save_context`, `gsd_save_research`, `gsd_save_knowledge` are marked "pass-through" — they don't actually write to engine tables, undermining the single-writer principle |

---

## 5. Future Impact Analysis

### If PR #2141 is merged first

1. **Immediate benefit:** Task/slice completion becomes atomic and reliable — the highest-impact fix
2. **Remaining work:** 15 more tool calls needed to cover all workflow interactions (see ADR gap analysis)
3. **Technical debt:** `markdown-renderer.ts` bidirectional sync becomes load-bearing and grows. Each new tool call needs its own renderer integration
4. **Migration path:** Would need to either (a) adopt the WorkflowEngine pattern from the stack for remaining tools, creating architectural inconsistency, or (b) continue the ad-hoc tool handler pattern, accumulating standalone handlers
5. **Doctor gap:** With reconciliation removed but only 2 tools guarding state, new drift patterns emerge in uncovered workflow paths

### If the Stack is merged first

1. **Immediate benefit:** Complete coverage of all 17 workflow interactions. Event log provides forensics
2. **Remaining work:** CLI undo/reset commands, `gsd recover` equivalent
3. **Technical debt:** 10+ new modules to maintain. WorkflowEngine becomes a central abstraction everyone must understand
4. **Migration path:** Clean — all new tools follow the same pattern through the engine
5. **Cherry-pick opportunities:** PR #2141's `markdown-renderer.ts` could enhance the stack's projection layer. The `gsd recover` command is independently valuable. The cross-validation test suite (189 assertions) should be adopted

### If neither is merged (status quo)

1. **Known bugs remain:** All 11 issues referenced by PR #2141 stay open (#2041, #2201, #2202, #1925, #1924, #1768, #2022, #2196, #2076, #1941)
2. **Doctor continues to grow:** More reconciliation code, more catch blocks, more band-aids
3. **Auto-mode reliability stays low:** Agents will continue to fail at checkbox toggling

---

## 6. Quality & Testing Comparison

| Metric | PR #2141 | Stack #2246 |
|--------|----------|-------------|
| New test files | 12 | 18+ |
| Integration proof | 643-line end-to-end test covering 13 requirements | Per-module unit tests + cross-validation |
| Cross-validation | 189 assertions proving DB/filesystem equivalence | 7 scenarios in derive-state-crossval |
| Doctor test updates | 9 existing test files updated | Multiple doctor test files updated |
| Prompt contract tests | Yes (`prompt-contracts.test.ts`) | Yes (engine prompt-migration tests) |
| CI status | Commits show iterative fixes (4 commits, 3 are fix commits) | PR 5/6 is entirely build/test fixes |

**Observation:** Both PRs show signs of "fix-forward" development where the initial implementation broke tests that subsequent commits had to repair. PR #2141 does this within a single PR (3 fix commits after the feature commit). The stack does this across PRs (#2222 is a dedicated fix PR).

---

## 7. Recommendation

### Primary recommendation: **Merge the Stack (#2217–#2246) as the architectural foundation, then cherry-pick specific features from #2141.**

**Rationale:**

1. **Completeness wins.** The stack covers all 17 workflow interactions. PR #2141 covers 2. The ADR explicitly documents that partial coverage leaves the same failure patterns in uncovered paths — the plan-milestone example is a smoking gun.

2. **The ADR is load-bearing.** Having ADR-004 as an architectural decision record means future contributors understand *why* the architecture is this way. PR #2141 has no equivalent documentation beyond the PR description.

3. **Consistent pattern.** All 17 tools follow the same `Command → Engine → Transaction → Event → Projection` pattern. PR #2141's ad-hoc handlers would need to be retrofitted if the remaining 15 tools are added later.

4. **Worktree coordination.** The stack's advisory sync locks + event replay is more sophisticated than PR #2141's shared WAL approach. For a tool that uses worktrees heavily, this matters.

### Cherry-pick from #2141:

| Feature | Value | Effort |
|---------|-------|--------|
| `gsd recover` command | HIGH — DB reconstruction from markdown when things go wrong | LOW |
| Cross-validation test suite (189 assertions) | HIGH — proves DB/filesystem equivalence | LOW |
| Integration proof test (643 lines) | MEDIUM — end-to-end lifecycle test | MEDIUM |
| Rogue file detection approach | MEDIUM — complements write-intercept | LOW |
| CLI undo-task/reset-slice | MEDIUM — user-facing recovery tools | MEDIUM |

### Concerns to address in the Stack before merge:

1. **Build regression cascade** — PRs 1-4 should compile and pass tests independently, not require PR 5 as a fix-up
2. **IPolymorphicEngine complexity** — Evaluate whether this abstraction is necessary or if a simpler direct engine reference suffices
3. **Pass-through commands** — `save_context`, `save_research`, `save_knowledge` bypassing the engine undermines the single-writer principle. Either commit to engine storage or document why these are exceptions
4. **Event log operational cost** — Add compaction/pruning to prevent unbounded growth
5. **Review PR sizes** — igouss's comment ("impossible to review") applies to both PRs. Consider squashing the 6-PR stack into 2-3 logical units

---

## 8. Issue Resolution Matrix

| Issue | PR #2141 | Stack | Notes |
|-------|----------|-------|-------|
| #2041 (ADR for tool-driven DB) | Closes | Closes | Both address this |
| #2201 (Doctor marks slice without summary) | Closes | Addressed | Stack removes doctor reconciliation |
| #2202 (Doctor destructive uncheck) | Closes | Addressed | Stack removes doctor reconciliation |
| #1925 (Doctor fix reverted by worktree sync) | Closes | Addressed | Stack replaces sync mechanism |
| #1924 (Doctor fix silent failure) | Closes | Addressed | Stack removes the fix function |
| #1768 (.gsd gitignore inconsistency) | Closes | Partial | Stack addresses via `.gitignore` changes |
| #2022 (Complete-slice HTML comment loop) | Closes | Addressed | Both eliminate checkbox parsing |
| #2196 (Complete-milestone deadlock) | Closes | Addressed | Stack adds `gsd_complete_milestone` tool |
| #2076 (completed-units.json not flushed) | Closes | Addressed | Both eliminate completed-units.json dependency |
| #1941 (Milestone with summary but unchecked) | Closes | Addressed | Both use DB as authority |

---

## 9. Timeline & Effort

| Metric | PR #2141 | Stack |
|--------|----------|-------|
| Development time | ~1 day (all commits 2026-03-22) | Multi-session (6 PRs across days) |
| Time to merge-ready | Could merge with fixes from review | Needs squash/rebase, build fixes |
| Post-merge stabilization | Will need 15 more tools added incrementally | Largely complete — needs undo/recovery features |

---

## Appendix: The Shared Theory

Both developers arrived at the same diagnosis independently — a strong signal that this is a real architectural problem, not a matter of taste. The key quotes:

**PR #2141 (Lex):**
> "The LLM is excellent at [creative work] and unreliable at [mechanical bookkeeping]. When checkbox toggling fails silently, five independent state markers disagree."

**ADR-004 (Jeremy):**
> "One logical event — 'task completed' — is smeared across multiple representations and multiple writers. That is classic split-brain state, just wearing a markdown mustache."

**Shared conclusion:** Stop using markdown mutation as the authority for state transitions. TypeScript owns all writes. Markdown becomes a rendered view.

---

## 10. Deep Architecture Review — PR #2141

*Findings from code-level analysis of tool handlers, state derivation, markdown renderer, and migration logic.*

### Pattern Assessment: Command-sourced state machine with rendered view layer

The separation is well-defined: write path funnels through two tool handlers with DB transactions first, then disk projection. The transaction-first-then-render protocol is consistent across both handlers.

### Critical Finding: Split Authority Model

**PR #2141 claims "TypeScript owns all state transitions" but only covers 2 of ~10 state-changing operations.** The remaining operations still use LLM file writes, creating a split-authority model that is arguably *more complex* than the original single-authority (filesystem) model. Consumers must now reason about which authority to trust for which state:

- **DB-authoritative:** task completion, slice completion
- **File-authoritative:** milestone creation, slice planning, roadmap mutations, milestone completion/validation, decision recording, replan operations

`deriveStateFromDb()` must consult both — it queries DB tables AND checks `resolveMilestoneFile()` for PARKED, VALIDATION, CONTEXT-DRAFT, SUMMARY files on disk. The PR acknowledges this: "Flag files are still checked on the filesystem since they aren't in DB tables."

### Critical Finding: Bidirectional Markdown Creates Circular Dependencies

`markdown-renderer.ts` implements:
- `loadArtifactContent()` — reads from DB first, **falls back to disk, then stores disk content back into DB**
- `detectStaleRenders()` — reads disk files and compares against DB
- `repairStaleRenders()` — re-renders from DB to fix disk mismatches

The disk-to-DB backfill in `loadArtifactContent()` creates a circular dependency: if disk content was stale or corrupt, that bad state gets canonicalized into the DB. This is not an anti-pattern per se (it is necessary for migration), but must be treated as transitional — once all projects migrate, the disk fallback should fail explicitly rather than silently backfilling.

### Critical Finding: No Concurrency Control for Disk Writes

SQLite WAL handles DB write serialization, but markdown file writes happen outside the transaction with no file-level locking. Two parallel agents completing tasks in the same slice could interleave plan checkbox writes, corrupting the file.

### Critical Finding: Regex-Based Checkbox Toggling is Fragile

The checkbox pattern `^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${sid}:` assumes a specific markdown format. If the LLM generates a roadmap with different formatting (extra spaces, no bold markers, different heading levels), the regex silently fails. `renderRoadmapCheckboxes()` returns `true` even when no regexes matched.

### Finding: Recovery Column is Architectural Debt

Storing `full_summary_md` back into DB (step 5 of the handler) means the handler writes to DB twice — once in the transaction, once outside it. If the process crashes between disk render (step 3) and recovery store (step 5), the DB has the task marked complete but no recovery content stored. The mitigation is that the file IS on disk for `gsd recover`, but this double-write is architecturally awkward.

### Finding: INSERT OR IGNORE First-Writer-Wins

Milestone and slice rows created by completion tool calls use `INSERT OR IGNORE`, meaning the first `gsd_complete_task` call for a new milestone creates a milestone row with **empty title, empty depends_on, and default status**. This metadata persists permanently if migration never runs.

### Missing: No Event/Audit Log

Tool calls write state directly but produce no event stream. The stack's event log approach provides replayability, auditability, and debugging that PR #2141 lacks entirely.

---

## 11. Deep Architecture Review — Stack #2217–#2246

*Findings from code-level analysis of WorkflowEngine, commands, events, projections, sync locks, and write intercept.*

### Pattern Assessment: Correctly Identified as NOT Event Sourcing

**This is a command-driven single-writer architecture with event logging, not event sourcing.** The distinction matters. SQLite is the authoritative state store. Commands mutate SQLite directly via UPDATE/INSERT, and events are appended afterward as an audit trail. `deriveState()` queries SQLite tables, not event replay.

This is the correct choice for this domain:
- One writer (the engine)
- Small state (dozens of rows, not millions)
- Event log serves fork-point detection for worktree merges and auditing, not state reconstruction

The ADR calls this "event sourcing lite" and the implementation matches that promise.

### Positive Finding: IPolymorphicEngine Was Removed

The PR #2222 description mentions `IPolymorphicEngine`, but it does not exist in the current codebase. The simpler pattern — `isEngineAvailable()` check with fallback to legacy behavior — was adopted instead. **This is the right call** for a migration period that will end.

### Positive Finding: Clean Module Boundaries

Each module has single, bounded responsibility:
- `workflow-commands.ts` — pure data mutation, no I/O except SQLite. Testable in isolation.
- `workflow-events.ts` — append-only file I/O. Four functions, ~140 lines.
- `workflow-projections.ts` — read-only rendering. Pure functions.
- `workflow-manifest.ts` — snapshot/restore. Straightforward serialization.
- `workflow-logger.ts` — in-memory ring buffer with stderr forwarding. ~152 lines.

### Critical Finding: `deriveState()` Has Write Side Effects

In `WorkflowEngine.deriveState()`, when no active slice exists, the method promotes the first pending slice with satisfied dependencies to active status by running an `UPDATE` statement. **A read operation that mutates state violates the single-writer principle the ADR champions.** This auto-promotion should be a separate command or happen during slice completion.

### Critical Finding: Replay Lacks Idempotency Guarantees

The `replay()` method delegates to the same command handlers used for normal operations. Some commands are idempotent (e.g., `completeTask` checks if already done), but `planSlice` throws if the slice already has tasks. **If event replay is interrupted and retried, `planSlice` events would fail on the second attempt.** This is a real gap for crash recovery during reconciliation.

### Critical Finding: afterCommand Failures are Silent

In `WorkflowEngine.afterCommand()`, projection rendering, manifest writing, and event appending are all wrapped in individual try/catch blocks with `logWarning`. A command can succeed (SQLite mutation committed) but its projections, manifest, and event log can all silently fail. The user sees success, but markdown files are stale and the event log has a gap — breaking fork-point detection.

### Finding: Write Intercept Only Blocks STATE.md

Only `STATE.md` is blocked from agent writes. ROADMAP.md, PLAN.md, SUMMARY.md are not blocked. But in the new architecture, these are engine-rendered projections. If an agent writes to PLAN.md directly, the engine overwrites it on the next `afterCommand` call. Agent edits silently vanish — confusing user experience.

### Finding: Circular Import Between Projections and Engine

`workflow-projections.ts` imports from `workflow-engine.ts` and vice versa. `renderStateProjection` constructs a new `WorkflowEngine` instance to call `deriveState()`. This works with ESM runtime resolution but is fragile and could break under bundler transformations.

### Finding: Pass-Through Commands Are Thin Wrappers

`saveContext`, `saveKnowledge` do almost nothing — they validate milestone existence and return `{ saved: true }`. The actual file writes happen in the afterCommand hook. These are "routing commands" that exist to trigger the afterCommand pipeline. Architecturally clean (one entry point) but the implementations could confuse future maintainers.

### Finding: Manifest Contains Unbounded Data

`StateManifest` includes `verification_evidence` with `stdout` and `stderr` fields. Test output can be large. The manifest is written after every command. With many verification records, `state-manifest.json` could grow unbounded.

---

## 12. Consolidated Risk Matrix

| Risk | PR #2141 | Stack | Severity |
|------|----------|-------|----------|
| Split authority (DB+files) | **YES** — 2/10 operations covered | NO — 17/17 covered | CRITICAL for #2141 |
| Bidirectional markdown sync | **YES** — circular disk↔DB backfill | NO — one-directional projections | HIGH for #2141 |
| No concurrency control (disk) | **YES** — no file locking | Partial — advisory sync locks | MEDIUM for both |
| Regex checkbox fragility | **YES** — silent match failures | Less exposed — engine writes directly | MEDIUM for #2141 |
| deriveState() write side effect | NO | **YES** — promotes slice on read | MEDIUM for Stack |
| Replay idempotency gap | N/A | **YES** — planSlice throws on retry | MEDIUM for Stack |
| Silent afterCommand failures | N/A | **YES** — stale projections/events | MEDIUM for Stack |
| No undo/rollback | NO — has CLI undo commands | **YES** — no undo mechanism | MEDIUM for Stack |
| Build regression cascade | NO — single PR | **YES** — PR 5/6 is fix-only | MEDIUM for Stack |
| No event audit trail | **YES** — no event log | NO — has event log | LOW-MEDIUM for #2141 |
| Pass-through commands | N/A | **YES** — thin routing wrappers | LOW for Stack |
| Write intercept gaps | Rogue detection (post-hoc) | Only blocks STATE.md | LOW for both |

---

## 13. Final Verdict

### Architecture quality score (1-10):

| Dimension | PR #2141 | Stack |
|-----------|----------|-------|
| Correctness of diagnosis | 10 | 10 |
| Scope completeness | 4 | 9 |
| Separation of concerns | 6 | 8 |
| Migration safety | 7 | 6 |
| Testing rigor | 8 | 7 |
| Documentation | 5 | 9 |
| Operational safety | 6 | 6 |
| Maintainability | 7 | 6 |
| **Weighted average** | **6.3** | **7.6** |

### Recommendation stands: Merge the Stack, cherry-pick from #2141.

The stack has more architectural risk items (6 findings) but they are all fixable without changing the architecture. PR #2141's critical finding — split authority between DB and files — is an architectural flaw that cannot be fixed without expanding scope to match the stack's 17-tool coverage, at which point you'd be rebuilding the engine anyway.
