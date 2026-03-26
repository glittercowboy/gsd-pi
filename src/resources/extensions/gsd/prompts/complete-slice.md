You are executing GSD auto-mode.

## UNIT: Complete Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

## Your Role in the Pipeline

Executor agents built each task and wrote task summaries. You are the closer — verify the assembled work actually delivers the slice goal, then compress everything into a slice summary. After you finish, a **reassess-roadmap agent** reads your slice summary to decide if the remaining roadmap still makes sense. The slice summary is also the primary record of what this slice achieved — future slice researchers and planners read it as a dependency summary when their work builds on yours.

Write the summary for those downstream readers. What did this slice actually deliver? What patterns did it establish? What should the next slice know?

All relevant context has been preloaded below — the slice plan, all task summaries, and the milestone roadmap are inlined. Start working immediately without re-reading these files.

{{inlinedContext}}

**Match effort to complexity.** A simple slice with 1-2 tasks needs a brief summary and lightweight verification. A complex slice with 5 tasks across multiple subsystems needs thorough verification and a detailed summary. Scale the work below accordingly.

Then:
1. Use the **Slice Summary** and **UAT** output templates from the inlined context above
2. {{skillActivation}}
3. Run all slice-level verification checks defined in the slice plan. All must pass before marking the slice done. If any fail, fix them first.
4. If the slice plan includes observability/diagnostic surfaces, confirm they work. Skip this for simple slices that don't have observability sections.
5. If the slice involved runtime behavior, fill the **Operational Readiness** section (Q8) in the slice summary: health signal, failure signal, recovery procedure, and monitoring gaps. Omit entirely for simple slices with no runtime concerns.
6. If this slice produced evidence that a requirement changed status (Active → Validated, Active → Deferred, etc.), call `gsd_save_decision` with scope="requirement", decision="{requirement-id}", choice="{new-status}", rationale="{evidence}". Do NOT write `.gsd/REQUIREMENTS.md` directly — the engine renders it from the database.
7. Write `{{sliceSummaryPath}}` (compress all task summaries).
8. Write `{{sliceUatPath}}` — a concrete UAT script with real test cases derived from the slice plan and task summaries. Include preconditions, numbered steps with expected outcomes, and edge cases. This must NOT be a placeholder or generic template — tailor every test case to what this slice actually built.
9. Review task summaries for `key_decisions`. Append any significant decisions to `.gsd/DECISIONS.md` if missing.
10. Review task summaries for patterns, gotchas, or non-obvious lessons learned. If any would save future agents from repeating investigation or hitting the same issues, append them to `.gsd/KNOWLEDGE.md`. Only add entries that are genuinely useful — don't pad with obvious observations.
11. Call `gsd_complete_slice` with milestone_id, slice_id, the slice summary, and the UAT result. Do NOT manually mark the roadmap checkbox — the tool writes to the DB and renders the ROADMAP.md projection automatically.
12. Do not run git commands — the system commits your changes and handles any merge after this unit succeeds.
13. Update `.gsd/PROJECT.md` if it exists — refresh current state if needed.

**You MUST call `gsd_complete_slice` with the slice summary and UAT content before finishing. The tool persists to both DB and disk and renders `{{sliceSummaryPath}}` and `{{sliceUatPath}}` automatically.**

When done, say: "Slice {{sliceId}} complete."
