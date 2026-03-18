You are executing GSD auto-mode.

## UNIT: Plan Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

All relevant context has been preloaded below — start working immediately without re-reading these files.

{{inlinedContext}}

### Dependency Slice Summaries

Pay particular attention to **Forward Intelligence** sections — they contain hard-won knowledge about what's fragile, what assumptions changed, and what this slice should watch out for.

{{dependencySummaries}}

## Your Role in the Pipeline

You have full tool access. Before decomposing, explore the relevant code to ground your plan in reality.

### Verify Roadmap Assumptions

Check prior slice summaries (inlined above as dependency summaries, if present). If prior slices discovered constraints, changed approaches, or flagged fragility, adjust your plan accordingly. The roadmap description may be stale — verify it against the current codebase state.

### Explore Slice Scope

Read the code files relevant to this slice. Confirm the roadmap's description of what exists, what needs to change, and what boundaries apply. Use `rg`, `find`, and targeted reads.

### Source Files

{{sourceFilePaths}}

If slice research exists (inlined above), trust those findings and skip redundant exploration.

After you finish, **executor agents** implement each task in isolated fresh context windows. They see only their task plan, the slice plan excerpt (goal/demo/verification), and compressed summaries of prior tasks. They do not see the research doc, the roadmap, or REQUIREMENTS.md. Everything an executor needs must be in the task plan itself — file paths, specific steps, expected inputs and outputs.

Narrate your decomposition reasoning — why you're grouping work this way, what risks are driving the order, what verification strategy you're choosing and why. Keep the narration proportional to the work — a simple slice doesn't need a long justification — but write in complete sentences, not planner shorthand.

**Right-size the plan.** If the slice is simple enough to be 1 task, plan 1 task. Don't split into multiple tasks just because you can identify sub-steps. Don't fill in sections with "None" when the section doesn't apply — omit them entirely. The plan's job is to guide execution, not to fill a template.

{{executorContextConstraints}}

Then:
0. If `REQUIREMENTS.md` was preloaded above, identify which Active requirements the roadmap says this slice owns or supports. These are the requirements this plan must deliver — every owned requirement needs at least one task that directly advances it, and verification must prove the requirement is met.
1. Read the templates:
   - `~/.gsd/agent/extensions/gsd/templates/plan.md`
   - `~/.gsd/agent/extensions/gsd/templates/task-plan.md`
2. **Load relevant skills.** Check the `GSD Skill Preferences` block in system context and the `<available_skills>` catalog in your system prompt. `read` any skill files relevant to this slice's technology stack before decomposing. When writing task plans, note which installed skills are relevant in the task description so executors know which to load.
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
10. {{commitInstruction}}

The slice directory and tasks/ subdirectory already exist. Do NOT mkdir. All work stays in your working directory: `{{workingDirectory}}`.

**You MUST write the file `{{outputPath}}` before finishing.**

When done, say: "Slice {{sliceId}} planned."
