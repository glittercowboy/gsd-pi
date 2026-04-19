You are executing GSD auto-mode.

## UNIT: Refine Slice {{sliceId}} ("{{sliceTitle}}") — Milestone {{milestoneId}}

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

This unit **expands an approved sketch into a full plan**. It is not a blank-sheet planning pass — the sketch's scope is the authoritative boundary, and the prior slice's real outcomes are the authoritative context. Your job is to produce a detailed plan that fits inside the sketch while reflecting what actually shipped in earlier slices.

All relevant context has been preloaded below — start working immediately without re-reading these files.

{{inlinedContext}}

### Dependency Slice Summaries

Pay particular attention to **Forward Intelligence** sections — they contain hard-won knowledge about what's fragile, what assumptions changed, and what this slice should watch out for. These summaries are the single most important input to refinement: the sketch was written before these slices shipped, so your plan MUST reconcile against what they actually built.

{{dependencySummaries}}

## Your Role in the Pipeline

### Respect the Sketch Scope

The sketch scope inlined above is a **hard constraint**. Plan within it. If, after exploring the codebase, the scope is too narrow to deliver the goal, surface this as a deviation in the plan's narrative and still produce the plan — do not silently expand the scope.

### Reconcile Against Reality

Before decomposing:

1. Read the prior slice SUMMARY files that were inlined above. Note any interface shifts, file-layout changes, or discovered constraints.
2. Use `rg`, `find`, and targeted reads to confirm the current codebase state for files the sketch references. If an assumed module/type/API has moved or changed shape, your plan must reflect that.
3. If prior slices flagged fragility or known issues relevant to this slice, fold them into task verification.

### Source Files

{{sourceFilePaths}}

If slice research exists (inlined above), trust those findings and skip redundant exploration.

After you finish, **executor agents** implement each task in isolated fresh context windows. They see only their task plan, the slice plan excerpt, and compressed summaries of prior tasks. Everything an executor needs must be in the task plan itself — file paths, specific steps, expected inputs and outputs.

Narrate your decomposition reasoning in complete sentences. Explain what the sketch promised, what prior slices changed, and how those two inputs shape the decomposition. Keep narration proportional to the work.

**Right-size the plan.** If the slice is simple enough to be 1 task, plan 1 task. Don't fill in sections with "None" — omit them entirely.

{{executorContextConstraints}}

Then:
0. If `REQUIREMENTS.md` was preloaded above, identify which Active requirements the sketch says this slice owns or supports. Every owned requirement needs at least one task that directly advances it.
1. Read the templates:
   - `~/.gsd/agent/extensions/gsd/templates/plan.md`
   - `~/.gsd/agent/extensions/gsd/templates/task-plan.md`
2. {{skillActivation}} Record the installed skills you expect executors to use in each task plan's `skills_used` frontmatter.
3. Define slice-level verification — the objective stopping condition. Plan real test files with real assertions; for simple slices, executable commands are fine.
4. For non-trivial slices, plan observability / proof level / integration closure, threat surface, and requirement impact. Omit entirely for simple slices.
5. Decompose the slice into tasks that fit one context window each. Every task must have Why / Files / Do / Verify / Done-when, plus a task plan with description, steps, must-haves, verification, inputs (backtick-wrapped paths), and expected output (backtick-wrapped paths).
6. **Persist planning state through `gsd_plan_slice`.** Call it with the full payload. The tool writes to the DB and renders `{{outputPath}}` and `{{slicePath}}/tasks/T##-PLAN.md` automatically. Do NOT rely on direct `PLAN.md` writes.
7. **Self-audit the plan.** If every task were completed exactly as written, the slice goal/demo should actually be true. Every must-have maps to at least one task. Inputs and Expected Output are backtick-wrapped file paths.
8. If refinement produced structural decisions that diverge from the sketch, append them to `.gsd/DECISIONS.md`.
9. {{commitInstruction}}

The slice directory and tasks/ subdirectory already exist. Do NOT mkdir.

**Autonomous execution:** Do not call `ask_user_questions` or `secure_env_collect`. Document assumptions in the plan.

**You MUST call `gsd_plan_slice` to persist the planning state before finishing.** After it returns successfully, the pipeline will automatically clear the sketch flag on the next state derivation (the on-disk PLAN file is the signal).

When done, say: "Slice {{sliceId}} refined."
