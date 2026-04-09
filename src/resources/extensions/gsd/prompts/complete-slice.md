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
6. If this slice produced evidence that a requirement changed status (Active → Validated, Active → Deferred, etc.), call `gsd_requirement_update` with the requirement ID, updated `status`, and `validation` evidence. Do NOT write `.gsd/REQUIREMENTS.md` directly — the engine renders it from the database.
7. Prepare the slice completion content you will pass to `gsd_complete_slice` using the camelCase fields `milestoneId`, `sliceId`, `sliceTitle`, `oneLiner`, `narrative`, `verification`, and `uatContent`. Do **not** manually write `{{sliceSummaryPath}}`. Do **not** manually write `{{sliceUatPath}}` — the DB-backed tool is the canonical write path for both artifacts.
8. Draft the UAT content you will pass as `uatContent` — a concrete UAT script with real test cases derived from the slice plan and task summaries. Include preconditions, numbered steps with expected outcomes, and edge cases. This must NOT be a placeholder or generic template — tailor every test case to what this slice actually built.
9. Review task summaries for `key_decisions`. Append any significant decisions to `.gsd/DECISIONS.md` if missing.
10. Review task summaries for patterns, gotchas, or non-obvious lessons learned. If any would save future agents from repeating investigation or hitting the same issues, append them to `.gsd/KNOWLEDGE.md`. Only add entries that are genuinely useful — don't pad with obvious observations.
11. Call `gsd_complete_slice` with the camelCase fields `milestoneId`, `sliceId`, `sliceTitle`, `oneLiner`, `narrative`, `verification`, and `uatContent`, plus any optional enrichment fields you have. Do NOT manually mark the roadmap checkbox — the tool writes to the DB, renders `{{sliceSummaryPath}}` and `{{sliceUatPath}}`, and updates the ROADMAP.md projection automatically.
12. Do not run git commands — the system commits your changes and handles any merge after this unit succeeds.
13. Update `.gsd/PROJECT.md` if it exists — refresh current state if needed: use the `write` tool with `path: ".gsd/PROJECT.md"` and `content` containing the full updated document reflecting current project state. Do NOT use the `edit` tool for this — PROJECT.md is a full-document refresh.

**Autonomous execution:** Do not call `ask_user_questions` or `secure_env_collect`. You are running in auto-mode — there is no human available to answer questions. Make reasonable assumptions and document them in the slice summary. If a decision genuinely requires human input, note it in the summary and proceed with the best available option.

**File system safety:** Task summaries are preloaded in the inlined context above. If you need to re-read any of them, use `find .gsd/milestones/{{milestoneId}}/slices/{{sliceId}}/tasks -name "*-SUMMARY.md"` to list file paths first — never pass `{{slicePath}}` or any other directory path directly to the `read` tool. The `read` tool only accepts file paths, not directories.

**You MUST call `gsd_complete_slice` with the slice summary and UAT content before finishing. The tool persists to both DB and disk and renders `{{sliceSummaryPath}}` and `{{sliceUatPath}}` automatically.**

When done, say: "Slice {{sliceId}} complete."
