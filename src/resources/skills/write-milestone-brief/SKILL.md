---
name: write-milestone-brief
description: Synthesize the current conversation into a milestone brief (PRD). Writes to `M###-CONTEXT.md` by default, or files a GitHub issue only with explicit user confirmation. Use when asked to "turn this into a PRD", "draft a milestone brief", "capture this context", "write it up", or when enough has been discussed to commit the plan to paper. Does not interview — it synthesizes what is already known.
---

<objective>
Take everything established in the current conversation (plus repo reality) and produce a milestone brief that a future agent can execute from with zero additional context. The output is a populated `M###-CONTEXT.md`, matching the template at `src/resources/extensions/gsd/templates/context.md`. Optionally, with explicit confirmation, also a GitHub issue.
</objective>

<context>
This skill runs at the end of a discussion phase, after enough grilling/design has happened that the plan has stabilized. It does NOT interview — use the `grill-me` skill for that. This skill collapses what is already on the page into a durable artifact.

Typical invocation points:
- User says "capture this" or "write it up" after a planning discussion
- End of a `discuss` phase before moving to `plan`
- User wants to hand the work off to another agent or a human teammate
</context>

<core_principle>
**SYNTHESIZE, DO NOT RE-INTERVIEW.** Use what is already in this conversation. If a decision is genuinely missing, note it in `Open Questions` — do not relitigate.

**REAL OUTCOMES, NOT TASKS.** `M###-CONTEXT.md` describes what the user can do when the milestone ships, what scenarios must pass for "done," and what architectural decisions were made. It does NOT list tasks or implementation steps — those belong in `M###-ROADMAP.md` and `S##-PLAN.md`.

**NO FILE PATHS OR LINE NUMBERS IN THE BRIEF.** Those go stale. Describe modules, interfaces, and behaviors. The roadmap and plans can cite code locations; the brief should outlive refactors.
</core_principle>

<process>

## Step 1: Locate the target

Find the active milestone:

1. Read `.gsd/STATE.md` — it names the active milestone.
2. If no milestone is active, ask the user whether this is a new milestone (create directory + files) or appending to an existing one.
3. For a new milestone, use `gsd_milestone_new` or the `/gsd new-milestone` flow — do not create directories by hand.

## Step 2: Read the template

Read `src/resources/extensions/gsd/templates/context.md` (the full path is shown in the `templatesDir` system-prompt field). Match its structure exactly — parsers and downstream prompts depend on the headings.

## Step 3: Sketch the modules

Before filling the template, sketch the major modules the milestone will build or modify. Actively look for opportunities to extract **deep modules** — ones that encapsulate a lot of functionality in a simple, testable interface that rarely changes. A deep module is more testable, more AI-navigable, and survives refactors.

If the modules are non-obvious, offer the user a brief check-in: "The milestone touches modules A, B, and C. A can be extracted as a deep module that hides X. Does that match your thinking?" One round. Then proceed.

## Step 4: Fill the template

Populate `M###-CONTEXT.md` using the template. Key sections:

- **Project Description** — one paragraph, plain English, what this milestone is.
- **Why This Milestone** — the problem it solves and why now, from the user's perspective.
- **User-Visible Outcome** — literal user actions in the real environment. "User can complete the import flow end-to-end" not "Adds import API."
- **Completion Class** — contract / integration / operational. Be honest about what level of proof is required.
- **Final Integrated Acceptance** — the real end-to-end scenarios that must pass. Name things that cannot be simulated.
- **Architectural Decisions** — one `### Decision Title` block per decision, with rationale and alternatives considered. If there were no architectural decisions, write "None — straightforward execution" and skip the subsections.
- **Error Handling Strategy** — approach for failures, edge cases, and error propagation. Include retry policies, fallback behaviors, and user-facing error messages where relevant.
- **Risks and Unknowns** — only real ones. Do not invent risks.
- **Existing Codebase / Prior Art** — module names, not line numbers. Brief description of how each relates.
- **Relevant Requirements** — requirement IDs this milestone advances and how.
- **Scope** — In Scope / Out of Scope / Non-Goals. Be specific about tempting adjacent work that is out.
- **Technical Constraints** — binding constraints (runtime, platform, dependencies, performance budgets).
- **Integration Points** — external systems/services this milestone touches and how.
- **Testing Requirements** — test types (unit, integration, e2e), coverage expectations, and specific scenarios that must pass.
- **Acceptance Criteria** — per-slice, testable criteria gathered during discussion.
- **Open Questions** — anything material that is genuinely unresolved. Note current thinking so future agents have a starting point.

> The template headings above are mandatory — do not omit, rename, or reorder them. The exact required order matches `src/resources/extensions/gsd/templates/context.md`: Project Description → Why This Milestone → User-Visible Outcome → Completion Class → Final Integrated Acceptance → Architectural Decisions → Error Handling Strategy → Risks and Unknowns → Existing Codebase / Prior Art → Relevant Requirements → Scope → Technical Constraints → Integration Points → Testing Requirements → Acceptance Criteria → Open Questions.

## Step 5: Write it

Use the `write` tool to create or overwrite `.gsd/milestones/<MID>/<MID>-CONTEXT.md`. Do not ask for approval of the file contents before writing — the user will see the rendered file and can edit directly.

Then append a one-line summary to `.gsd/DECISIONS.md` for any genuinely hard-to-reverse architectural decision: `- YYYY-MM-DD [MID]: <decision> — <one-line rationale>`.

## Step 6: Offer next steps

After writing, offer the user (do not auto-execute):

1. **Proceed to planning** — run `/gsd dispatch plan` to generate `M###-ROADMAP.md` from this brief.
2. **File as GitHub issue** — use `mcp__github__issue_write` to create a tracking issue. Requires explicit "yes" per the outward-action rule. Use the PRD template below for the body.
3. **Iterate on the brief** — if something feels wrong, run `grill-me` to stress-test before moving on.

### GitHub issue body template (only if user chooses option 2)

```markdown
## Problem Statement
<user-perspective problem — one paragraph>

## Solution
<user-perspective solution — one paragraph>

## User Stories
1. As a <actor>, I want <feature>, so that <benefit>.
2. ...
<cover all aspects; be exhaustive>

## Architectural Decisions
<list of decisions with rationale — copy from M###-CONTEXT.md>

## Testing Strategy
<what a good test looks like here: external behavior only, which modules get tested, prior art>

## Out of Scope
<things explicitly not covered>

## Further Notes
<any extra context>

---
See `.gsd/milestones/<MID>/<MID>-CONTEXT.md` for the full brief.
```

</process>

<anti_patterns>

- **Re-interviewing the user.** Use context, not fresh questions. If something is missing, put it in Open Questions.
- **Listing implementation tasks.** The brief describes outcomes and decisions — the roadmap and plans describe tasks.
- **Citing specific line numbers.** They rot. Cite modules or interfaces.
- **Inventing risks or decisions.** If the discussion didn't surface a real architectural choice, the Architectural Decisions section is short — that's fine.
- **Auto-filing the GitHub issue.** Any outward-facing action needs explicit confirmation.

</anti_patterns>

<success_criteria>

- [ ] `M###-CONTEXT.md` exists and follows the template structure.
- [ ] User-Visible Outcome section names literal user actions, not internal tasks.
- [ ] Completion Class is honest — no "just unit tests" when the milestone demands live integration.
- [ ] Every architectural decision has a rationale and named alternatives.
- [ ] Open Questions captures genuinely unresolved items — not decisions the user already made.
- [ ] `.gsd/DECISIONS.md` has a dated one-liner for any hard-to-reverse decision.

</success_criteria>
