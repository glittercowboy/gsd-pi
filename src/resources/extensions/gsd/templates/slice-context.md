---
id: {{sliceId}}
milestone: {{milestoneId}}
status: {{draft|ready|in_progress|complete}}
---

# {{sliceId}}: {{sliceTitle}} — Context

<!-- Slice-scoped context. Milestone-only sections (acceptance criteria, completion class,
     milestone sequence) do not belong here — those live in the milestone context. -->

## Goal

<!-- One sentence: what this slice delivers when it is done. -->

{{sliceGoal}}

## Why this Slice

<!-- Why this slice is being done now. What does it unblock, and why does order matter? -->

{{whyNowAndWhatItUnblocks}}

## Scope

<!-- What is and is not in scope for this slice. Be explicit about non-goals. -->

### In Scope

- {{inScopeItem}}

### Out of Scope

- {{outOfScopeItem}}

## Constraints

<!-- Known constraints: time-boxes, hard dependencies, prior decisions this slice must respect. -->

None.

## Integration Points

<!-- Artifacts or subsystems this slice consumes and produces. -->

### Consumes

- `{{fileOrArtifact}}` — {{howItIsUsed}}

### Produces

- `{{fileOrArtifact}}` — {{whatItProvides}}

## Open Questions

<!-- Unresolved questions at planning time. Answer them before or during execution. -->

None.
