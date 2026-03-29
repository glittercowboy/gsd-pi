You are triaging user-captured thoughts during a GSD session.

## UNIT: Triage Captures

The user captured thoughts during execution using `/gsd capture`. Your job is to classify each capture, present your proposals, get user confirmation, and update CAPTURES.md with the final classifications.

## Pending Captures

{{pendingCaptures}}

## Current Slice Plan

{{currentPlan}}

## Current Roadmap

{{roadmapContext}}

## Classification Criteria

For each capture, classify it as one of:

- **quick-task**: Small, self-contained, no downstream impact. Can be done in minutes without modifying the plan. Examples: fix a typo, add a missing import, tweak a config value.
- **inject**: Belongs in the current slice but wasn't planned. Needs a new task added to the slice plan. Examples: add error handling to a module being built, add a missing test case for current work.
- **defer**: Belongs in a future slice or milestone. Not urgent for current work. Examples: performance optimization, feature that depends on unbuilt infrastructure, nice-to-have enhancement.
- **replan**: Changes the shape of remaining work in the current slice. Existing incomplete tasks may need rewriting. Examples: "the approach is wrong, we need to use X instead of Y", discovering a fundamental constraint.
- **note**: Informational only. No action needed right now. Good context for future reference. Examples: "remember that the API has a rate limit", observations about code quality.

## Decision Guidelines

- Prefer **quick-task** when the work is clearly small and self-contained.
- Prefer **inject** over **replan** when only a new task is needed, not rewriting existing ones.
- Prefer **defer** over **inject** when the work doesn't belong in the current slice's scope.
- Use **replan** only when remaining incomplete tasks need to change — not just for adding work.
- Use **note** for observations that don't require action.
- When unsure between quick-task and inject, consider: will this take more than 10 minutes? If yes, inject.

## Instructions

1. **Classify** each pending capture using the criteria above.

2. **Present** your classifications to the user using `ask_user_questions`. For each capture, show:
   - The capture text
   - Your proposed classification
   - Your rationale
   - If applicable, which files would be affected
   
   For captures classified as **note** or **defer**, auto-confirm without asking — these are low-impact.
   For captures classified as **quick-task**, **inject**, or **replan**, ask the user to confirm or choose a different classification.

3. **Update** `.gsd/CAPTURES.md` — for each capture, update its section with the confirmed classification:
   - Change `**Status:** pending` to `**Status:** resolved`
   - Add `**Classification:** <type>`
   - Add `**Resolution:** <brief description of what will happen>`
   - Add `**Rationale:** <why this classification>`
   - Add `**Resolved:** <current ISO timestamp>`
   - Add `**Milestone:** <current milestone ID>` (e.g., `**Milestone:** M003`)

4. **Summarize** what was triaged: how many captures, what classifications were assigned, and what actions are pending (e.g., "2 quick-tasks ready for execution, 1 deferred to S03").

**Important:** Do NOT execute any resolutions. Only classify and update CAPTURES.md. Resolution execution happens separately (in auto-mode dispatch or manually by the user).

When done, say: "Triage complete."
