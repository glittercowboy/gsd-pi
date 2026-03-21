---
id: {{sliceId}}
parent: {{milestoneId}}
milestone: {{milestoneId}}
provides:
  - {{whatThisSliceProvides}}
requires:
  - slice: {{depSliceId}}
    provides: {{whatWasConsumed}}
affects:
  - {{downstreamSliceId}}
key_files:
  - {{filePath}}
key_decisions:
  - {{decision}}
patterns_established:
  - {{pattern}}
observability_surfaces:
  - {{status endpoint, structured log, persisted failure state, diagnostic command, or none}}
drill_down_paths:
  - {{pathToTaskSummary}}
duration: {{duration}}
verification_result: passed
completed_at: {{date}}
---

# {{sliceId}}: {{sliceTitle}}

<!-- One-liner must say what actually shipped, not just that work completed.
     Good: "Structured job status endpoint with persisted failure diagnostics"
     Bad: "Status feature implemented" -->

**{{oneLiner}}**

## What Happened

{{narrative — compress task summaries into a coherent story}}

## Verification

{{whatWasVerifiedAcrossAllTasks — tests, builds, manual checks}}

<!-- If the project has no REQUIREMENTS.md, omit all four requirement sections below entirely — do not fill them with "none". These sections only apply when requirements are being actively tracked. -->
## Requirements Advanced

- {{requirementId}} — {{howThisSliceAdvancedIt}}

## Requirements Validated

- {{requirementId}} — {{whatProofNowMakesItValidated}}

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Deviations

<!-- Deviations are unplanned changes to the written plan, not ordinary debugging inside the plan's intended scope. -->

None.

## Known Limitations

<!-- Known limitations are real gaps, rough edges, or deferred constraints that still exist after this slice shipped. -->

None.

## Follow-ups

<!-- Follow-ups are concrete next actions discovered during execution, not a restatement of known limitations. -->

None.

## Files Created/Modified

- `{{filePath}}` — {{description}}
- `{{filePath}}` — {{description}}

## Forward Intelligence

<!-- Write what you wish you'd known at the start of this slice.
     This section is read by the next slice's planning and research steps.
     Be specific and concrete — this is the most valuable context you can transfer. -->

### What the next slice should know
- {{insightThatWouldHelpDownstreamWork}}

### What's fragile
- {{fragileAreaOrThinImplementation}} — {{whyItMatters}}

### Authoritative diagnostics
- {{whereAFutureAgentShouldLookFirst}} — {{whyThisSignalIsTrustworthy}}

### What assumptions changed
- {{originalAssumption}} — {{whatActuallyHappened}}
