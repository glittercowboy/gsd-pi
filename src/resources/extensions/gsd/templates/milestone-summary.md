---
id: {{milestoneId}}
provides:
  - {{whatThisMilestoneProvides}}
key_decisions:
  - {{decision}}
patterns_established:
  - {{pattern}}
observability_surfaces:
  - {{status endpoint, structured log, persisted failure state, diagnostic command, or none}}
requirement_outcomes:
  - id: {{requirementId}}
    from_status: {{active|blocked|deferred}}
    to_status: {{validated|deferred|blocked|out_of_scope}}
    proof: {{whatEvidenceSupportsThisTransition}}
duration: {{duration}}
verification_result: passed
completed_at: {{date}}
---

# {{milestoneId}}: {{milestoneTitle}}

<!-- One-liner must say what the milestone actually delivered, not just that it completed.
     Good: "State machine integrity with completing-milestone gating, doctor audits, and observability validation"
     Bad: "Milestone 2 completed" -->

**{{oneLiner}}**

## What Happened

<!-- Cross-slice narrative: compress all slice summaries into a coherent story.
     Focus on what was built, how the slices connected, and what the milestone
     achieved as a whole — not a task-by-task replay. -->

{{crossSliceNarrative}}

## Cross-Slice Verification

<!-- How were the milestone's success criteria verified?
     Reference specific tests, commands, browser checks, or observable behaviors.
     Each success criterion from the roadmap should have a corresponding verification entry. -->

{{howSuccessCriteriaWereVerified}}

## Requirement Changes

<!-- Transitions with evidence. Each requirement that changed status during this milestone
     should be listed with the proof that supports the transition. -->

- {{requirementId}}: {{fromStatus}} → {{toStatus}} — {{evidence}}

## Decision Re-evaluation

<!-- Review decisions from this milestone. OMIT if no decisions need re-evaluation. -->

| Decision | Original Rationale | Still Valid? | Action |
|----------|-------------------|-------------|--------|
| {{decisionId}} | {{originalRationale}} | {{yes/no/partially}} | {{keep/revise/supersede}} |

## Forward Intelligence

<!-- Write what you wish you'd known at the start of this milestone.
     This section is read by the next milestone's planning and research steps.
     Be specific and concrete — this is the most valuable context you can transfer. -->

### What the next milestone should know
- {{insightThatWouldHelpDownstreamWork}}

### What's fragile
- {{fragileAreaOrThinImplementation}} — {{whyItMatters}}

### Authoritative diagnostics
- {{whereAFutureAgentShouldLookFirst}} — {{whyThisSignalIsTrustworthy}}

### What assumptions changed
- {{originalAssumption}} — {{whatActuallyHappened}}

## Files Created/Modified

- `{{filePath}}` — {{description}}
- `{{filePath}}` — {{description}}
