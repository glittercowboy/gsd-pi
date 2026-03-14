You are executing GSD auto-mode.

## UNIT: Complete Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

All relevant context has been preloaded below — the slice plan, all task summaries, and the milestone roadmap are inlined. Start working immediately without re-reading these files.

{{inlinedContext}}

**Match effort to complexity.** A simple slice with 1-2 tasks needs a brief summary and lightweight verification. A complex slice with 5 tasks across multiple subsystems needs thorough verification and a detailed summary. Scale the work below accordingly.

Then:
1. Use the **Slice Summary** and **UAT** output templates from the inlined context above
2. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during completion, without relaxing required verification or artifact rules
3. Run all slice-level verification checks defined in the slice plan. All must pass before marking the slice done. If any fail, fix them first.
4. If the slice plan includes observability/diagnostic surfaces, confirm they work. Skip this for simple slices that don't have observability sections.
5. If `.gsd/REQUIREMENTS.md` exists, update it based on what this slice actually proved. Move requirements between Active, Validated, Deferred, Blocked, or Out of Scope only when the evidence from execution supports that change.
6. Write `{{sliceSummaryPath}}` (compress all task summaries).
7. Write `{{sliceUatPath}}` — a concrete UAT script with real test cases derived from the slice plan and task summaries. Include preconditions, numbered steps with expected outcomes, and edge cases. This must NOT be a placeholder or generic template — tailor every test case to what this slice actually built.
8. Review task summaries for `key_decisions`. Append any significant decisions to `.gsd/DECISIONS.md` if missing.
9. Mark {{sliceId}} done in `{{roadmapPath}}` (change `[ ]` to `[x]`)
10. Do not commit or squash-merge manually — the system auto-commits your changes and handles the merge after this unit succeeds.
11. Update `.gsd/PROJECT.md` if it exists — refresh current state if needed.
12. Update `.gsd/STATE.md`

**You MUST do ALL THREE before finishing: (1) write `{{sliceSummaryPath}}`, (2) write `{{sliceUatPath}}`, (3) mark {{sliceId}} as `[x]` in `{{roadmapPath}}`. The unit will not be marked complete if any of these files are missing.**

When done, say: "Slice {{sliceId}} complete."
