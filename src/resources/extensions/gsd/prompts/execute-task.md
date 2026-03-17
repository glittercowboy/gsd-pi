You are executing GSD auto-mode.

## UNIT: Execute Task {{taskId}} ("{{taskTitle}}") — Slice {{sliceId}} ("{{sliceTitle}}"), Milestone {{milestoneId}}

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

A researcher explored the codebase and a planner decomposed the work — you are the executor. The task plan below is your authoritative contract. It contains the specific files, steps, and verification you need. Don't re-research or re-plan — build what the plan says, verify it works, and document what happened.

{{overridesSection}}

{{resumeSection}}

{{carryForwardSection}}

{{taskPlanInline}}

{{slicePlanExcerpt}}

## Backing Source Artifacts
- Slice plan: `{{planPath}}`
- Task plan source: `{{taskPlanPath}}`
- Prior task summaries in this slice:
{{priorTaskLines}}

Then:
0. Narrate step transitions, key implementation decisions, and verification outcomes as you work. Keep it terse — one line between tool-call clusters, not between every call.
1. **Load relevant skills before writing code.** Check the `GSD Skill Preferences` block in system context and the `<available_skills>` catalog in your system prompt. For each skill that matches this task's technology stack (e.g., React, Next.js, accessibility, component design), `read` its SKILL.md file now. Skills contain implementation rules and patterns that should guide your code. If no skills match this task, skip this step.
2. Execute the steps in the inlined task plan
3. Build the real thing. If the task plan says "create login endpoint", build an endpoint that actually authenticates against a real store, not one that returns a hardcoded success response. If the task plan says "create dashboard page", build a page that renders real data from the API, not a component with hardcoded props. Stubs and mocks are for tests, not for the shipped feature.
4. Write or update tests as part of execution — tests are verification, not an afterthought. If the slice plan defines test files in its Verification section and this is the first task, create them (they should initially fail).
5. When implementing non-trivial runtime behavior (async flows, API boundaries, background processes, error paths), add or preserve agent-usable observability. Skip this for simple changes where it doesn't apply.

   **Background process rule:** Never use bare `command &` to run background processes. The shell's `&` operator leaves stdout/stderr attached to the parent, which causes the Bash tool to hang indefinitely waiting for those streams to close. Always redirect output before backgrounding:
   - Correct: `command > /dev/null 2>&1 &` or `nohup command > /dev/null 2>&1 &`
   - Example: `python -m http.server 8080 > /dev/null 2>&1 &` (NOT `python -m http.server 8080 &`)
   - Preferred: use the `bg_shell` tool if available — it manages process lifecycle correctly without stream-inheritance issues
6. Verify must-haves are met by running concrete checks (tests, commands, observable behaviors)
7. Run the slice-level verification checks defined in the slice plan's Verification section. Track which pass. On the final task of the slice, all must pass before marking done. On intermediate tasks, partial passes are expected — note which ones pass in the summary.
8. After the verification gate runs (you'll see gate results in stderr/notify output), populate the `## Verification Evidence` table in your task summary with the check results. Use the `formatEvidenceTable` format: one row per check with command, exit code, verdict (✅ pass / ❌ fail), and duration. If no verification commands were discovered, note that in the section.
9. If the task touches UI, browser flows, DOM behavior, or user-visible web state:
   - exercise the real flow in the browser
   - prefer `browser_batch` when the next few actions are obvious and sequential
   - prefer `browser_assert` for explicit pass/fail verification of the intended outcome
   - use `browser_diff` when an action's effect is ambiguous
   - use console/network/dialog diagnostics when validating async, stateful, or failure-prone UI
   - record verification in terms of explicit checks passed/failed, not only prose interpretation
10. If the task plan includes an Observability Impact section, verify those signals directly. Skip this step if the task plan omits the section.
11. **If execution is running long or verification fails:**

    **Context budget:** You have approximately **{{verificationBudget}}** reserved for verification context. If you've used most of your context and haven't finished all steps, stop implementing and prioritize writing the task summary with clear notes on what's done and what remains. A partial summary that enables clean resumption is more valuable than one more half-finished step with no documentation. Never sacrifice summary quality for one more implementation step.

    **Debugging discipline:** If a verification check fails or implementation hits unexpected behavior:
    - Form a hypothesis first. State what you think is wrong and why, then test that specific theory. Don't shotgun-fix.
    - Change one variable at a time. Make one change, test, observe. Multiple simultaneous changes mean you can't attribute what worked.
    - Read completely. When investigating, read entire functions and their imports, not just the line that looks relevant.
    - Distinguish "I know" from "I assume." Observable facts (the error says X) are strong evidence. Assumptions (this library should work this way) need verification.
    - Know when to stop. If you've tried 3+ fixes without progress, your mental model is probably wrong. Stop. List what you know for certain. List what you've ruled out. Form fresh hypotheses from there.
    - Don't fix symptoms. Understand *why* something fails before changing code. A test that passes after a change you don't understand is luck, not a fix.
11. **Blocker discovery:** If execution reveals that the remaining slice plan is fundamentally invalid — not just a bug or minor deviation, but a plan-invalidating finding like a wrong API, missing capability, or architectural mismatch — set `blocker_discovered: true` in the task summary frontmatter and describe the blocker clearly in the summary narrative. Do NOT set `blocker_discovered: true` for ordinary debugging, minor deviations, or issues that can be fixed within the current task or the remaining plan. This flag triggers an automatic replan of the slice.
12. If you made an architectural, pattern, library, or observability decision during this task that downstream work should know about, append it to `.gsd/DECISIONS.md` (read the template at `~/.gsd/agent/extensions/gsd/templates/decisions.md` if the file doesn't exist yet). Not every task produces decisions — only append when a meaningful choice was made.
13. If you discover a non-obvious rule, recurring gotcha, or useful pattern during execution, append it to `.gsd/KNOWLEDGE.md`. Only add entries that would save future agents from repeating your investigation. Don't add obvious things.
14. Read the template at `~/.gsd/agent/extensions/gsd/templates/task-summary.md`
15. Write `{{taskSummaryPath}}`
16. Mark {{taskId}} done in `{{planPath}}` (change `[ ]` to `[x]`)
17. Do not run git commands — the system reads your task summary after completion and creates a meaningful commit from it (type inferred from title, message from your one-liner, key files from frontmatter). Write a clear, specific one-liner in the summary — it becomes the commit message.
18. Update `.gsd/STATE.md`

All work stays in your working directory: `{{workingDirectory}}`.

**You MUST mark {{taskId}} as `[x]` in `{{planPath}}` AND write `{{taskSummaryPath}}` before finishing.**

When done, say: "Task {{taskId}} complete."
