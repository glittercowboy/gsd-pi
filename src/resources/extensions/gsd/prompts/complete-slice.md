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
5. If `.gsd/REQUIREMENTS.md` exists, update it based on what this slice actually proved. Move requirements between Active, Validated, Deferred, Blocked, or Out of Scope only when the evidence from execution supports that change.
6. Call the `gsd_slice_complete` tool (alias: `gsd_complete_slice`) to record the slice as complete. The tool validates all tasks are complete, updates the slice status in the DB, renders the summary to `{{sliceSummaryPath}}`, UAT to `{{sliceUatPath}}`, and re-renders `{{roadmapPath}}` — all atomically. Read the summary and UAT templates at `~/.gsd/agent/extensions/gsd/templates/` to understand the expected structure, then pass the following parameters:

   **Identity:** `sliceId`, `milestoneId`, `sliceTitle`

   **Narrative:** `oneLiner` (one-line summary of what the slice accomplished), `narrative` (detailed account of what happened across all tasks), `verification` (what was verified and how), `deviations` (deviations from plan, or "None."), `knownLimitations` (gaps or limitations, or "None."), `followUps` (follow-up work discovered, or "None.")

   **Files:** `keyFiles` (array of key file paths), `filesModified` (array of `{path, description}` objects for all files changed)

   **Requirements:** `requirementsAdvanced` (array of `{id, how}`), `requirementsValidated` (array of `{id, proof}`), `requirementsInvalidated` (array of `{id, what}`), `requirementsSurfaced` (array of new requirement strings)

   **Patterns & decisions:** `keyDecisions` (array of decision strings), `patternsEstablished` (array), `observabilitySurfaces` (array)

   **Dependencies:** `provides` (what this slice provides downstream), `affects` (downstream slice IDs affected), `requires` (array of `{slice, provides}` for upstream dependencies consumed), `drillDownPaths` (paths to task summaries)

   **UAT content:** `uatContent` — the UAT markdown body. This must be a concrete UAT script with real test cases derived from the slice plan and task summaries. Include preconditions, numbered steps with expected outcomes, and edge cases. This must NOT be a placeholder or generic template — tailor every test case to what this slice actually built. The tool writes it to `{{sliceUatPath}}`.

7. Review task summaries for `key_decisions`. Append any significant decisions to `.gsd/DECISIONS.md` if missing.
8. Review task summaries for patterns, gotchas, or non-obvious lessons learned. If any would save future agents from repeating investigation or hitting the same issues, append them to `.gsd/KNOWLEDGE.md`. Only add entries that are genuinely useful — don't pad with obvious observations.
9. Do not run git commands — the system commits your changes and handles any merge after this unit succeeds.
10. Update `.gsd/PROJECT.md` if it exists — refresh current state if needed.

**You MUST call `gsd_slice_complete` before finishing.** The tool handles writing `{{sliceSummaryPath}}`, `{{sliceUatPath}}`, and updating `{{roadmapPath}}` atomically. You must still review decisions and knowledge manually (steps 7-8).

When done, say: "Slice {{sliceId}} complete."
