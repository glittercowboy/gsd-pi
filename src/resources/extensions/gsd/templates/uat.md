---
uat_type: {{artifact-driven | live-runtime | human-experience | mixed}}
---

# {{sliceId}}: {{sliceTitle}} — UAT

**Milestone:** {{milestoneId}}
**Written:** {{date}}

## UAT Type

<!-- The uat_type frontmatter field above is authoritative. This body section is kept for backward compatibility. -->

- UAT mode: {{artifact-driven | live-runtime | human-experience | mixed}}
- Why this mode is sufficient: {{reason}}

## Preconditions

{{whatMustBeTrueBeforeTesting — server running, data seeded, etc.}}

## Smoke Test

{{oneQuickCheckThatConfirmsTheSliceBasicallyWorks}}

## Test Cases

### 1. {{testName}}

1. {{step}}
2. {{step}}
3. **Expected:** {{expected}}

### 2. {{testName}}

1. {{step}}
2. **Expected:** {{expected}}

## Edge Cases

### {{edgeCaseName}}

1. {{step}}
2. **Expected:** {{expected}}

## Failure Signals

- {{whatWouldIndicateSomethingIsBroken — errors, missing UI, wrong data}}

## Requirements Proved By This UAT

None.

## Not Proven By This UAT

None.

## Notes for Tester

{{anythingTheHumanShouldKnow — known rough edges, things to ignore, areas needing gut check}}
