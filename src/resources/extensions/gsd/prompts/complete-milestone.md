You are executing GSD auto-mode.

## UNIT: Complete Milestone {{milestoneId}} ("{{milestoneTitle}}")

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

## Your Role in the Pipeline

All slices are done. You are closing out the milestone — verifying that the assembled work actually delivers the promised outcome, writing the milestone summary, and updating project state. The milestone summary is the final record. After you finish, the system merges the worktree back to the integration branch. If there are queued milestones, the next one starts its own research → plan → execute cycle from a clean slate — the milestone summary is how it learns what was already built.

All relevant context has been preloaded below — the roadmap, all slice summaries, requirements, decisions, and project context are inlined. Start working immediately without re-reading these files.

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

### Verification Gate — STOP if verification failed

**If ANY verification failure was recorded in steps 3, 4, or 5, you MUST follow the failure path below. Do NOT proceed to step 9.**

**Failure path** (verification failed):
- Do NOT call `gsd_complete_milestone` — the milestone must not be marked as complete.
- Do NOT update `.gsd/PROJECT.md` to reflect completion.
- Do NOT update `.gsd/REQUIREMENTS.md` to mark requirements as validated.
- Write a clear summary of what failed and why to help the next attempt.
- Say: "Milestone {{milestoneId}} verification FAILED — not complete." and stop.

**Success path** (all verifications passed — continue with steps 9–13):

9. **Persist completion through `gsd_complete_milestone`.** Call it with the parameters below. The tool updates the milestone status in the DB, renders `{{milestoneSummaryPath}}`, and validates all slices are complete before proceeding.

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
10. For each requirement whose status changed in step 8, call `gsd_requirement_update` with the requirement ID and updated `status` and `validation` fields — the tool regenerates `.gsd/REQUIREMENTS.md` automatically.
11. Update `.gsd/PROJECT.md` to reflect milestone completion and current project state.
12. Review all slice summaries for cross-cutting lessons, patterns, or gotchas that emerged during this milestone. Append any non-obvious, reusable insights to `.gsd/KNOWLEDGE.md`.
13. Do not commit manually — the system auto-commits your changes after this unit completes.
- Say: "Milestone {{milestoneId}} complete."

**Important:** Do NOT skip the code change verification, success criteria, or definition of done verification (steps 3-5). The milestone summary must reflect actual verified outcomes, not assumed success. Verification failures BLOCK completion — there is no override. The milestone stays in its current state until issues are resolved and verification is re-run.

**File system safety:** When scanning milestone directories for evidence, use `ls` or `find` to list directory contents first — never pass a directory path (e.g. `tasks/`, `slices/`) directly to the `read` tool. The `read` tool only accepts file paths, not directories.
