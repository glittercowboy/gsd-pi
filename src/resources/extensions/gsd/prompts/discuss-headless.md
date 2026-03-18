# Headless Milestone Creation

You are creating a GSD milestone from a provided specification document. This is a **headless** (non-interactive) flow — do NOT ask the user any questions. Work entirely from the provided specification.

## Provided Specification

{{seedContext}}

## Your Task

### Step 1: Reflect

Summarize your understanding of the specification concretely:
- What is being built
- Major capabilities/features
- Scope estimate (how many milestones × slices)
- Any ambiguities or gaps you notice

### Step 2: Investigate (brief)

Quickly scout the codebase to understand what already exists — spend no more than 5-6 tool calls here:
- `ls` the project root and key directories
- Search for relevant existing code, patterns, dependencies
- Check library docs if needed (`resolve_library` / `get_library_docs`)

Then move on to writing artifacts. Do not explore exhaustively — the research phase will do deeper investigation later.

### Step 3: Make Decisions

For any ambiguities or gaps in the specification:
- Make your best-guess decision based on the spec's intent, codebase patterns, and domain conventions
- Document each assumption clearly in the Context file

### Step 4: Assess Scope

Based on reflection + investigation:
- Is this a single milestone or multiple milestones?
- If multi-milestone: plan the full sequence with dependencies

### Step 5: Write Artifacts

**Milestone ID**: {{milestoneId}}

Use these templates exactly:

{{inlinedTemplates}}

**For single milestone**, write in this order:
1. `mkdir -p .gsd/milestones/{{milestoneId}}/slices`
2. Write `.gsd/PROJECT.md` (using Project template)
3. Write `.gsd/REQUIREMENTS.md` (using Requirements template)
4. Write `{{contextPath}}` (using Context template) — preserve the specification's exact terminology, emphasis, and specific framing. Do not paraphrase domain-specific language into generics. Document assumptions under an "Assumptions" section.
5. Write `{{roadmapPath}}` (using Roadmap template) — decompose into demoable vertical slices with checkboxes, risk, depends, demo sentences, proof strategy, verification classes, milestone definition of done, requirement coverage, and a boundary map. If the milestone crosses multiple runtime boundaries, include an explicit final integration slice.
6. Seed `.gsd/DECISIONS.md` (using Decisions template)
7. {{commitInstruction}}
9. Say exactly: "Milestone {{milestoneId}} ready."

**For multi-milestone**, write in this order:
1. For each milestone, call `gsd_generate_milestone_id` to get its ID — never invent milestone IDs manually. Then `mkdir -p .gsd/milestones/<ID>/slices` for each.
2. Write `.gsd/PROJECT.md` — full vision across ALL milestones (using Project template)
3. Write `.gsd/REQUIREMENTS.md` — full capability contract (using Requirements template)
4. Seed `.gsd/DECISIONS.md` (using Decisions template)
5. Write PRIMARY `{{contextPath}}` — full context with all assumptions documented
6. Write PRIMARY `{{roadmapPath}}` — detailed slices for the first milestone only
7. For each remaining milestone, write full CONTEXT.md with `depends_on` frontmatter:
   ```yaml
   ---
   depends_on: [M001, M002]
   ---

   # M003: Title
   ```
   Each context file should be rich enough that a future agent — with no memory of this conversation — can understand the intent, constraints, dependencies, what the milestone unlocks, and what "done" looks like.
8. {{multiMilestoneCommitInstruction}}
10. Say exactly: "Milestone {{milestoneId}} ready."

## Critical Rules

- **DO NOT ask the user any questions** — this is headless mode
- **Preserve the specification's terminology** — don't paraphrase domain-specific language
- **Document assumptions** — when you make a judgment call, note it in CONTEXT.md under "Assumptions"
- **Investigate before writing** — always scout the codebase first
- **Use depends_on frontmatter** for multi-milestone sequences (the state machine reads this field to determine execution order)
- **Anti-reduction rule** — if the spec describes a big vision, plan the big vision. Do not ask "what's the minimum viable version?" or reduce scope. Phase complex/risky work into later milestones — do not cut it.
- **Naming convention** — always use `gsd_generate_milestone_id` to get milestone IDs. Directories use bare IDs (e.g. `M001/` or `M001-r5jzab/`), files use ID-SUFFIX format (e.g. `M001-CONTEXT.md` or `M001-r5jzab-CONTEXT.md`). Never invent milestone IDs manually.
- **End with "Milestone {{milestoneId}} ready."** — this triggers auto-start detection
