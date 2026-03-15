# Task: Improve Research → Planner Separation of Concerns in GSD Auto-Mode

## Problem

In GSD's auto-mode pipeline, there are two phases before execution: **research** and **plan**. The researcher explores the codebase and writes findings. The planner receives those findings and decomposes into slices/tasks. But the separation is leaky:

1. The **researcher** writes high-level summaries ("there's a middleware pattern") instead of the specific code-level details the planner needs ("auth middleware is in `src/middleware/auth.ts`, exports `withAuth()`, used in `src/routes/api/*.ts`"). The research template's "Existing Code and Patterns" section encourages this with its brief `filePath — whatItDoesAndHowToReuseIt` format.

2. The **planner** is never told that the research contains everything it needs about the codebase. Nothing stops it from doing its own `rg`, `find`, `read` exploration — and it frequently does, because it needs concrete file paths, function signatures, and module boundaries to write task plans with `Files:` lists. This duplicates work the researcher already did (or should have done).

The result: wasted tokens and context window on redundant codebase exploration in the planner session.

## What to Change

You are editing files in this project: `/Users/lexchristopherson/Developer/gsd-2/`

All paths below are relative to the project root.

### Files to modify (5 files total):

1. `src/resources/extensions/gsd/templates/research.md` — the output template for research artifacts
2. `src/resources/extensions/gsd/prompts/research-milestone.md` — the prompt for milestone-level research
3. `src/resources/extensions/gsd/prompts/research-slice.md` — the prompt for slice-level research
4. `src/resources/extensions/gsd/prompts/plan-milestone.md` — the prompt for milestone-level planning
5. `src/resources/extensions/gsd/prompts/plan-slice.md` — the prompt for slice-level planning

**DO NOT modify `src/resources/extensions/gsd/auto.ts` or any TypeScript files.** The changes are prompt-only and template-only. The TypeScript code that builds inlined context is fine — the researcher's output file is already inlined into the planner's context. The problem is in what the prompts tell the agent to do and what the template tells it to write.

### Change 1: Research template (`templates/research.md`)

Add a new mandatory section called `## Planner Brief` between the existing `## Existing Code and Patterns` section and `## Constraints` section. This section is specifically written FOR the planner and must contain everything the planner needs to write task plans without exploring the codebase itself.

The Planner Brief section should have these subsections:

```markdown
## Planner Brief

<!-- This section exists FOR the planner. Write it so that someone who has never seen the codebase
     can write task plans with correct file paths, function names, and integration points.
     The planner will NOT explore the codebase — this is its only source of code-level truth. -->

### File Inventory

<!-- Every file relevant to this work. Not just "the auth module" — the actual paths with
     a one-line description of what each does and what's exported/exposed. -->

- `{{filePath}}` — {{purpose, key exports/functions, what it depends on}}

### Integration Points

<!-- Where does new code need to plug in? Be specific: which function to call, which file
     to import from, which pattern to follow, which config to update. -->

- {{where new code hooks into existing code, with specific file + function + pattern}}

### Patterns to Follow

<!-- Show the actual pattern, not just name it. If there's a middleware pattern, show the
     3-line shape of how a middleware is registered. If there's a service pattern, show how
     services are instantiated. Include enough that the planner can write "Do: follow the
     pattern in X" in a task plan. -->

- **{{patternName}}**: used in `{{exampleFile}}` — {{how it works in 1-2 sentences, enough to replicate}}

### Key Constraints for Planning

<!-- Hard constraints that affect HOW tasks should be decomposed or ordered.
     Not general risks — specific things that change what the plan looks like. -->

- {{constraint that affects task decomposition or ordering}}
```

Also rename the existing `## Existing Code and Patterns` section to `## Codebase Landscape` to differentiate it from the more detailed Planner Brief. The Codebase Landscape section stays as-is — it's the high-level overview. The Planner Brief is the detailed, actionable inventory.

### Change 2: Research prompts (`prompts/research-milestone.md` and `prompts/research-slice.md`)

In both research prompts, add explicit instructions about the Planner Brief. Add these as a new numbered item after the existing research steps (before the "Write `{{outputPath}}`" step).

Add this text to both research prompts:

```
N. **Write the Planner Brief for the next phase.** The planner will receive your research file and will NOT explore the codebase — your Planner Brief is its only source of code-level truth. Make it detailed enough that the planner can write task plans with correct file paths, function signatures, and integration points without reading a single source file. If you're unsure whether to include a detail, include it. An overly detailed Planner Brief wastes a few tokens; a sparse one wastes an entire planner session on redundant exploration.
```

(Replace `N` with the correct number in sequence for each file.)

### Change 3: Planner prompts (`prompts/plan-milestone.md` and `prompts/plan-slice.md`)

In both planner prompts, add an explicit instruction near the top (right after the `{{inlinedContext}}` line, before the "Narrate your decomposition reasoning" line) that tells the planner to trust the research and not re-explore:

```
**The research file in your inlined context contains a Planner Brief with file paths, integration points, and patterns — this is your source of truth for the codebase. Plan from the research. Do not explore the codebase with rg, find, or read unless the research explicitly flags a gap that blocks planning. If a file path or detail you need is missing from the Planner Brief, note the gap in your plan narration and make your best judgment — don't burn context on exploration.**
```

For `plan-milestone.md`: Insert this paragraph right after the `{{inlinedContext}}` template variable line and before the "Narrate your decomposition reasoning" line.

For `plan-slice.md`: Insert this paragraph right after the `{{dependencySummaries}}` template variable line and before the "Narrate your decomposition reasoning" line.

## How to Verify

After making the changes:

1. Read all 5 modified files and confirm the changes are coherent — the research template has the new Planner Brief section, both research prompts tell the agent to write it, both planner prompts tell the agent to trust it.

2. Run the existing test suite to make sure nothing breaks:
   ```bash
   cd /Users/lexchristopherson/Developer/gsd-2
   npm test
   ```

3. Verify the template variable syntax — make sure no `{{variableName}}` was accidentally introduced that the TypeScript `loadPrompt()` function would try to substitute. The `loadPrompt` function in `src/resources/extensions/gsd/prompt-loader.ts` throws if a template declares `{{varName}}` but no value is provided. The `{{placeholder}}` values inside HTML comments and inside the template examples (like `{{filePath}}`) are fine because they're in the *output template* file (`templates/research.md`), not in a *prompt template* file (`prompts/*.md`). The prompt files are the ones that get variable substitution. Double-check that any new text added to `prompts/*.md` files does NOT contain `{{anything}}` unless it's a variable that's already being passed by the TypeScript code.

4. Check that the template change is backward-compatible — existing research files without the Planner Brief section should not cause the planner to break. The planner instruction says "if missing, note the gap" which handles this gracefully.

## What NOT to Do

- Do NOT modify any `.ts` files. The context-building code in `auto.ts` already inlines the research output into the planner's context. That's working fine.
- Do NOT change the structure or variable names in prompt files — only add new prose/instructions.
- Do NOT remove any existing content from the research template — only add the new section.
- Do NOT change the `## Strategic Questions to Answer` section in the research prompts.
- Do NOT change the `## Planning Doctrine` section in the planner prompts.
- Do NOT change any of the existing `{{variableName}}` template variables in prompt files.
