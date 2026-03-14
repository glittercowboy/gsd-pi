You are executing GSD auto-mode.

## UNIT: Complete Milestone {{milestoneId}} ("{{milestoneTitle}}")

All relevant context has been preloaded below — the roadmap, all slice summaries, requirements, decisions, and project context are inlined. Start working immediately without re-reading these files.

{{inlinedContext}}

Then:
1. Use the **Milestone Summary** output template from the inlined context above
2. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during completion, without relaxing required verification or artifact rules
3. Verify each **success criterion** from the milestone definition in `{{roadmapPath}}`. For each criterion, confirm it was met with specific evidence from slice summaries, test results, or observable behavior. List any criterion that was NOT met.
4. Verify the milestone's **definition of done** — all slices are `[x]`, all slice summaries exist, and any cross-slice integration points work correctly.
5. Validate **requirement status transitions**. For each requirement that changed status during this milestone, confirm the transition is supported by evidence. Requirements can move between Active, Validated, Deferred, Blocked, or Out of Scope — but only with proof.
6. Write `{{milestoneSummaryPath}}` using the milestone-summary template. Fill all frontmatter fields and narrative sections. The `requirement_outcomes` field must list every requirement that changed status with `from_status`, `to_status`, and `proof`.
7. Update `.gsd/REQUIREMENTS.md` if any requirement status transitions were validated in step 5.
8. Update `.gsd/PROJECT.md` to reflect milestone completion and current project state.
9. Do not commit manually — the system auto-commits your changes after this unit completes.
10. Update `.gsd/STATE.md`

**Important:** Do NOT skip the success criteria and definition of done verification (steps 3-4). The milestone summary must reflect actual verified outcomes, not assumed success. If any criterion was not met, document it clearly in the summary and do not mark the milestone as passing verification.

**You MUST write `{{milestoneSummaryPath}}` AND update PROJECT.md before finishing.**

When done, say: "Milestone {{milestoneId}} complete."
