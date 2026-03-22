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
3. Verify each **success criterion** from the milestone definition in `{{roadmapPath}}`. For each criterion, confirm it was met with specific evidence from slice summaries, test results, or observable behavior. List any criterion that was NOT met.
4. Verify the milestone's **definition of done** — all slices are `[x]`, all slice summaries exist, and any cross-slice integration points work correctly.
5. Validate **requirement status transitions**. For each requirement that changed status during this milestone, confirm the transition is supported by evidence. Requirements can move between Active, Validated, Deferred, Blocked, or Out of Scope — but only with proof.
6. Write `{{milestoneSummaryPath}}` using the milestone-summary template. Fill all frontmatter fields and narrative sections. The `requirement_outcomes` field must list every requirement that changed status with `from_status`, `to_status`, and `proof`.
7. For each requirement status transition validated in step 5, call `gsd_save_decision` with scope="requirement", decision="{requirement-id}", choice="{new-status}", rationale="{evidence from validation}". Do NOT write `.gsd/REQUIREMENTS.md` directly — the engine renders it from the database.
8. Update `.gsd/PROJECT.md` to reflect milestone completion and current project state. (PROJECT.md is a content file — direct writes are acceptable here.)
9. Review all slice summaries for cross-cutting lessons, patterns, or gotchas that emerged during this milestone. Append any non-obvious, reusable insights to `.gsd/KNOWLEDGE.md`.
10. Do not commit manually — the system auto-commits your changes after this unit completes.

**Important:** Do NOT skip the success criteria and definition of done verification (steps 3-4). The milestone summary must reflect actual verified outcomes, not assumed success. If any criterion was not met, document it clearly in the summary and do not mark the milestone as passing verification.

**File system safety:** When scanning milestone directories for evidence, use `ls` or `find` to list directory contents first — never pass a directory path (e.g. `tasks/`, `slices/`) directly to the `read` tool. The `read` tool only accepts file paths, not directories.

**You MUST write `{{milestoneSummaryPath}}` AND update PROJECT.md before finishing.**

When done, say: "Milestone {{milestoneId}} complete."
