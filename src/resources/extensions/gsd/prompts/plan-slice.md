You are executing GSD auto-mode.

## UNIT: Plan Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

All relevant context has been preloaded below — start working immediately without re-reading these files.

{{inlinedContext}}

### Dependency Slice Summaries

Pay particular attention to **Forward Intelligence** sections — they contain hard-won knowledge about what's fragile, what assumptions changed, and what this slice should watch out for.

{{dependencySummaries}}

Narrate your decomposition reasoning — why you're grouping work this way, what risks are driving the order, what verification strategy you're choosing and why. Keep the narration proportional to the work — a simple slice doesn't need a long justification.

**Right-size the plan.** If the slice is simple enough to be 1 task, plan 1 task. Don't split into multiple tasks just because you can identify sub-steps. Don't fill in sections with "None" when the section doesn't apply — omit them entirely. The plan's job is to guide execution, not to fill a template.

Then:
0. If `REQUIREMENTS.md` was preloaded above, identify which Active requirements the roadmap says this slice owns or supports. These are the requirements this plan must deliver — every owned requirement needs at least one task that directly advances it, and verification must prove the requirement is met.
1. Use the **Slice Plan** and **Task Plan** output templates from the inlined context above
2. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during planning, without overriding required plan formatting
3. Define slice-level verification — the objective stopping condition for this slice:
   - For non-trivial slices: plan actual test files with real assertions. Name the files.
   - For simple slices: executable commands or script assertions are fine.
   - If the project is non-trivial and has no test framework, the first task should set one up.
   - If this slice establishes a boundary contract, verification must exercise that contract.
4. **For non-trivial slices only** — plan observability, proof level, and integration closure:
   - Include `Observability / Diagnostics` for backend, integration, async, stateful, or UI slices where failure diagnosis matters.
   - Fill `Proof Level` and `Integration Closure` when the slice crosses runtime boundaries or has meaningful integration concerns.
   - **Omit these sections entirely for simple slices** where they would all be "none" or trivially obvious.
5. Decompose the slice into tasks, each fitting one context window. Each task needs:
   - a concrete, action-oriented title
   - the inline task entry fields defined in the plan.md template (Why / Files / Do / Verify / Done when)
   - a matching task plan file with description, steps, must-haves, verification, inputs, and expected output
   - Observability Impact section **only if the task touches runtime boundaries, async flows, or error paths** — omit it otherwise
6. Write `{{outputPath}}`
7. Write individual task plans in `{{slicePath}}/tasks/`: `T01-PLAN.md`, `T02-PLAN.md`, etc.
8. **Self-audit the plan.** Walk through each check — if any fail, fix the plan files before moving on:
    - **Completion semantics:** If every task were completed exactly as written, the slice goal/demo should actually be true.
    - **Requirement coverage:** Every must-have in the slice maps to at least one task. No must-have is orphaned. If `REQUIREMENTS.md` exists, every Active requirement this slice owns maps to at least one task.
    - **Task completeness:** Every task has steps, must-haves, verification, inputs, and expected output — none are blank or vague.
    - **Dependency correctness:** Task ordering is consistent. No task references work from a later task.
    - **Key links planned:** For every pair of artifacts that must connect, there is an explicit step that wires them.
    - **Scope sanity:** Target 2–5 steps and 3–8 files per task. 10+ steps or 12+ files — must split. Each task must be completable in a single fresh context window.
    - **Feature completeness:** Every task produces real, user-facing progress — not just internal scaffolding.
9. If planning produced structural decisions, append them to `.gsd/DECISIONS.md`
10. Commit: `docs({{sliceId}}): add slice plan`
11. Update `.gsd/STATE.md`

The slice directory and tasks/ subdirectory already exist. Do NOT mkdir. You are on the slice branch; all work stays here.

**You MUST write the file `{{outputPath}}` before finishing.**

When done, say: "Slice {{sliceId}} planned."
