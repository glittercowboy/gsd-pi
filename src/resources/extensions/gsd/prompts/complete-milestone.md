You are executing GSD auto-mode.

## UNIT: Complete Milestone {{milestoneId}} ("{{milestoneTitle}}")

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

## Your Role in the Pipeline

All slices are done. You are closing out the milestone — verifying that the assembled work actually delivers the promised outcome, writing the milestone summary, and updating project state. The milestone summary is the final record. After you finish, the system merges the worktree back to the integration branch. If there are queued milestones, the next one starts its own research → plan → execute cycle from a clean slate — the milestone summary is how it learns what was already built.

Preloaded context below — the roadmap, compact slice-summary excerpts, requirements, decisions, and project context. **Slice summaries are excerpts, not full files.** They include frontmatter fields, section heads (deviations, known limitations, follow-ups), and short narrative only. When drafting LEARNINGS, the Decision Re-evaluation table, or cross-slice narrative, Read the full slice SUMMARY.md files listed under "On-demand Slice Summaries" — do that selectively as needed, not preemptively.

Start with what the excerpts give you. Read full files when the section heads signal richer context you need.

**On-demand Read ordering:** Complete all slice SUMMARY Reads you need for cross-slice synthesis, the Decision Re-evaluation table, and LEARNINGS **before** calling `gsd_complete_milestone` (step 10). Once that tool runs, the milestone is marked complete in the DB — running out of tool budget between step 10 and the LEARNINGS write (step 12) leaves the milestone committed without its LEARNINGS artifact.

{{inlinedContext}}

Then:
1. Use the **Milestone Summary** output template from the inlined context above
2. {{skillActivation}}
3. **Verify code changes exist.** Run `git diff --stat HEAD $(git merge-base HEAD main) -- ':!.gsd/'` (or the equivalent for the integration branch). If no non-`.gsd/` files appear in the diff, the milestone produced only planning artifacts and no actual code. Record this as a **verification failure**.
4. Verify each **success criterion** from the milestone definition in `{{roadmapPath}}`. For each criterion, confirm it was met with specific evidence from slice summaries, test results, or observable behavior. Record any criterion that was NOT met as a **verification failure**.
5. Verify the milestone's **definition of done** — all slices are `[x]`, all slice summaries exist, and any cross-slice integration points work correctly. Record any unmet items as a **verification failure**.
6. If the roadmap includes a **Horizontal Checklist**, verify each item was addressed during the milestone. Note unchecked items in the milestone summary.
7. Fill the **Decision Re-evaluation** table in the milestone summary. For each key decision from `.gsd/DECISIONS.md` made during this milestone, evaluate whether it is still valid given what was actually built. Flag decisions that should be revisited next milestone.
8. Validate **requirement status transitions**. For each requirement that changed status during this milestone, confirm the transition is supported by evidence. Requirements can move between Active, Validated, Deferred, Blocked, or Out of Scope — but only with proof.

**DB access safety:** Do NOT query `.gsd/gsd.db` directly via `sqlite3` or `node -e require('better-sqlite3')` — the engine owns the WAL connection. Use `gsd_milestone_status` to read milestone and slice state. All data you need is already inlined in the context above or accessible via the `gsd_*` tools — never via direct SQL.

### Verification Gate — STOP if verification failed

**If ANY verification failure was recorded in steps 3, 4, or 5, you MUST follow the failure path below. Do NOT proceed to step 10.**

**Failure path** (verification failed):
- Do NOT call `gsd_complete_milestone` — the milestone must not be marked as complete.
- Do NOT update `.gsd/PROJECT.md` to reflect completion.
- Do NOT update `.gsd/REQUIREMENTS.md` to mark requirements as validated.
- Write a clear summary of what failed and why to help the next attempt.
- Say: "Milestone {{milestoneId}} verification FAILED — not complete." and stop.

**Success path** (all verifications passed — continue with steps 9–13):

9. For each requirement whose status changed in step 8, call `gsd_requirement_update` with the requirement ID and updated `status` and `validation` fields — the tool regenerates `.gsd/REQUIREMENTS.md` automatically. Do this BEFORE completing the milestone so requirement updates are persisted.
10. **Persist completion through `gsd_complete_milestone`.** Call it with the parameters below. The tool updates the milestone status in the DB, renders `{{milestoneSummaryPath}}`, and validates all slices are complete before proceeding.

   **Required parameters:**
   - `milestoneId` (string) — Milestone ID (e.g. M001)
   - `title` (string) — Milestone title
   - `oneLiner` (string) — One-sentence summary of what the milestone achieved
   - `narrative` (string) — Detailed narrative of what happened during the milestone
   - `successCriteriaResults` (string) — Markdown detailing how each success criterion was met or not met
   - `definitionOfDoneResults` (string) — Markdown detailing how each definition-of-done item was met
   - `requirementOutcomes` (string) — Markdown detailing requirement status transitions with evidence
   - `keyDecisions` (array of strings) — Key architectural/pattern decisions made during the milestone
   - `keyFiles` (array of strings) — Key files created or modified during the milestone
   - `lessonsLearned` (array of strings) — Lessons learned during the milestone
   - `verificationPassed` (boolean) — Must be `true` — confirms that code change verification, success criteria, and definition of done checks all passed before completion

   **Optional parameters:**
   - `followUps` (string) — Follow-up items for future milestones
   - `deviations` (string) — Deviations from the original plan
11. Update `.gsd/PROJECT.md`: use the `write` tool with `path: ".gsd/PROJECT.md"` and `content` containing the full updated document reflecting milestone completion and current project state. Do NOT use the `edit` tool for this — PROJECT.md is a full-document refresh.
12. Extract structured learnings from this milestone and persist them to the GSD memory store. Follow the procedure block immediately below — it writes `{{milestoneId}}-LEARNINGS.md` as the audit trail and persists Patterns, Lessons, and Decisions via `capture_thought` (categories: pattern, gotcha/convention, architecture). The memory store is the single source of truth for cross-session durable knowledge (ADR-013).

{{extractLearningsSteps}}

13. Do not commit manually — the system auto-commits your changes after this unit completes.
- Say: "Milestone {{milestoneId}} complete."

**Important:** Do NOT skip the code change verification, success criteria, or definition of done verification (steps 3-5). The milestone summary must reflect actual verified outcomes, not assumed success. Verification failures BLOCK completion — there is no override. The milestone stays in its current state until issues are resolved and verification is re-run. **If a verification tool itself fails, errors, or returns unexpected output, treat it as a verification failure** — never rationalize past a tool error ("tool didn't respond, assuming success" is forbidden). A tool that cannot verify is a tool that did not verify.

**File system safety:** When scanning milestone directories for evidence, use `ls` or `find` to list directory contents first — never pass a directory path (e.g. `tasks/`, `slices/`) directly to the `read` tool. The `read` tool only accepts file paths, not directories.
