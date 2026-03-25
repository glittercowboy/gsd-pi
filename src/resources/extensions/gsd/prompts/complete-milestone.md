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
3. **Verify code changes exist.** Run `git diff --stat HEAD $(git merge-base HEAD main) -- ':!.gsd/'` (or the equivalent for the integration branch). If no non-`.gsd/` files appear in the diff, the milestone produced only planning artifacts and no actual code. In that case, do NOT mark the milestone as passing verification — document the gap clearly in the summary and state that implementation is missing.
4. Verify each **success criterion** from the milestone definition in `{{roadmapPath}}`. For each criterion, confirm it was met with specific evidence from slice summaries, test results, or observable behavior. List any criterion that was NOT met.
5. Verify the milestone's **definition of done** — all slices are `[x]`, all slice summaries exist, and any cross-slice integration points work correctly.
6. Validate **requirement status transitions**. For each requirement that changed status during this milestone, confirm the transition is supported by evidence. Requirements can move between Active, Validated, Deferred, Blocked, or Out of Scope — but only with proof.
7. **Persist completion through `gsd_complete_milestone`.** Call it with: `milestoneId`, `title`, `oneLiner`, `narrative`, `successCriteriaResults`, `definitionOfDoneResults`, `requirementOutcomes`, `keyDecisions`, `keyFiles`, `lessonsLearned`, `followUps`, `deviations`. The tool updates the milestone status in the DB, renders MILESTONE-SUMMARY.md to disk, and validates all slices are complete before proceeding.
8. Update `.gsd/REQUIREMENTS.md` if any requirement status transitions were validated in step 6.
9. Update `.gsd/PROJECT.md` to reflect milestone completion and current project state.
10. Review all slice summaries for cross-cutting lessons, patterns, or gotchas that emerged during this milestone. Append any non-obvious, reusable insights to `.gsd/KNOWLEDGE.md`.
11. Do not commit manually — the system auto-commits your changes after this unit completes.

**Important:** Do NOT skip the code change verification, success criteria, or definition of done verification (steps 3-5). The milestone summary must reflect actual verified outcomes, not assumed success. If any criterion was not met or no code changes exist, document it clearly in the summary and do not mark the milestone as passing verification.

**File system safety:** When scanning milestone directories for evidence, use `ls` or `find` to list directory contents first — never pass a directory path (e.g. `tasks/`, `slices/`) directly to the `read` tool. The `read` tool only accepts file paths, not directories.

When done, say: "Milestone {{milestoneId}} complete."
