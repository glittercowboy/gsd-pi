---
name: decompose-into-slices
description: Break a plan or milestone brief into independently-grabbable vertical slices (tracer bullets). Produces slices in `M###-ROADMAP.md` by default, or GitHub issues only with explicit user confirmation. Use when asked to "break this into slices", "decompose the plan", "vertical slices", "break into issues", or when a plan is ready but needs task-level decomposition. Prefers many thin slices over few thick ones; marks dependency order explicitly.
---

<objective>
Decompose an approved plan into the smallest useful vertical slices that each cut end-to-end through every relevant layer. Primary output is the `Slices` section of `M###-ROADMAP.md` (matching the template at `src/resources/extensions/gsd/templates/roadmap.md`). Secondary output, only with explicit confirmation, is a set of GitHub issues with blocked-by relationships wired up.
</objective>

<context>
This skill runs after the brief is stable — `M###-CONTEXT.md` exists and the user has signed off on scope. It's the bridge from "we know what we're building" to "we know in what order and chunks." The vertical-slice discipline (tracer bullets) is non-negotiable here — it's the core of what makes GSD slices demoable and parallel-safe.

Typical invocation points:
- After `write-milestone-brief` (or after a `discuss` phase that produced a brief)
- When a roadmap exists but slices are too thick, too few, or poorly ordered
- When exporting the plan for external collaborators (GitHub issues)
</context>

<core_principle>
**VERTICAL, NOT HORIZONTAL.** A slice that adds "schema + API + UI + tests for feature X on one narrow path" is vertical. A slice that adds "all schemas for all features" is horizontal and is wrong. Horizontal slices destroy the demoability property that makes slice completion meaningful.

**MANY THIN, NOT FEW THICK.** If a slice could be split into two demoable pieces, split it. Thin slices retire risk earlier, parallelize better, and give the user faster feedback on whether the direction is right.

**DEPENDENCY GRAPH, NOT LINEAR LIST.** Slices that don't depend on each other should be marked that way — `depends:[]` means the slice can start immediately. The GSD engine uses this to parallelize.
</core_principle>

<process>

## Step 1: Load context

1. Read `M###-CONTEXT.md` for the active milestone — the brief is the source of truth for scope.
2. Read `M###-ROADMAP.md` if one exists — you may be refining rather than creating from scratch.
3. Read `src/resources/extensions/gsd/templates/roadmap.md` for the exact slice format. The parser depends on it.
4. If the plan came from a GitHub issue (user passed a URL or number), fetch it with `mcp__github__issue_read`.

## Step 2: Explore the codebase briefly

If you haven't yet, spawn `Agent(subagent_type=Explore)` to map the modules the milestone touches. This is fast and prevents proposing slices that don't align with the codebase's seams.

## Step 3: Draft vertical slices

Produce a draft list of slices. For each slice, capture:

- **ID:** `S01`, `S02`, ... — assigned in dependency order (earliest first).
- **Title:** short, descriptive, says what the slice delivers.
- **Risk:** `high` / `medium` / `low` — slices that retire the most uncertainty go first.
- **Depends:** `[]` or `[S01]` or `[S01,S02]` — which slices must finish first.
- **Demo line:** "After this: <what is observable when the slice is done>" — one sentence, concrete.
- **HITL vs AFK** (optional): does this slice require human interaction (architectural decision, design review), or can an agent ship it alone? Default to AFK when unsure.

### Vertical-slice rules

- Each slice cuts through every relevant layer (schema, API, UI, tests, whatever applies).
- A completed slice is demoable or verifiable on its own.
- Early slices should prove the hardest thing works — build through the uncertain path.
- If a slice doesn't produce something testable end-to-end, it's probably a layer — restructure.
- If the milestone crosses runtime boundaries (daemon + API + UI; bot + subprocess + service; extension + RPC), include an explicit final integration slice that exercises the assembled system.

## Step 4: Quiz the user

Present the draft as a numbered list with ID, title, risk, depends, demo line. Then ask (one round, not many):

1. Does the granularity feel right — too coarse or too fine?
2. Are the dependency relationships correct?
3. Should any slice be merged or split?
4. Any slices misclassified as AFK when they need human input?

Iterate on feedback until the user approves the breakdown. Do not proceed to Step 5 without explicit approval.

## Step 5: Write the roadmap

Once approved, write or update `M###-ROADMAP.md` matching the template exactly. Critical format (parsers depend on it):

```markdown
- [ ] **S01: Title** `risk:high` `depends:[]`
  > After this: one sentence showing what's demoable
- [ ] **S02: Title** `risk:medium` `depends:[S01]`
  > After this: one sentence showing what's demoable
```

Fill the rest of the template: Vision, Success Criteria, Key Risks, Proof Strategy, Verification Classes, Definition of Done, Requirement Coverage, Horizontal Checklist (omit entirely for trivial milestones), and the Boundary Map (`S01 → S02` produces/consumes blocks — be specific, name real APIs/types/invariants).

Use `write` to the path `.gsd/milestones/<MID>/<MID>-ROADMAP.md`. Do not edit checkboxes by hand during normal execution — the `gsd_*` tools own state.

## Step 6: Optionally file as GitHub issues

If the user explicitly asks (and only if — outward actions need confirmation), create one GitHub issue per slice with `mcp__github__issue_write`. Create in dependency order so "Blocked by" references can cite real issue numbers.

### Issue body template

```markdown
## Parent

#<parent-milestone-issue-number> (if applicable; otherwise omit)

## What to build

<concise description of this vertical slice — end-to-end behavior, not layer-by-layer>

## Acceptance criteria

- [ ] <criterion 1>
- [ ] <criterion 2>

## Blocked by

- Blocked by #<issue-number>
<or "None - can start immediately">

---
From milestone brief at `.gsd/milestones/<MID>/<MID>-CONTEXT.md`.
```

Do NOT close or modify any parent issue.

</process>

<anti_patterns>

- **Horizontal slices.** "S01: All schemas" / "S02: All APIs" / "S03: All UI" — destroys demoability.
- **Research-only slices.** A slice whose deliverable is a document, not working code, is a spike. Use `/gsd start spike`.
- **Foundation slices with no demo.** "Set up the base class for X" is a layer, not a slice.
- **Auto-filing GitHub issues.** Requires explicit user confirmation every time.
- **Editing roadmap checkboxes by hand later.** `gsd_*` tools own that state during execution.
- **Vague demo lines.** "Feature X is implemented" is not a demo. "User can submit the form and see the result" is.

</anti_patterns>

<success_criteria>

- [ ] Every slice is vertical — cuts end-to-end through the relevant layers.
- [ ] Every slice has a concrete, observable demo line.
- [ ] Dependency graph is explicit and correct — `depends:[]` on slices that can start immediately.
- [ ] Risk ordering puts the hardest uncertainty-retiring slices first.
- [ ] `M###-ROADMAP.md` matches the template format exactly (parsers depend on it).
- [ ] If the milestone crosses runtime boundaries, a final integration slice exists.
- [ ] GitHub issues, if filed, cite real issue numbers for blocked-by and reference the brief.

</success_criteria>
