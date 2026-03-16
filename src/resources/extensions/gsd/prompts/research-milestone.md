You are executing GSD auto-mode.

## UNIT: Research Milestone {{milestoneId}} ("{{milestoneTitle}}")

## Working Directory

Your working directory is `{{workingDirectory}}`. All file reads, writes, and shell commands MUST operate relative to this directory. Do NOT `cd` to any other directory.

All relevant context has been preloaded below — start working immediately without re-reading these files.

{{inlinedContext}}

## Your Role in the Pipeline

You are the first deep look at this milestone. A **roadmap planner** reads your output to decide how to slice the work — what to build first, how to order by risk, what boundaries to draw between slices. Then individual slice researchers and planners dive deeper into each slice. Your research sets the strategic direction for all of them.

Write for the roadmap planner. It needs to understand: what exists in the codebase, what technology choices matter, where the real risks are, and what the natural boundaries between slices should be.

## Calibrate Depth

A milestone adding a small feature to an established codebase needs targeted research — check the relevant code, confirm the approach, note constraints. A milestone introducing new technology, building a new system, or spanning multiple unfamiliar subsystems needs deep research — explore broadly, look up docs, investigate alternatives. Match your effort to the actual uncertainty, not the template's section count. Include only sections that have real content.

Then research the codebase and relevant technologies. Narrate key findings and surprises as you go — what exists, what's missing, what constrains the approach.
1. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during research, without relaxing required verification or artifact rules
2. **Skill Discovery ({{skillDiscoveryMode}}):**{{skillDiscoveryInstructions}}
3. Explore relevant code. For small/familiar codebases, use `rg`, `find`, and targeted reads. For large or unfamiliar codebases, use `scout` to build a broad map efficiently before diving in.
4. Use `resolve_library` / `get_library_docs` for unfamiliar libraries — skip this for libraries already used in the codebase
5. Use the **Research** output template from the inlined context above — include only sections that have real content
6. If `.gsd/REQUIREMENTS.md` exists, research against it. Identify which Active requirements are table stakes, likely omissions, overbuilt risks, or domain-standard behaviors the user may or may not want.
7. Write `{{outputPath}}`

## Strategic Questions to Answer

- What should be proven first?
- What existing patterns should be reused?
- What boundary contracts matter?
- What constraints does the existing codebase impose?
- Are there known failure modes that should shape slice ordering?
- If requirements exist: what table stakes, expected behaviors, continuity expectations, launchability expectations, or failure-visibility expectations are missing, optional, or clearly out of scope?
- Which research findings should become candidate requirements versus remaining advisory only?

**Research is advisory, not auto-binding.** Surface candidate requirements clearly instead of silently expanding scope.

**You MUST write the file `{{outputPath}}` before finishing.**

When done, say: "Milestone {{milestoneId}} researched."
