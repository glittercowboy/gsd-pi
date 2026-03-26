# Headless Milestone Creation

You are creating a GSD milestone from a provided specification document. This is a **headless** (non-interactive) flow — do NOT ask the user any questions. Wherever the interactive flow would ask the user, make your best-judgment call and document it as an assumption.

## Provided Specification

{{seedContext}}

## Reflection Step

Summarize your understanding of the specification concretely — not abstractly:

1. Summarize what is being built in your own words.
2. Give an honest size read: roughly how many milestones, roughly how many slices in the first one. Base this on the actual work involved, not a classification label.
3. Include scope honesty — a bullet list of the major capabilities: "Here's what I'm reading from the spec: [bullet list of major capabilities]."
4. Note any ambiguities, gaps, or areas where the spec is vague.

Print this reflection in chat. Do not skip this step.

## Vision Mapping

Decide the approach based on the actual scope:

**If the work spans multiple milestones:** Map the full landscape:
1. Propose a milestone sequence — names, one-line intents, rough dependencies
2. Print this in chat as the working milestone sequence

**If the work fits in a single milestone:** Proceed directly to investigation.

**Anti-reduction rule:** If the spec describes a big vision, plan the big vision. Do not reduce scope. Phase complex/risky work into later milestones — do not cut it. The spec's ambition is the target, and your job is to sequence it intelligently, not shrink it.

## Mandatory Investigation

Do a mandatory investigation pass before making any decisions. This is not optional.

1. **Scout the codebase** — `ls`, `find`, `rg`, or `scout` for broad unfamiliar areas. Understand what already exists, what patterns are established, what constraints current code imposes.
2. **Check library docs** — `resolve_library` / `get_library_docs` for any tech mentioned in the spec. Get current facts about capabilities, constraints, API shapes, version-specific behavior.
3. **Web search** — `search-the-web` if the domain is unfamiliar, if you need current best practices, or if the spec references external services/APIs you need facts about. Use `fetch_page` for full content when snippets aren't enough.

**Web search budget:** Budget carefully across investigation + focused research:
- Prefer `resolve_library` / `get_library_docs` over `web_search` for library documentation.
- Prefer `search_and_read` for one-shot topic research.
- Target 2-3 web searches in this investigation pass. Save remaining budget for focused research.
- Do NOT repeat the same or similar queries.

The goal: your decisions should reflect what's actually true in the codebase and ecosystem, not what you assume.

## Autonomous Decision-Making

For every area where the spec is ambiguous, vague, or silent:

