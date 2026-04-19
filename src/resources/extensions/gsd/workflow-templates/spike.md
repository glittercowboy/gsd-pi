# Research Spike Workflow

<template_meta>
name: spike
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/spikes/
</template_meta>

<purpose>
Investigate a question, evaluate options, prototype if needed, and produce a
clear recommendation. No production code is shipped — the output is knowledge.
Use for: technology evaluation, architecture decisions, "should we X?" questions.
</purpose>

<phases>
1. scope      — Define the question and success criteria
2. research   — Investigate from multiple angles
3. synthesize — Combine findings into a recommendation
</phases>

<process>

## Phase 1: Scope

**Goal:** Define exactly what we're investigating and what a good answer looks like.

1. **Frame the question:** What specific question(s) need answering?
2. **Define success criteria:** What would a useful answer include?
   - Comparison criteria (performance, DX, maintenance, ecosystem, etc.)
   - Constraints (must integrate with X, must support Y)
   - Decision format (go/no-go, pick from options, tradeoff matrix)
3. **Identify research angles:** 2-3 distinct approaches to investigate:
   - e.g., "evaluate library A", "evaluate library B", "evaluate building our own"
   - e.g., "performance implications", "DX implications", "migration path"
4. **Produce:** Write `SCOPE.md` in the artifact directory

5. **Gate:** Confirm scope and research angles with user.

## Phase 2: Research

**Goal:** Investigate each angle thoroughly.

1. For each research angle:
   - Search for relevant documentation, benchmarks, comparisons
   - Read relevant source code in the project
   - Build small prototypes or proof-of-concepts if needed
   - Note pros, cons, risks, and unknowns
2. **Produce:** Write a research doc per angle in `research/` subdirectory:
   - `research/ANGLE-1.md`, `research/ANGLE-2.md`, etc.
   - Each doc: findings, evidence, pros/cons, confidence level

## Phase 3: Synthesize

**Goal:** Combine findings into a clear recommendation.

1. **Compare across angles:** Build a comparison matrix or summary table
2. **Make a recommendation:** Based on the evidence, what should we do?
   - Primary recommendation with rationale
   - Alternative if the primary doesn't work out
   - What would change the recommendation (risk factors)
3. **Produce:** Write `RECOMMENDATION.md` with:
   - Executive summary (1-2 paragraphs)
   - Comparison matrix
   - Recommendation with rationale
   - Next steps if the recommendation is accepted
4. **Present** the recommendation to the user for discussion
5. **Offer wrap-up:** If the findings are reusable on future work, offer to run
   the `spike-wrap-up` skill to package them as a project-local skill at
   `.claude/skills/<name>/SKILL.md`. That skill will auto-load on future
   similar tasks via `skill-discovery.ts`. If the recommendation is
   decision-only (no reusable guidance), suggest appending a one-liner to
   `.gsd/DECISIONS.md` instead.

</process>
