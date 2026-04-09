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
2. {{skillActivation}} Record the installed skills you expect executors to use in each task plan's `skills_used` frontmatter.
3. Define slice-level verification — the objective stopping condition for this slice:
   - For non-trivial slices: plan actual test files with real assertions. Name the files.
   - For simple slices: executable commands or script assertions are fine.
   - If the project is non-trivial and has no test framework, the first task should set one up.
   - If this slice establishes a boundary contract, verification must exercise that contract.
4. **For non-trivial slices only** — plan observability, proof level, and integration closure:
   - Include `Observability / Diagnostics` for backend, integration, async, stateful, or UI slices where failure diagnosis matters.
   - Fill `Proof Level` and `Integration Closure` when the slice crosses runtime boundaries or has meaningful integration concerns.
   - **Omit these sections entirely for simple slices** where they would all be "none" or trivially obvious.
5. **Quality gates** — for non-trivial slices, fill the Threat Surface (Q3) and Requirement Impact (Q4) sections in the slice plan:
   - **Threat Surface:** Identify abuse scenarios, data exposure risks, and input trust boundaries. Required when the slice handles user input, authentication, authorization, or sensitive data. Omit entirely for internal refactoring or simple changes.
   - **Requirement Impact:** List which existing requirements this slice touches, what must be re-verified after shipping, and which prior decisions should be reconsidered. Omit entirely if no existing requirements are affected.
   - For each task in a non-trivial slice, fill Failure Modes (Q5), Load Profile (Q6), and Negative Tests (Q7) in the task plan when the task has external dependencies, shared resources, or non-trivial input handling. Omit for simple tasks.
6. Decompose the slice into tasks, each fitting one context window. Each task needs:
   - a concrete, action-oriented title
   - the inline task entry fields defined in the plan.md template (Why / Files / Do / Verify / Done when)
   - a matching task plan file with description, steps, must-haves, verification, inputs, and expected output
   - **Inputs and Expected Output must list concrete backtick-wrapped file paths** (e.g. `` `src/types.ts` ``). These are machine-parsed to derive task dependencies — vague prose without paths breaks parallel execution. Every task must have at least one output file path.
   - Observability Impact section **only if the task touches runtime boundaries, async flows, or error paths** — omit it otherwise
7. **Persist planning state through `gsd_plan_slice`.** Call it with the full slice planning payload (goal, demo, must-haves, verification, tasks, and metadata). The tool inserts all tasks in the same transaction, writes to the DB, and renders `{{outputPath}}` and `{{slicePath}}/tasks/T##-PLAN.md` files automatically. Do **not** call `gsd_plan_task` separately — `gsd_plan_slice` handles task persistence. Do **not** rely on direct `PLAN.md` writes as the source of truth; the DB-backed tool is the canonical write path for slice and task planning state.
8. **Self-audit the plan.** Walk through each check — if any fail, fix the plan files before moving on:
    - **Completion semantics:** If every task were completed exactly as written, the slice goal/demo should actually be true.
    - **Requirement coverage:** Every must-have in the slice maps to at least one task. No must-have is orphaned. If `REQUIREMENTS.md` exists, every Active requirement this slice owns maps to at least one task.
    - **Task completeness:** Every task has steps, must-haves, verification, inputs, and expected output — none are blank or vague. Inputs and Expected Output list backtick-wrapped file paths, not prose descriptions.
    - **Dependency correctness:** Task ordering is consistent. No task references work from a later task.
    - **Key links planned:** For every pair of artifacts that must connect, there is an explicit step that wires them.
    - **Scope sanity:** Target 2–5 steps and 3–8 files per task. 10+ steps or 12+ files — must split. Each task must be completable in a single fresh context window.
    - **Feature completeness:** Every task produces real, user-facing progress — not just internal scaffolding.
    - **Quality gate coverage:** For non-trivial slices, Threat Surface and Requirement Impact sections are present and specific (not placeholder text). For non-trivial tasks, Failure Modes, Load Profile, and Negative Tests are addressed in the task plan.
10. If planning produced structural decisions, append them to `.gsd/DECISIONS.md`
11. {{commitInstruction}}

The slice directory and tasks/ subdirectory already exist. Do NOT mkdir. All work stays in your working directory: `{{workingDirectory}}`.

**Autonomous execution:** Do not call `ask_user_questions` or `secure_env_collect`. You are running in auto-mode — there is no human available to answer questions. Make reasonable assumptions and document them in the plan. If a decision genuinely requires human input, write a note in the relevant task's description and call `gsd_plan_slice` with what you have.

**You MUST call `gsd_plan_slice` to persist the planning state before finishing.**

When done, say: "Slice {{sliceId}} planned."
