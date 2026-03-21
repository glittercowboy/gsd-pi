---
id: {{taskId}}
parent: {{sliceId}}
milestone: {{milestoneId}}
provides:
  - {{whatThisTaskProvides}}
key_files:
  - {{filePath}}
key_decisions:
  - {{decision}}
patterns_established:
  - {{pattern}}
observability_surfaces:
  - {{status endpoint, structured log, persisted failure state, diagnostic command, or none}}
duration: {{duration}}
verification_result: passed
completed_at: {{date}}
# Set blocker_discovered: true only if execution revealed the remaining slice plan
# is fundamentally invalid (wrong API, missing capability, architectural mismatch).
# Do NOT set true for ordinary bugs, minor deviations, or fixable issues.
blocker_discovered: false
---

# {{taskId}}: {{taskTitle}}

<!-- One-liner must say what actually shipped, not just that work completed.
     Good: "Added retry-aware worker status logging"
     Bad: "Implemented logging improvements" -->

**{{oneLiner}}**

## What Happened

{{narrative}}

## Verification

{{whatWasVerifiedAndHow — commands run, tests passed, behavior confirmed}}

## Verification Evidence

<!-- Populated from verification gate output. If the gate ran, fill in the table below.
     If no gate ran (e.g., no verification commands discovered), note that. -->

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| {{row}} | {{command}} | {{exitCode}} | {{verdict}} | {{duration}} |

## Diagnostics

{{howToInspectWhatThisTaskBuiltLater — status surfaces, logs, error shapes, failure artifacts, or none}}

## Deviations

<!-- Deviations are unplanned changes to the written task plan, not ordinary debugging during implementation. -->

None.

## Known Issues

None.

## Files Created/Modified

- `{{filePath}}` — {{description}}
- `{{filePath}}` — {{description}}
