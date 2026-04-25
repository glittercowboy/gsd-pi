# ADR-003: Auto-Mode Pipeline Simplification

**Status:** Proposed
**Date:** 2026-03-18
**Deciders:** Lex Christopherson
**Related:** ADR-001 (branchless worktree architecture), ADR-002 (external state directory)
**Audited by:** Claude Opus 4.6, OpenAI Codex — findings incorporated below.

## Context

GSD auto-mode orchestrates a multi-session pipeline where each "unit" of work runs in a fresh LLM session. The pipeline for a single milestone with N slices and M tasks per slice runs through:

```
research-milestone → plan-milestone →
  (research-slice → plan-slice → execute-task × M → complete-slice → reassess-roadmap) × N →
  validate-milestone → complete-milestone
```

The exact session count depends on profile. The "quality" profile runs all phases. The "balanced" profile skips slice research by default. The "budget" profile skips milestone research, slice research, reassessment, and milestone validation. This ADR uses the quality profile as the baseline for analysis — it represents the full pipeline and the worst-case ceremony overhead.

For a typical 4-slice, 3-task milestone under the quality profile:
- 1 research-milestone + 1 plan-milestone
- Per slice: research-slice (skipped for S01) + plan-slice + 3 execute-task + complete-slice + reassess-roadmap (skipped for last slice, since all slices are done)
- Per-slice total for S01: 0 + 1 + 3 + 1 + 1 = 6
- Per-slice total for S02–S04: 1 + 1 + 3 + 1 + 1 = 7 (S04 skips reassess since it's the last completed slice: 6)
- Slices total: 6 + 7 + 7 + 6 = 26
- Plus: 1 validate-milestone + 1 complete-milestone

**Total: 30 sessions.** Only 12 are task execution. The remaining 18 are pipeline ceremony.

(The "balanced" profile drops slice research for S02-S04: 30 - 3 = 27 sessions. The "budget" profile drops milestone research, all slice research, reassessment, and validation: 30 - 1 - 3 - 3 - 1 = 22 sessions.)

### The Token Tax

Every fresh session re-ingests static context via prompt inlining. The `auto-prompts.ts` builders (1,099 lines) inline the following files into nearly every unit type:

| File | Inlined Into | Changes After |
|------|-------------|---------------|
| ROADMAP | research-slice, plan-slice, execute-task (excerpt), complete-slice, reassess, validate, complete-milestone | plan-milestone (rare reassess rewrites) |
| DECISIONS.md | research-milestone, plan-milestone, research-slice, plan-slice, complete-milestone, validate | Appended occasionally during execution |
| REQUIREMENTS.md | research-milestone, plan-milestone, research-slice, plan-slice, complete-slice, complete-milestone, validate | Updated during complete-slice |
| KNOWLEDGE.md | research-milestone, plan-milestone, research-slice, plan-slice, execute-task, complete-slice, complete-milestone, validate | Appended occasionally during execution |
| PROJECT.md | research-milestone, plan-milestone, complete-milestone, validate | Rarely updated |

The ROADMAP alone is inlined into 7 unit types. It never changes during normal execution. This is a static document being re-tokenized per session at a cost of 5–20K tokens each time.

For the 30-session milestone above (quality profile), context re-ingestion costs approximately:
- ROADMAP: 7 re-inlines × ~10K tokens = 70K tokens
- DECISIONS: 6 re-inlines × ~5K tokens = 30K tokens
- REQUIREMENTS: 8 re-inlines × ~5K tokens = 40K tokens
- KNOWLEDGE: 8 re-inlines × ~3K tokens = 24K tokens
- Templates (research, plan, task-plan, etc.): ~2K per inline × ~10 units = 20K tokens
- Dependency summaries: ~8K per slice plan × 3 non-S01 slices = 24K tokens

**Total context re-ingestion overhead: ~208K tokens per milestone.** This is pure waste — the LLM re-reads documents it already processed in prior sessions, gaining no new information.

### The Lossy Handoff Problem

Each session boundary is a lossy compression step. The research-milestone agent reads the codebase and writes a RESEARCH.md. The plan-milestone agent reads that research and produces a ROADMAP. The research-slice agent reads the ROADMAP and explores the codebase again for its slice scope. The plan-slice agent reads that slice research and produces a PLAN.

This is a game of telephone:

```
Codebase → [researcher reads code] → RESEARCH.md → [planner reads research] → ROADMAP
                                                      ↑ often re-reads the same code
```

The research prompt explicitly says: *"Write for the roadmap planner."* The plan prompt says: *"Trust the research. Don't re-read code."* But planners routinely re-read code because research is a lossy compression — a summary of what one LLM session saw, not the thing itself. The fidelity loss compounds at each handoff.

### The Machinery Tax

The multi-session pipeline requires extensive orchestration machinery to handle edge cases, failures, and recovery:

| File | Lines | Purpose |
|------|-------|---------|
| `auto-recovery.ts` | 591 | Artifact resolution, loop remediation, skip/rerun logic |
| `auto-stuck-detection.ts` | 220 | Dispatch loop detection, lifetime caps, stub recovery |
| `auto-idempotency.ts` | 150 | Skip completed units, phantom loop detection, stale key recovery |
| `session-forensics.ts` | 536 | Post-mortem analysis, crash briefings, deep diagnostics |
| `auto-timeout-recovery.ts` | 262 | Resume after timeout, recovery briefing synthesis |
| `crash-recovery.ts` | 108 | Lock file management, crash detection |
| `auto-post-unit.ts` | 591 | Post-agent processing, verification, commits, state sync |
| `auto-verification.ts` | 229 | Post-task verification enforcement |
| `verification-gate.ts` | 643 | Test/lint/audit gate runner |
| `doctor-proactive.ts` | 292 | Health checks, proactive healing, escalation detection |
| **Total** | **3,622** | **Recovery, verification, and post-processing** |

This is 3,622 lines of code managing the complexity of a 15-rule dispatch table across 13 unit types. Much of this machinery exists because the pipeline has so many sessions that failures, timeouts, and stuck states are statistically likely.

### The Ceremony Sessions

Six of the 13 unit types produce no code. They exist purely to manage the pipeline:

| Unit Type | What It Does | Sessions per Milestone (quality, 4-slice) |
|-----------|-------------|----------------------|
| research-milestone | Reads codebase, writes RESEARCH.md | 1 |
| research-slice | Reads codebase for slice scope, writes slice RESEARCH.md | 3 (skipped for S01) |
| complete-slice | Re-reads ROADMAP + plan + all task summaries, writes slice SUMMARY.md + UAT.md | 4 |
| reassess-roadmap | Re-reads ROADMAP + slice summary, almost always says "roadmap is fine" | 3 (skipped after last slice) |
| validate-milestone | Re-reads ROADMAP + all slice summaries, writes VALIDATION.md | 1 |
| complete-milestone | Re-reads ROADMAP + all slice summaries, writes SUMMARY.md | 1 |

Total: 1 + 3 + 4 + 3 + 1 + 1 = **13 ceremony sessions** (under quality profile), each consuming 12–37K tokens of prompt context. Under the balanced profile this drops to 9 (no slice research). These sessions burn tokens re-reading documents that other sessions already produced, producing intermediate artifacts that downstream sessions then re-read.

### Root Cause

The pipeline was designed around a paradigm where:
1. LLM context windows are small (32K–100K tokens)
2. Sessions are expensive, so specialize each one
3. Handoffs between specialized agents produce better results than generalist sessions
4. Research → plan → execute is the "correct" decomposition of intellectual work

With 200K+ token context windows and prompt caching, assumptions 1-2 are obsolete. Assumption 3 is demonstrably false — handoffs lose fidelity. Assumption 4 confuses human workflow patterns with LLM-optimal patterns. An LLM with tool access is already researching while it plans. Forcing it to serialize research into a document, then read that document in a new session, is an artificial bottleneck.

## Decision

**Collapse the pipeline from 13 unit types to 5. Merge research into planning. Fold completion into post-unit mechanical processing. Replace LLM-driven validation with mechanical verification aggregation.**

### The Simplified Pipeline

```
plan-milestone → (plan-slice → execute-task × M) × N → done
```

Note: `discuss` is an interactive human-facing session, not an auto-mode unit — it's not counted in session math. It continues to work as-is.

For the same 4-slice, 3-task milestone:
- 1 plan-milestone (S01 plan + task plans produced inline via single-slice fast path if applicable)
- S01: plan-slice skipped (milestone planner already explored) + 3 execute-task = 3
- S02–S04: plan-slice + 3 execute-task = 4 each × 3 slices = 12

**Total: 1 + 3 + 12 = 16 sessions** (down from 30). The 14 eliminated sessions were the highest-waste ones — each re-ingested context for minimal value.

### Unit Type Changes

#### 1. Merge research-milestone INTO plan-milestone

**Current:** Two sessions. Researcher explores codebase, writes RESEARCH.md. Planner reads RESEARCH.md, writes ROADMAP.

**New:** One session. The plan-milestone agent explores the codebase directly and produces the ROADMAP. It has full tool access — it can read files, run commands, search code. The "research" happens naturally as part of planning, not as a serialized intermediary.

**What changes:**
- The plan-milestone prompt gains the research-milestone's exploration instructions: "Explore relevant code, check technologies, identify constraints."
- The plan-milestone prompt drops "Trust the research" — there is no research document to trust.
- The RESEARCH.md artifact becomes optional. If the planner wants to capture notes for downstream reference, it can write one. But it's not required, and downstream units don't depend on it.
- Skill discovery instructions move into the plan-milestone prompt.
- The research-milestone template (`prompts/research-milestone.md`) is retained but only used when explicitly dispatched via `/gsd dispatch research`.

**Token savings:** ~1 full session (12–37K tokens of prompt context) + the RESEARCH.md document no longer re-inlined into plan-milestone (~5–15K tokens).

**Quality impact:** Positive. The planner has direct access to the codebase instead of reading a lossy summary. It can verify assumptions in real time instead of trusting a prior session's interpretation.

#### 2. Merge research-slice INTO plan-slice

**Current:** Two sessions per non-S01 slice. Slice researcher explores codebase for slice scope, writes slice RESEARCH.md. Slice planner reads that research, writes PLAN.md + task plans.

**New:** One session. The plan-slice agent explores the relevant code directly and produces the slice plan with task plans.

**What changes:**
- The plan-slice prompt gains exploration instructions: "Read the relevant code for this slice's scope before decomposing."
- The plan-slice prompt drops "Trust the research" — there is no slice research document.
- Slice RESEARCH.md becomes optional (same as milestone research above).
- The research-slice template is retained for explicit dispatch.
- The `skip_slice_research` preference becomes the default behavior rather than an opt-in.
- The dispatch rule "planning (no research, not S01) → research-slice" is removed.

**Token savings:** ~1 session per non-S01 slice × (N-1) slices. For a 4-slice milestone: 3 sessions × 12–37K tokens = 36–111K tokens.

**Quality impact:** Positive. The planner can read actual code files instead of a summary. It verifies file paths, function signatures, and patterns directly rather than trusting a researcher's notes.

#### 3. Fold complete-slice INTO mechanical post-unit processing

**Current:** After all tasks in a slice complete, `deriveState()` emits the `summarizing` phase, dispatching a separate complete-slice LLM session that re-reads the ROADMAP, slice plan, and ALL task summaries to write a slice SUMMARY.md and UAT.md.

**New:** Slice completion moves to a **post-gate mechanical closeout** in `auto-post-unit.ts`, not into the final executor's prompt. After the last execute-task's verification gate passes:

1. The post-unit processing detects that all tasks in the slice are done (same check `deriveState()` uses to emit `summarizing`).
2. It runs mechanical slice completion: aggregate task summaries into a SUMMARY.md using structured frontmatter, generate a UAT.md from the slice plan's verification section, mark the slice done in the ROADMAP.
3. If the mechanical summary is insufficient (complex slices where structured aggregation loses important narrative), the system detects low quality (e.g., summary is below a character threshold) and dispatches a standalone complete-slice LLM session as recovery.

**Why post-gate, not in the executor prompt:**
- Codex audit identified that folding completion into execute-task creates a verification-retry ordering problem: if the executor writes SUMMARY.md and marks the slice done in the ROADMAP before the verification gate runs, a gate failure would retry against incorrect derived state (the slice appears complete when it isn't).
- Post-gate processing runs after verification succeeds, so state transitions are always consistent.
- The executor's context budget is fully available for its actual work.

**What changes in `deriveState()`:**
- The `summarizing` phase still exists in state derivation (all tasks done, slice not marked complete).
- The dispatch table no longer maps `summarizing → complete-slice`. Instead, post-unit processing handles the transition synchronously.
- If post-unit mechanical completion fails or produces low-quality output, the `summarizing` phase still exists as a dispatch target and the system falls back to dispatching a complete-slice LLM session.

**What changes:**
- `auto-post-unit.ts` gains a `mechanicalSliceCompletion()` function.
- The complete-slice dispatch rule is removed from the default path but retained as a fallback.
- The complete-slice template is retained for recovery and explicit dispatch.
- The `summarizing` phase in `state.ts` is unchanged — it serves as the fallback trigger if mechanical completion doesn't run.

**Full completion contract preserved:** The mechanical completion writes all three required artifacts (SUMMARY.md, UAT.md, ROADMAP checkbox) — matching the current complete-slice contract. It also handles REQUIREMENTS.md updates and KNOWLEDGE.md/DECISIONS.md appendix that the current complete-slice prompt performs (see Risk 5 below for details).

**Token savings:** ~1 session per slice × N slices. For a 4-slice milestone: 4 sessions × 12–37K tokens = 48–148K tokens.

**Quality impact:** For most slices, the mechanical summary is sufficient — it aggregates structured frontmatter fields (provides, requires, affects, key_files, key_decisions, patterns_established) from task summaries. For complex slices with important narrative context, the LLM fallback preserves quality.

#### 4. Eliminate reassess-roadmap (make opt-in) — **IMPLEMENTED (#4778)**

**Current:** After every slice completion, a reassess-roadmap session re-reads the ROADMAP and slice summary, then almost always writes "roadmap is fine."

**New:** Reassessment is eliminated by default. The plan-slice agent for the next slice serves as the natural reassessment point — it reads the ROADMAP and prior slice summaries, and can adjust its plan if the ground has shifted.

**What changes:**
- The reassess-roadmap dispatch rule fires only when the `reassess_after_slice` preference is enabled (default: off, was effectively always-on). **Landed:** `auto-dispatch.ts` now defaults `reassess_after_slice` to `false`. Opt-in via explicit `true` or the `burn-max` profile.
- The plan-slice prompt gains a reassessment preamble: "Before planning this slice, verify that the roadmap's assumptions still hold given prior slice summaries. If the remaining roadmap needs adjustment, modify it before proceeding." **Landed:** `prompts/plan-slice.md` `### Verify Roadmap Assumptions (JIT Reassessment — ADR-003 §4)` with explicit `gsd_reassess_roadmap` tool-call guidance and "bias strongly toward roadmap is fine" instruction.
- The `checkNeedsReassessment()` function in auto-prompts.ts becomes a preference gate, not a mandatory check. **Landed:** gated by `reassess_after_slice` (default false) in the dispatch rule; function signature unchanged.

**Token savings:** ~1 session per completed non-final slice × (N-1) slices minus those already skipped. For a 4-slice milestone under quality profile: 3 sessions × 12–37K tokens = 36–111K tokens.

**Quality impact:** Neutral. The reassess prompt says *"Bias strongly toward 'roadmap is fine.'"* — acknowledging that most reassessments produce no change. JIT reassessment during the next plan-slice is more informed (has the next slice's context) and costs zero additional tokens.

#### 5. Replace validate-milestone with mechanical verification

**Current:** An LLM session re-reads the ROADMAP and all slice summaries, checks success criteria against delivery evidence, and writes a VALIDATION.md with a verdict. It also inlines UAT-RESULT artifacts from slices with `uat_dispatch` enabled.

**New:** The system mechanically aggregates verification results from all tasks and slices. The canonical verification data sources are:

1. **`T##-VERIFY.json`** files (written by `writeVerificationJSON()` in `verification-evidence.ts`) — machine-readable per-task verification results with command, exit code, verdict, duration, and blocking status.
2. **`S##-UAT-RESULT.md`** files (when `uat_dispatch` is enabled) — human or artifact-driven UAT outcomes.
3. **Task summary frontmatter** `verification_result` field — a human-readable pass/fail string (not structured, used as a secondary signal).

The aggregator reads `T##-VERIFY.json` as the primary source of truth, supplements with UAT-RESULT artifacts, and produces a deterministic VALIDATION.md.

**What changes:**
- A new `aggregateMilestoneVerification()` function collects `T##-VERIFY.json` files and `S##-UAT-RESULT.md` files across all slices.
- The function produces a VALIDATION.md with per-task and per-slice pass/fail status, UAT evidence, and an overall verdict.
- The LLM-driven validate-milestone session is removed from the default pipeline.
- The validate-milestone template is retained for explicit dispatch (users who want LLM-driven validation can run `/gsd dispatch validate`).
- The `skip_milestone_validation` preference (which writes a pass-through VALIDATION.md) becomes the default behavior, with the mechanical aggregation replacing it.

```typescript
async function aggregateMilestoneVerification(base: string, mid: string): Promise<ValidationResult> {
  const roadmap = parseRoadmap(await loadFile(resolveMilestoneFile(base, mid, "ROADMAP")));
  const checks: EvidenceCheckJSON[] = [];
  const uatResults: { sliceId: string; content: string }[] = [];

  for (const slice of roadmap.slices) {
    // Primary source: T##-VERIFY.json files (machine-readable, written by verification-gate.ts)
    const tDir = resolveTasksDir(base, mid, slice.id);
    if (tDir) {
      const verifyFiles = resolveTaskFiles(tDir, "VERIFY");
      for (const file of verifyFiles) {
        const content = await loadFile(join(tDir, file));
        if (content) {
          const evidence: EvidenceJSON = JSON.parse(content);
          checks.push(...evidence.checks);
        }
      }
    }

    // Secondary source: S##-UAT-RESULT.md (when uat_dispatch enabled)
    const uatResultFile = resolveSliceFile(base, mid, slice.id, "UAT-RESULT");
    if (uatResultFile) {
      const uatContent = await loadFile(uatResultFile);
      if (uatContent) uatResults.push({ sliceId: slice.id, content: uatContent });
    }
  }

  const allChecksPassed = checks.every(c => c.verdict === "pass");
  const hasUatFailures = uatResults.some(r => r.content.includes("❌") || r.content.includes("FAIL"));
  const verdict = allChecksPassed && !hasUatFailures ? "pass" : "needs-attention";

  return { verdict, checks, uatResults };
}
```

**Token savings:** 1 session × 12–37K tokens. This session is one of the most context-heavy — it inlines the ROADMAP + all slice summaries + all UAT results.

**Quality impact:** Positive. Mechanical verification is deterministic and complete. LLM validation is subjective and can miss things. The verification gate and UAT system already do the hard work — the validate session was a redundant re-check. The `T##-VERIFY.json` artifacts are the canonical machine-readable source, not task summary frontmatter.

#### 6. Replace complete-milestone with mechanical completion

**Current:** An LLM session re-reads the ROADMAP and all slice summaries to write a SUMMARY.md.

**New:** The system produces a milestone summary mechanically by aggregating slice summaries. The summary includes: milestone title, success criteria with pass/fail status, slice completion dates, key decisions made, and patterns established (all extracted from structured frontmatter in slice summaries).

**What changes:**
- A new `generateMilestoneSummary()` function reads all slice SUMMARY.md files, extracts frontmatter fields, and produces a structured milestone SUMMARY.md.
- The complete-milestone dispatch rule is replaced with a synchronous post-processing step after the validation artifact is written.
- The complete-milestone template is retained for explicit dispatch.

**What changes in `deriveState()`:**
- The `validating-milestone` and `completing-milestone` phases still exist in state derivation.
- When mechanical validation + completion runs synchronously in post-unit processing, these phases are transient — `deriveState()` emits them, but the mechanical processing writes the VALIDATION.md and SUMMARY.md artifacts before the next dispatch cycle, so the phases resolve immediately.
- If mechanical processing fails, the phases remain as dispatch targets and the system falls back to dispatching LLM sessions for validation and/or completion.

**Token savings:** 1 session × 12–37K tokens.

**Quality impact:** Neutral. Milestone summaries are archival — they capture what happened, not make decisions. Mechanical aggregation of structured frontmatter is more reliable than an LLM re-interpreting task summaries.

### Dispatch Table Changes

**Current: 15 rules.**

```
1. rewrite-docs (override gate)
2. summarizing → complete-slice
3. run-uat (post-completion)
4. reassess-roadmap (post-completion)
5. needs-discussion → stop
6. pre-planning (no context) → stop
7. pre-planning (no research) → research-milestone
8. pre-planning (has research) → plan-milestone
9. planning (no research, not S01) → research-slice
10. planning → plan-slice
11. replanning-slice → replan-slice
12. executing → execute-task (recovery)
13. executing → execute-task
14. validating-milestone → validate-milestone
15. completing-milestone → complete-milestone
```

**New: 11 rules.**

```
1. rewrite-docs (override gate)                           [unchanged]
2. summarizing → complete-slice                           [FALLBACK ONLY — fires when mechanical completion didn't run]
3. run-uat (post-completion)                              [unchanged, preference-gated]
4. needs-discussion → stop                                [unchanged]
5. pre-planning (no context) → stop                       [unchanged]
6. pre-planning → plan-milestone                          [rules 7+8 merged — research folded in]
7. planning → plan-slice                                  [rules 9+10 merged — research folded in]
8. replanning-slice → replan-slice                        [unchanged]
9. executing → execute-task (recovery)                    [unchanged]
10. executing → execute-task                              [unchanged]
11. validating-milestone → validate-milestone             [FALLBACK ONLY — fires when mechanical validation didn't run]
12. completing-milestone → complete-milestone              [FALLBACK ONLY — fires when mechanical completion didn't run]
```

Note: Rules 2, 11, and 12 are retained as **fallbacks** for cases where mechanical processing fails. They do not fire in the normal path because post-unit processing writes the required artifacts before the next dispatch cycle. This means `deriveState()` is unchanged — it still emits `summarizing`, `validating-milestone`, and `completing-milestone` phases. The change is that these phases are normally resolved mechanically before dispatch evaluates them.

**Removed rules (no longer in default path):**
- `reassess-roadmap` — folded into next plan-slice (or opt-in preference)
- `pre-planning (no research) → research-milestone` — merged into plan-milestone
- `planning (no research, not S01) → research-slice` — merged into plan-slice

### Prompt Changes

#### plan-milestone.md — gains exploration instructions

Add before the planning steps:

```markdown
## Explore First, Then Decompose

You have full tool access. Before decomposing into slices:
1. Explore the relevant codebase — read key files, understand existing patterns, identify constraints.
2. For unfamiliar libraries, use `resolve_library` / `get_library_docs`.
3. Skill Discovery ({{skillDiscoveryMode}}):{{skillDiscoveryInstructions}}

Narrate key findings as you go. If findings are significant enough to benefit downstream slice planners, write {{researchOutputPath}} — but only if the content would genuinely help. Don't write a research doc just because the template exists.
```

#### plan-slice.md — gains exploration + reassessment preamble

Add before the planning steps:

```markdown
## Verify Roadmap Assumptions

Before planning this slice, check whether the roadmap's assumptions still hold:
- Review prior slice summaries (inlined above). Did anything change that affects this slice?
- If the remaining roadmap needs adjustment, modify the unchecked slices in {{roadmapPath}} before proceeding.

## Explore Slice Scope

Read the relevant code for this slice before decomposing:
1. Check the files and modules this slice will touch.
2. Verify the approach described in the roadmap against the actual codebase state.
3. If the roadmap's description of this slice is wrong or outdated, adjust your plan accordingly.
```

### Context Inlining Changes

#### Reduce inlining for planning sessions — provide paths for stable documents

Planning sessions (plan-milestone, plan-slice) currently inline ROADMAP, DECISIONS, REQUIREMENTS, KNOWLEDGE, and PROJECT. Since these sessions now also explore the codebase (merged research), the total prompt size grows. To offset this, stable documents should be provided as file paths rather than inlined content for planning sessions.

**Current pattern:**
```typescript
inlined.push(await inlineFile(roadmapPath, roadmapRel, "Milestone Roadmap"));
```

**New pattern for plan-milestone/plan-slice:**
```typescript
sourcePaths.push(`- Milestone Roadmap: \`${roadmapRel}\` — read this for the full slice decomposition`);
```

The prompt header changes from "All relevant context has been preloaded below" to "Source files are listed below. Read them before proceeding."

**What stays inlined:**
- **Task plan** in execute-task (it's the executor's authoritative contract — must be in prompt)
- **Slice plan excerpt** in execute-task (goal/demo/verification — small and task-specific)
- **Prior task summaries** in execute-task (carry-forward context — already budget-managed)
- **Milestone context** in plan-milestone (it's the starting input — relatively small)

**What moves to file-path references:**
- ROADMAP in plan-slice, complete-slice, reassess, validate, complete-milestone
- DECISIONS.md everywhere except execute-task (where it's already omitted for minimal inline level)
- REQUIREMENTS.md everywhere except execute-task
- KNOWLEDGE.md everywhere (already uses `inlineFileSmart` for execute-task)
- PROJECT.md everywhere

**Interaction with budget engine:** The current budget engine (`context-budget.ts`) truncates inlined content when it exceeds budget. Removing inlining means the LLM reads the full file via tool call. For most documents (ROADMAP ~3-10K chars, DECISIONS ~2-5K chars), the full read is within budget. For very large REQUIREMENTS.md files (>30K chars), the LLM may need to use the DB-scoped query (`inlineRequirementsFromDb` with slice scoping) or the compact formatter. The path reference should note: "For large files, use scoped queries."

**Risk: LLMs might not read referenced files.**

This is the most significant behavioral risk in this ADR. Inlined content forces processing. Path references require the LLM to decide to read. Mitigation:

1. **Mandatory read directives.** The prompt says "You MUST read the following files before proceeding" with a numbered list of 2-3 critical files. Not "read as needed" — a direct instruction.
2. **Verification.** The plan-slice prompt requires citing the ROADMAP's slice description in its output (slice title, risk level, depends). If these don't match, the planner didn't read it.
3. **Phased rollout.** Phase 4 (context reduction) is separate from Phase 1 (research merge). This allows measuring whether path references degrade plan quality before full rollout.
4. **Fallback.** If path references prove unreliable, restore inlining for critical documents only (ROADMAP in plan-slice). The budget engine still handles truncation.

**Token savings (Phase 4 only):** Eliminates ~150K tokens of re-ingestion per milestone (revised from 208K — the execute-task sessions retain inlined content). The LLM reads files as needed via tool calls, cached by API prompt caching. Net savings are ~50-60% of the re-ingestion overhead, since the LLM still reads most files once per session.

### Post-Unit Processing Changes

#### Mechanical slice completion

After the last execute-task's verification gate passes and post-unit processing detects all tasks done:

```typescript
async function mechanicalSliceCompletion(base: string, mid: string, sid: string): Promise<boolean> {
  const tDir = resolveTasksDir(base, mid, sid);
  if (!tDir) return false;

  const summaryFiles = resolveTaskFiles(tDir, "SUMMARY").sort();
  const taskSummaries = await Promise.all(
    summaryFiles.map(async f => ({ file: f, summary: parseSummary(await loadFile(join(tDir, f)) ?? "") }))
  );

  // Aggregate structured frontmatter
  const allProvides = taskSummaries.flatMap(t => t.summary.frontmatter.provides);
  const allKeyFiles = taskSummaries.flatMap(t => t.summary.frontmatter.key_files);
  const allDecisions = taskSummaries.flatMap(t => t.summary.frontmatter.key_decisions);
  const allPatterns = taskSummaries.flatMap(t => t.summary.frontmatter.patterns_established);
  const allAffects = taskSummaries.flatMap(t => t.summary.frontmatter.affects);

  // Build slice SUMMARY.md from aggregated frontmatter
  const sliceSummary = formatSliceSummary({ sid, provides: allProvides, keyFiles: allKeyFiles, ... });

  // Build UAT.md from slice plan's Verification section
  const slicePlanContent = await loadFile(resolveSliceFile(base, mid, sid, "PLAN"));
  const verificationSection = extractMarkdownSection(slicePlanContent, "Verification");
  const sliceUat = formatSliceUat(sid, verificationSection);

  // Write all three artifacts atomically
  writeFileSync(sliceSummaryPath, sliceSummary);
  writeFileSync(sliceUatPath, sliceUat);
  markSliceDoneInRoadmap(base, mid, sid);

  // Handle REQUIREMENTS.md updates (currently done by complete-slice prompt step 5)
  // Mechanical: mark requirements as Validated if all tasks covering them passed verification.
  await mechanicalRequirementsUpdate(base, mid, sid, taskSummaries);

  // Handle DECISIONS.md appendix (currently done by complete-slice prompt step 8)
  // Mechanical: collect key_decisions from task summaries not already in DECISIONS.md
  await appendNewDecisions(base, taskSummaries);

  // Handle KNOWLEDGE.md appendix (currently done by complete-slice prompt step 9)
  // Not mechanical — skip. Knowledge entries require judgment about what's genuinely useful.
  // The executor tasks already write KNOWLEDGE.md entries during execution (step 13 in execute-task).

  return true;
}
```

**Fallback:** If `mechanicalSliceCompletion()` fails or produces output below a quality threshold (e.g., summary under 200 chars for a multi-task slice), the `summarizing` phase persists in `deriveState()` and the dispatch table's retained fallback rule dispatches a complete-slice LLM session.

#### Mechanical milestone validation

See `aggregateMilestoneVerification()` above (Section 5). Reads `T##-VERIFY.json` and `S##-UAT-RESULT.md` as canonical sources.

#### Mechanical milestone summary

```typescript
async function generateMilestoneSummary(base: string, mid: string): Promise<string> {
  const roadmap = parseRoadmap(await loadFile(resolveMilestoneFile(base, mid, "ROADMAP")));
  const sliceSummaries = [];

  for (const slice of roadmap.slices) {
    const content = await loadFile(resolveSliceFile(base, mid, slice.id, "SUMMARY"));
    if (content) sliceSummaries.push({ id: slice.id, summary: parseSummary(content) });
  }

  // Aggregate frontmatter fields across all slice summaries
  // Produce structured markdown from the aggregation
  return formatMilestoneSummary(roadmap, sliceSummaries);
}
```

## Consequences

### Session Count Reduction

Counts assume no fallback sessions fire (mechanical processing succeeds). "Current" uses quality profile. "New" is the simplified pipeline.

| Milestone Shape | Current Sessions (quality) | New Sessions | Reduction |
|----------------|---------------------------|--------------|-----------|
| 1 slice, 2 tasks | 9 | 3 | 67% |
| 2 slices, 3 tasks | 17 | 8 | 53% |
| 4 slices, 3 tasks | 30 | 16 | 47% |
| 6 slices, 4 tasks | 46 | 31 | 33% |

**Derivation (4-slice, 3-task):**

Current (quality): research-milestone(1) + plan-milestone(1) + [research-slice(0) + plan-slice(1) + execute(3) + complete-slice(1) + reassess(1)] for S01 + [research-slice(1) + plan-slice(1) + execute(3) + complete-slice(1) + reassess(1)] × 2 for S02-S03 + [research-slice(1) + plan-slice(1) + execute(3) + complete-slice(1) + reassess(0)] for S04 + validate(1) + complete-milestone(1) = 2 + 6 + 14 + 6 + 2 = 30.

New: plan-milestone(1) + [execute(3)] for S01 + [plan-slice(1) + execute(3)] × 3 for S02-S04 = 1 + 3 + 12 = 16.

### Token Savings

Eliminated sessions are the primary savings mechanism. Context re-ingestion reduction is a secondary effect of having fewer sessions (each of the remaining sessions still ingests some context). These are NOT additive — the re-ingestion savings are already captured in the eliminated session savings.

| Source | Per Milestone (4-slice, 3-task) |
|--------|-------------------------------|
| Eliminated research sessions (1 milestone + 3 slice) | 48–148K tokens |
| Eliminated complete-slice sessions (4) | 48–148K tokens |
| Eliminated reassess sessions (3) | 36–111K tokens |
| Eliminated validate session (1) | 12–37K tokens |
| Eliminated complete-milestone session (1) | 12–37K tokens |
| **Total estimated savings** | **~156–481K tokens** |

At current Opus pricing ($15/MTok input, $75/MTok output — as of March 2026), the input savings alone are **$2.34–$7.22 per milestone**. Output savings are harder to estimate but typically 30-50% of input.

### Code Deletion

| File / Section | Lines | Impact |
|----------------|-------|--------|
| `auto-dispatch.ts` — 3 removed default-path rules | ~40 | Simpler dispatch table |
| `auto-prompts.ts` — 5 builders become fallback-only | ~250 | `buildResearchMilestonePrompt`, `buildResearchSlicePrompt`, `buildCompleteSlicePrompt`, `buildValidateMilestonePrompt`, `buildCompleteMilestonePrompt` move to explicit-dispatch codepath |
| `auto-prompts.ts` — reduced inlining (Phase 4) | ~100 | Remove `inlineFile` calls for static docs in planning prompts, replace with path references |
| Context re-ingestion helpers (Phase 4) | ~50 | `inlineDecisionsFromDb`, `inlineRequirementsFromDb`, `inlineProjectFromDb` simplified for planning paths |
| **Total deletable** | **~440** | |

### Code Added

| File / Section | Lines | Impact |
|----------------|-------|--------|
| `auto-prompts.ts` — plan-milestone exploration | ~30 | Research instructions merged in |
| `auto-prompts.ts` — plan-slice reassessment + exploration | ~25 | Reassessment + exploration preamble |
| `auto-post-unit.ts` — `mechanicalSliceCompletion()` | ~80 | Structured frontmatter aggregation, UAT generation, artifact writes |
| `auto-verification.ts` — `aggregateMilestoneVerification()` | ~60 | T##-VERIFY.json + UAT-RESULT aggregation |
| `auto-unit-closeout.ts` — `generateMilestoneSummary()` | ~60 | Mechanical summary generation |
| **Total added** | **~255** | |

### Net Impact

- **~185 lines net deleted** (440 deleted - 255 added)
- **3 fewer default-path dispatch rules** (15 → 12, with 3 retained as fallbacks)
- **6 fewer unit types in the default pipeline** (13 → 7 active; 6 retained for fallback/explicit dispatch)
- **~156–481K fewer tokens per milestone**
- **14 fewer session handoffs per 4-slice milestone under quality profile** (each a potential failure/timeout point)
- `auto-prompts.ts` goes from ~1,099 lines to ~924 lines (~175 lines net reduction)

### What Stays Unchanged

- The **discuss** flow (guided-flow.ts, interactive discussion)
- The **dispatch table architecture** (declarative rules, first-match-wins)
- The **fresh session per unit** pattern (still used for plan-slice and execute-task)
- The **state derivation** (`deriveState()` reads files, derives phase — all existing phases preserved)
- The **verification gate** (runs tests/lint after each task)
- The **worktree isolation** model
- The **crash recovery**, **idempotency**, and **stuck detection** systems (fewer sessions means these fire less often, but the safety nets remain)
- The **metrics** and **cost tracking** systems
- The **parallel orchestrator** for independent milestones
- All prompt templates are **retained** — for fallback, recovery, and explicit dispatch via `/gsd dispatch <unit-type>`

### What Gets Simpler Downstream

Less machinery is needed when sessions are fewer:

- **Fewer recovery paths.** 14 fewer sessions means 14 fewer opportunities for timeouts, stuck states, and missing artifacts.
- **Simpler `auto-post-unit.ts`.** Reassess dispatch logic removed (opt-in only). Mechanical completion/validation added but replaces more complex LLM-session dispatch.
- **Simpler `auto-stuck-detection.ts`.** Fewer unit types means fewer dispatch-loop patterns to detect.
- **Simpler `auto-idempotency.ts`.** Fewer completed-key types to track.

These simplifications are downstream effects — they don't need to happen in the same change. But they represent ~500-1000 lines of code that becomes significantly simpler or unnecessary as a consequence of this ADR.

## Risks

### 1. Plan-milestone sessions become heavier

Merging research into planning makes plan-milestone sessions longer. The planner must explore the codebase AND decompose into slices in a single session. Risk: the session hits context pressure before finishing.

**Mitigation:** Plan-milestone is the session that benefits most from a large context window. Modern context windows (200K+ tokens) easily accommodate exploration + planning. The single-slice fast path (already in plan-milestone.md) already combines planning with slice plan + task plan writing in one session — this extends that pattern. Phase 4 (reducing inlining for planning sessions) further offsets the added exploration work.

**Phase ordering note:** Phase 1 (merge research into planning) adds exploration to plan-milestone. If Phase 4 (reduce inlining) hasn't landed yet, the plan-milestone prompt includes both exploration instructions AND the full inlined context. This is the most context-heavy state. To mitigate, Phase 1 should also reduce inlining for plan-milestone/plan-slice specifically — moving DECISIONS, REQUIREMENTS, and PROJECT to path references while keeping ROADMAP and CONTEXT inlined. This is a targeted subset of Phase 4, not a separate phase.

### 2. Mechanical completion quality

The mechanical slice completion aggregates structured frontmatter but cannot produce narrative context, forward intelligence sections, or nuanced UAT scenarios that the current LLM-driven complete-slice session produces.

**Mitigation:**
- For most slices (2-3 tasks, straightforward work), structured aggregation is sufficient. The frontmatter fields (provides, requires, affects, key_files, key_decisions, patterns_established) capture the essential information.
- The quality threshold fallback dispatches a complete-slice LLM session for complex slices.
- The LLM fallback is zero-cost to implement — the complete-slice template and dispatch rule are retained.

### 3. Loss of research artifacts

RESEARCH.md files provided a useful paper trail for debugging plan quality. Without them, it's harder to understand why a planner made certain decisions.

**Mitigation:**
- The planner's narration (visible in the conversation transcript) captures exploration reasoning.
- RESEARCH.md is optional, not eliminated. Planners can write one when exploration is complex.
- The KNOWLEDGE.md file captures non-obvious patterns and decisions.
- DECISIONS.md captures structural choices.

### 4. Reassessment gaps

Without mandatory reassessment, a slice might complete with findings that invalidate the remaining roadmap, and the next planner might not notice.

**Mitigation:**
- The plan-slice prompt includes a reassessment preamble that explicitly checks prior slice summaries.
- The `blocker_discovered` flag in task summaries already triggers automatic replanning.
- Users who want explicit reassessment can enable the `reassess_after_slice` preference.

### 5. Mechanical completion doesn't cover all complete-slice responsibilities

The current complete-slice prompt (steps 5, 8, 9) updates REQUIREMENTS.md, appends to DECISIONS.md, and appends to KNOWLEDGE.md. The mechanical completion handles REQUIREMENTS.md and DECISIONS.md mechanically but cannot produce KNOWLEDGE.md entries (which require judgment about what's genuinely useful).

**Mitigation:**
- Execute-task prompt step 13 already instructs executors to append to KNOWLEDGE.md during task execution. Most knowledge entries are discovered during implementation, not during completion.
- DECISIONS.md appendix is handled mechanically by collecting `key_decisions` from task summaries and deduplicating against existing entries.
- REQUIREMENTS.md updates are handled mechanically by cross-referencing task verification results against requirement-to-slice mappings.
- For the LLM fallback path (complex slices), the complete-slice prompt retains all responsibilities.

### 6. Migration path

Milestones in progress when this change deploys will have state files (RESEARCH.md, etc.) that the new pipeline doesn't produce. The dispatch table must gracefully handle both old-style and new-style state.

**Mitigation:**
- Dispatch rules check for file existence, not file absence. A milestone with an existing RESEARCH.md still works — the plan-milestone rule fires regardless of whether research exists.
- The idempotency system already handles "completed research unit → dispatch plan" transitions.
- All `deriveState()` phases are preserved — old-style state resolves correctly.
- No migration needed. The new pipeline is strictly more permissive than the old one.

## Alternatives Considered

### A. Keep research as a separate session, just make it optional

Add a `skip_research` preference (already exists) and make it default to true. This is the minimal change — one boolean flip.

**Rejected:** This saves sessions but doesn't address the context re-ingestion problem, the lossy handoff problem, or the ceremony session overhead. It's a preference toggle, not an architectural improvement.

### B. Keep all unit types but share context via a persistent cache

Instead of fresh sessions, maintain a shared context store that persists across units. Each unit reads from the store instead of re-inlining files.

**Rejected:** This requires a fundamentally different session model — either a long-running session (which hits context limits) or a cache mechanism that the LLM can query (which doesn't exist in the Claude API). The fresh-session-per-unit model is correct; the problem is what we put in each session, not the session model itself.

### C. Collapse everything into a single session per slice

One session per slice: plan + execute all tasks + complete. Maximum context efficiency.

**Rejected:** This hits real context limits for slices with 4+ tasks. Task execution is legitimately heavy — reading code, writing code, running tests, debugging failures. A single session for all of this would exhaust the context window. The plan-slice / execute-task boundary is a genuine engineering constraint, not ceremony.

### D. Fold completion into the last executor's prompt instead of post-unit processing

The original design had the last execute-task writing SUMMARY.md, UAT.md, and marking the slice done.

**Rejected (per Codex audit):** This creates a verification-retry ordering problem. If the executor writes SUMMARY.md and marks the slice done in the ROADMAP before the verification gate runs, a gate failure retries against incorrect derived state. Post-gate mechanical processing avoids this by running only after verification succeeds.

### E. Keep complete-slice as a separate session

The mechanical summary quality might be insufficient for complex slices.

**Addressed:** The mechanical approach with LLM fallback provides the best of both worlds. Simple slices get fast mechanical completion. Complex slices fall back to the existing LLM session. The quality threshold is tunable.

## Action Items

### Phase 1: Merge research into planning (+ targeted inlining reduction)
1. Update `buildPlanMilestonePrompt()` — add exploration instructions, skill discovery, drop "Trust the research"
2. Update `buildPlanSlicePrompt()` — add exploration instructions, reassessment preamble, drop "Trust the research"
3. Remove dispatch rule "pre-planning (no research) → research-milestone" — merge with "pre-planning (has research) → plan-milestone" into single "pre-planning → plan-milestone"
4. Remove dispatch rule "planning (no research, not S01) → research-slice"
5. Update `plan-milestone.md` and `plan-slice.md` prompt templates
6. Make `skip_research` and `skip_slice_research` preferences default to true (backwards compat)
7. Retain research templates for explicit `/gsd dispatch research` use
8. **Targeted inlining reduction for planning sessions:** Move DECISIONS, REQUIREMENTS, PROJECT to path references in plan-milestone and plan-slice prompts. Keep ROADMAP and CONTEXT inlined. This prevents context pressure from the added exploration work.

### Phase 2: Mechanical slice completion
9. Implement `mechanicalSliceCompletion()` in `auto-post-unit.ts`
10. Wire into post-unit processing: detect all-tasks-done after verification gate passes, run mechanical completion
11. Implement quality threshold check (summary length, artifact presence)
12. Retain `summarizing → complete-slice` dispatch rule as fallback for mechanical failures
13. Implement `mechanicalRequirementsUpdate()` and `appendNewDecisions()`

### Phase 3: Mechanical milestone validation + completion
14. Implement `aggregateMilestoneVerification()` reading `T##-VERIFY.json` and `S##-UAT-RESULT.md`
15. Implement `generateMilestoneSummary()` from slice summary aggregation
16. Wire into post-unit processing: after last slice completion, run mechanical validation + summary
17. Make reassess-roadmap opt-in via `reassess_after_slice` preference (default: false)
18. Retain `validating-milestone` and `completing-milestone` dispatch rules as fallbacks

### Phase 4: Full context re-ingestion reduction
19. Replace remaining `inlineFile()` calls for stable documents with mandatory-read path references
20. Update prompt headers with explicit "You MUST read" directives for critical files
21. Add plan output verification (must cite ROADMAP slice description)
22. Measure plan quality metrics before/after to validate the change

### Phase 5: Downstream simplification (optional, deferred)
23. Simplify `auto-post-unit.ts` — remove reassess dispatch logic (opt-in only)
24. Simplify `auto-stuck-detection.ts` — fewer unit type patterns
25. Simplify `auto-idempotency.ts` — fewer completed-key types
26. Review `auto-recovery.ts` — simplify recovery paths for unit types that are now fallback-only
27. Update auto-mode documentation (`docs/auto-mode.md`)

## Audit Trail

### Round 1 — Three-model review (March 18, 2026)

**Claude Opus 4.6** identified 8 issues:
1. ✅ Session count math inconsistent about S01 plan-slice skip — **fixed**: explicit derivation added with per-slice breakdown
2. ✅ `discuss` session counted in pipeline but not in math — **fixed**: noted as interactive session, not auto-mode unit
3. ✅ Token savings double-counting (eliminated sessions + re-ingestion) — **fixed**: removed overlap, noted savings are not additive
4. ✅ Context inlining change (file paths vs inline) underanalyzed — **fixed**: expanded to dedicated risk section with enforcement strategy, phased rollout, and interaction with budget engine
5. ✅ Budget engine interaction not discussed — **fixed**: addressed in context inlining section
6. ✅ `aggregateMilestoneVerification()` reads wrong data source — **fixed**: now reads `T##-VERIFY.json` as primary source, supplemented by `S##-UAT-RESULT.md`
7. ✅ Phase ordering creates heavy intermediate state (Phase 1 without Phase 4) — **fixed**: Phase 1 now includes targeted inlining reduction for planning sessions
8. ✅ ADR number conflict — **fixed**: confirmed no ADR-003 exists in `docs/` (the referenced file doesn't exist in current git)

**OpenAI Codex** identified 6 issues:
1. ✅ HIGH: Folding completion into execute-task breaks verification-retry model — **fixed**: moved completion to post-gate mechanical processing instead of executor prompt. Added Alternative D explaining why.
2. ✅ HIGH: Mechanical validation reads nonexistent `verification_evidence` frontmatter — **fixed**: now reads `T##-VERIFY.json` (canonical machine-readable source from `verification-evidence.ts`)
3. ✅ HIGH: Replacement validation drops UAT evidence — **fixed**: aggregator now reads both `T##-VERIFY.json` and `S##-UAT-RESULT.md`
4. ✅ HIGH: "State derivation stays unchanged" is false — **fixed**: explicitly documented that `deriveState()` phases are preserved, mechanical processing resolves them synchronously, fallback dispatch rules handle failures
5. ✅ MEDIUM: Folded completion omits REQUIREMENTS.md and KNOWLEDGE.md updates — **fixed**: mechanical completion handles REQUIREMENTS.md and DECISIONS.md; KNOWLEDGE.md addressed in Risk 5
6. ✅ MEDIUM: Session and token math inconsistent — **fixed**: complete rederivation with per-slice breakdown, corrected to 30 baseline sessions, noted profile variations

**Gemini 2.5 Pro** audit was not usable — it hallucinated the ADR as a CI/CD pipeline document about GitHub Actions, matrix builds, and nx workspace tooling. No findings were applicable to the actual content.
