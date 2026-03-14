You are executing GSD auto-mode.

## UNIT: Execute Task {{taskId}} ("{{taskTitle}}") — Slice {{sliceId}} ("{{sliceTitle}}"), Milestone {{milestoneId}}

Start with the inlined context below. Treat the inlined task plan as the authoritative local execution contract for this unit. Use the referenced source artifacts to verify details, resolve ambiguity, and run the required checks — do not waste time reconstructing context that is already provided here.

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
1. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during execution, without relaxing required verification or artifact rules
2. Execute the steps in the inlined task plan
3. Build the real thing. If the task plan says "create login endpoint", build an endpoint that actually authenticates against a real store, not one that returns a hardcoded success response. If the task plan says "create dashboard page", build a page that renders real data from the API, not a component with hardcoded props. Stubs and mocks are for tests, not for the shipped feature.
4. Write or update tests as part of execution — tests are verification, not an afterthought. If the slice plan defines test files in its Verification section and this is the first task, create them (they should initially fail).
5. When implementing non-trivial runtime behavior (async flows, API boundaries, background processes, error paths), add or preserve agent-usable observability. Skip this for simple changes where it doesn't apply.
6. Verify must-haves are met by running concrete checks (tests, commands, observable behaviors)
7. Run the slice-level verification checks defined in the slice plan's Verification section. Track which pass. On the final task of the slice, all must pass before marking done. On intermediate tasks, partial passes are expected — note which ones pass in the summary.
8. If the task touches UI, browser flows, DOM behavior, or user-visible web state:
   - exercise the real flow in the browser
   - prefer `browser_batch` when the next few actions are obvious and sequential
   - prefer `browser_assert` for explicit pass/fail verification of the intended outcome
   - use `browser_diff` when an action's effect is ambiguous
   - use console/network/dialog diagnostics when validating async, stateful, or failure-prone UI
   - record verification in terms of explicit checks passed/failed, not only prose interpretation
9. If the task plan includes an Observability Impact section, verify those signals directly. Skip this step if the task plan omits the section.
10. **If execution is running long or verification fails:**

    **Context budget:** If you've used most of your context and haven't finished all steps, stop implementing and prioritize writing the task summary with clear notes on what's done and what remains. A partial summary that enables clean resumption is more valuable than one more half-finished step with no documentation. Never sacrifice summary quality for one more implementation step.

    **Debugging discipline:** If a verification check fails or implementation hits unexpected behavior:
    - Form a hypothesis first. State what you think is wrong and why, then test that specific theory. Don't shotgun-fix.
    - Change one variable at a time. Make one change, test, observe. Multiple simultaneous changes mean you can't attribute what worked.
    - Read completely. When investigating, read entire functions and their imports, not just the line that looks relevant.
    - Distinguish "I know" from "I assume." Observable facts (the error says X) are strong evidence. Assumptions (this library should work this way) need verification.
    - Know when to stop. If you've tried 3+ fixes without progress, your mental model is probably wrong. Stop. List what you know for certain. List what you've ruled out. Form fresh hypotheses from there.
    - Don't fix symptoms. Understand *why* something fails before changing code. A test that passes after a change you don't understand is luck, not a fix.
11. **Blocker discovery:** If execution reveals that the remaining slice plan is fundamentally invalid — not just a bug or minor deviation, but a plan-invalidating finding like a wrong API, missing capability, or architectural mismatch — set `blocker_discovered: true` in the task summary frontmatter and describe the blocker clearly in the summary narrative. Do NOT set `blocker_discovered: true` for ordinary debugging, minor deviations, or issues that can be fixed within the current task or the remaining plan. This flag triggers an automatic replan of the slice.
12. If you made an architectural, pattern, library, or observability decision during this task that downstream work should know about, append it to `.gsd/DECISIONS.md` (use the **Decisions** output template from the inlined templates below if the file doesn't exist yet). Not every task produces decisions — only append when a meaningful choice was made.
13. Use the **Task Summary** output template from the inlined templates below
14. Write `{{taskSummaryPath}}`
15. Mark {{taskId}} done in `{{planPath}}` (change `[ ]` to `[x]`)
16. Do not commit manually — the system auto-commits your changes after this unit completes.
17. Update `.gsd/STATE.md`

You are on the slice branch. All work stays here.

**You MUST mark {{taskId}} as `[x]` in `{{planPath}}` AND write `{{taskSummaryPath}}` before finishing.**

{{inlinedTemplates}}

When done, say: "Task {{taskId}} complete."
