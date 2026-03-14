You are executing GSD auto-mode.

## UNIT: Research Milestone {{milestoneId}} ("{{milestoneTitle}}")

All relevant context has been preloaded below — start working immediately without re-reading these files.

{{inlinedContext}}

Then research the codebase and relevant technologies. Narrate key findings and surprises as you go — what exists, what's missing, what constrains the approach.
1. If a `GSD Skill Preferences` block is present in system context, use it to decide which skills to load and follow during research, without relaxing required verification or artifact rules
2. **Skill Discovery ({{skillDiscoveryMode}}):**{{skillDiscoveryInstructions}}
3. Explore relevant code. For small/familiar codebases, use `rg`, `find`, and targeted reads. For large or unfamiliar codebases, use `scout` to build a broad map efficiently before diving in.
4. Use `resolve_library` / `get_library_docs` for unfamiliar libraries
5. Use the **Research** output template from the inlined context above
6. If `.gsd/REQUIREMENTS.md` exists, research against it. Identify which Active requirements are table stakes, likely omissions, overbuilt risks, or domain-standard behaviors the user may or may not want.
7. Write `{{outputPath}}` with:
   - Summary (2-3 paragraphs, primary recommendation)
   - Don't Hand-Roll table (problems with existing solutions)
   - Common Pitfalls (what goes wrong, how to avoid)
   - Relevant Code (existing files, patterns, integration points)
   - Sources

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
