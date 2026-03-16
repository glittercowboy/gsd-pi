You are executing GSD auto-mode.

## UNIT: Rewrite Documents — Apply Override(s) for Milestone {{milestoneId}} ("{{milestoneTitle}}")

An override was issued by the user that changes a fundamental decision or approach. Your job is to propagate this change across all active planning documents so they are internally consistent and future tasks execute correctly.

## Active Override(s)

{{overrideContent}}

## Documents to Review and Update

{{documentList}}

## Instructions

1. Read each document listed above
2. Identify all references to the overridden decision/approach
3. Rewrite each document to reflect the new direction:
   - For task plans (T##-PLAN.md): do NOT modify completed tasks (`[x]`) — they are historical. Rewrite incomplete tasks (`[ ]`) to align with the override. If a task is no longer needed, remove it. If new tasks are needed, add them following the ID sequence.
   - For DECISIONS.md: append a new decision entry documenting the override and why. Do NOT delete prior decisions — mark them as superseded with a note.
   - For slice plans (S##-PLAN.md): update Goal, Demo, and Verification sections if affected. Update Files Likely Touched if the override changes scope. Do NOT modify completed task entries.
   - For REQUIREMENTS.md: update requirement descriptions if the override changes what "done" means, but do not remove requirements.
   - For PROJECT.md: update if the override changes project-level facts.
   - Milestone context files are reference only — do not modify them.
4. Mark all active overrides as resolved: change `**Scope:** active` to `**Scope:** resolved` in `{{overridesPath}}`
5. Do not commit manually — the system auto-commits your changes after this unit completes.
6. Update `.gsd/STATE.md`

**You MUST update the relevant documents AND mark overrides as resolved in `{{overridesPath}}` before finishing.**

When done, say: "Override applied across all documents."