- Apply the depth checklist (below) to identify what needs resolution
- Make your best-judgment call based on: the spec's intent, codebase patterns, domain conventions, and investigation findings
- **Document every assumption** in the Context file under an "Assumptions" section
- For each assumption, note: what the spec said (or didn't say), what you decided, and why

### Depth Checklist

Ensure ALL of these are resolved before writing artifacts — from the spec + investigation, not by asking:

- [ ] **What is being built** — concrete enough that you could explain it to a stranger
- [ ] **Why it needs to exist** — the problem it solves or the desire it fulfills
- [ ] **Who it's for** — even if just the spec author
- [ ] **What "done" looks like** — observable outcomes, not abstract goals
- [ ] **The biggest technical unknowns / risks** — what could fail, what hasn't been proven
- [ ] **What external systems/services this touches** — APIs, databases, third-party services, hardware

If the spec leaves any of these unresolved, make your best-judgment call and document it.

## Depth Verification

Print a structured depth summary in chat covering:
- What you understood the spec to describe
- Key technical findings from investigation
- Assumptions you made and why
- Areas where you're least confident

This is your audit trail. Print it — do not skip it.

## Focused Research

Do a focused research pass before roadmap creation.

Research is advisory, not auto-binding. Use the spec + investigation to identify:
- table stakes the product space usually expects
- domain-standard behaviors that may be implied but not stated
- likely omissions that would make the product feel incomplete
- plausible anti-features or scope traps
- differentiators worth preserving

For multi-milestone visions, research should cover the full landscape, not just the first milestone. Research findings may affect milestone sequencing, not just slice ordering within M001.

**Key difference from interactive flow:** Where the interactive flow would present research-surfaced candidate requirements for the user to confirm/defer/reject, you instead apply your best judgment. If a research finding clearly aligns with the spec's intent, include it. If it's tangential or would expand scope beyond what the spec describes, defer it or mark it out of scope. Document the reasoning.

## Capability Contract

Before writing a roadmap, produce `.gsd/REQUIREMENTS.md`.

Use it as the project's explicit capability contract.

Requirements must be organized into:
- Active
- Validated
- Deferred
- Out of Scope
- Traceability

Each requirement should include:
- stable ID (`R###`)
- title
- class
- status
- description
- why it matters
- source (`spec`, `inferred`, `research`, or `execution`)
- primary owning slice
- supporting slices
- validation status
- notes

Rules:
- Keep requirements capability-oriented, not a giant feature inventory
- Every Active requirement must either be mapped to a roadmap owner, explicitly deferred, blocked with reason, or moved out of scope
- Product-facing work should capture launchability, primary user loop, continuity, and failure visibility when relevant
- Later milestones may have provisional ownership, but the first planned milestone should map requirements to concrete slices wherever possible

For multi-milestone projects, requirements should span the full vision. Requirements owned by later milestones get provisional ownership. The full requirement set captures the spec's complete vision — milestones are the sequencing strategy, not the scope boundary.

**Print the requirements in chat before writing the roadmap.** Print a markdown table with columns: ID, Title, Status, Owner, Source. Group by status (Active, Deferred, Out of Scope).

## Scope Assessment

Confirm the size estimate from your reflection still holds. Investigation and research often reveal hidden complexity or simplify things. If the scope grew or shrank significantly, adjust the milestone and slice counts accordingly.

## Output Phase

### Roadmap Preview

Before writing any files, **print the planned roadmap in chat**. Print a markdown table with columns: Slice, Title, Risk, Depends, Demo. One row per slice. Below the table, print the milestone definition of done as a bullet list.

This is the user's audit trail in the TUI scrollback — do not skip it.

### Naming Convention

Directories use bare IDs. Files use ID-SUFFIX format. Titles live inside file content, not in names.
- Milestone dir: `.gsd/milestones/{{milestoneId}}/`
- Milestone files: `{{milestoneId}}-CONTEXT.md`, `{{milestoneId}}-ROADMAP.md`
- Slice dirs: `S01/`, `S02/`, etc.

### Single Milestone

In a single pass:
1. `mkdir -p .gsd/milestones/{{milestoneId}}/slices`
2. Write or update `.gsd/PROJECT.md` — use the **Project** output template below. Describe what the project is, its current state, and list the milestone sequence.
3. Write or update `.gsd/REQUIREMENTS.md` — use the **Requirements** output template below. Confirm requirement states, ownership, and traceability before roadmap creation.

**Depth-Preservation Guidance for context.md:**
Preserve the specification's exact terminology, emphasis, and specific framing. Do not paraphrase domain-specific language into generics. If the spec said "craft feel," write "craft feel" — not "high-quality user experience." The context file is downstream agents' only window into this conversation — flattening specifics into generics loses the signal that shaped every decision.

4. Write `{{contextPath}}` — use the **Context** output template below. Preserve key risks, unknowns, existing codebase constraints, integration points, and relevant requirements surfaced during research. Include an "Assumptions" section documenting every judgment call.
5. Call `gsd_plan_milestone` to create the roadmap. Decompose into demoable vertical slices with risk, depends, demo sentences, proof strategy, verification classes, milestone definition of done, requirement coverage, and a boundary map. If the milestone crosses multiple runtime boundaries, include an explicit final integration slice that proves the assembled system works end-to-end in a real environment. Use the **Roadmap** output template below to structure the tool call parameters.
6. For each architectural or pattern decision, call `gsd_decision_save` — the tool auto-assigns IDs and regenerates `.gsd/DECISIONS.md` automatically.
7. {{commitInstruction}}

After writing the files, say exactly: "Milestone {{milestoneId}} ready." — nothing else. Auto-mode will start automatically.

### Multi-Milestone

#### Phase 1: Shared artifacts

1. For each milestone, call `gsd_milestone_generate_id` to get its ID — never invent milestone IDs manually. Then `mkdir -p .gsd/milestones/<ID>/slices` for each.
2. Write `.gsd/PROJECT.md` — use the **Project** output template below.
3. Write `.gsd/REQUIREMENTS.md` — use the **Requirements** output template below. Capture Active, Deferred, Out of Scope, and any already Validated requirements. Later milestones may have provisional ownership where slice plans do not exist yet.
4. For any architectural or pattern decisions, call `gsd_decision_save` — the tool auto-assigns IDs and regenerates `.gsd/DECISIONS.md` automatically.

#### Phase 2: Primary milestone

5. Write a full `CONTEXT.md` for the primary milestone (the first in sequence). Include an "Assumptions" section.
6. Call `gsd_plan_milestone` for **only the primary milestone** — detail-planning later milestones now is waste because the codebase will change. Include requirement coverage and a milestone definition of done.

#### MANDATORY: depends_on Frontmatter in CONTEXT.md

Every CONTEXT.md for a milestone that depends on other milestones MUST have YAML frontmatter with `depends_on`. The auto-mode state machine reads this field to determine execution order — without it, milestones may execute out of order or in parallel when they shouldn't.

```yaml
---
depends_on: [M001, M002]
---

# M003: Title
```

If a milestone has no dependencies, omit the frontmatter. Do NOT rely on QUEUE.md or PROJECT.md for dependency tracking — the state machine only reads CONTEXT.md frontmatter.

#### Phase 3: Remaining milestones

For each remaining milestone, in dependency order, autonomously decide the best readiness mode:

- **Write full context** — if the spec provides enough detail for this milestone and investigation confirms feasibility. Write a full `CONTEXT.md` with technical assumptions verified against the actual codebase.
- **Write draft for later** — if the spec has seed material but the milestone needs its own investigation/research in a future session. Write a `CONTEXT-DRAFT.md` capturing seed material, key ideas, provisional scope, and open questions. **Downstream:** Auto-mode pauses at this milestone and prompts the user to discuss.
- **Just queue it** — if the milestone is identified but the spec provides no actionable detail. No context file written. **Downstream:** Auto-mode pauses and starts a full discussion from scratch.

**Default to writing full context** when the spec is detailed enough. Default to draft when the spec mentions the milestone but is vague. Default to queue when the milestone is implied by the vision but not described.

**Technical Assumption Verification is still MANDATORY** for full-context milestones:
1. Read the actual code for every file or module you reference. Confirm APIs exist, check what functions actually do.
2. Check for stale assumptions — verify referenced modules still work as described.
3. Print findings in chat before writing each milestone's CONTEXT.md.

Each context file (full or draft) should be rich enough that a future agent encountering it fresh — with no memory of this conversation — can understand the intent, constraints, dependencies, what this milestone unlocks, and what "done" looks like.

#### Milestone Gate Tracking (MANDATORY for multi-milestone)

After deciding each milestone's readiness, immediately write or update `.gsd/DISCUSSION-MANIFEST.json`:

```json
{
  "primary": "M001",
  "milestones": {
    "M001": { "gate": "discussed", "context": "full" },
    "M002": { "gate": "discussed", "context": "full" },
    "M003": { "gate": "queued",    "context": "none" }
  },
  "total": 3,
  "gates_completed": 3
}
```

Write this file AFTER each gate decision, not just at the end. Update `gates_completed` incrementally. The system reads this file and BLOCKS auto-start if `gates_completed < total`.

For single-milestone projects, do NOT write this file.

#### Phase 4: Finalize

7. {{multiMilestoneCommitInstruction}}

After writing the files, say exactly: "Milestone {{milestoneId}} ready." — nothing else. Auto-mode will start automatically.

## Critical Rules

- **DO NOT ask the user any questions** — this is headless mode. Make judgment calls and document them.
- **Preserve the specification's terminology** — don't paraphrase domain-specific language
- **Document assumptions** — every judgment call gets noted in CONTEXT.md under "Assumptions" with reasoning
- **Investigate thoroughly** — scout codebase, check library docs, web search. Same rigor as interactive mode.
- **Do focused research** — identify table stakes, domain standards, omissions, scope traps. Same rigor as interactive mode.
- **Use proper tools** — `gsd_plan_milestone` for roadmaps, `gsd_decision_save` for decisions, `gsd_milestone_generate_id` for IDs
- **Print artifacts in chat** — requirements table, roadmap preview, depth summary. The TUI scrollback is the user's audit trail.
- **Use depends_on frontmatter** for multi-milestone sequences
- **Anti-reduction rule** — if the spec describes a big vision, plan the big vision. Phase complexity — don't cut it.
- **Naming convention** — always use `gsd_milestone_generate_id` for IDs. Directories use bare IDs, files use ID-SUFFIX format.
- **End with "Milestone {{milestoneId}} ready."** — this triggers auto-start detection

{{inlinedTemplates}}
