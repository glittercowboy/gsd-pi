# {{milestoneId}}: {{milestoneTitle}}

**Gathered:** {{date}}
**Status:** Ready for planning

## Project Description

{{description}}

## Why This Milestone

{{whatProblemThisSolves_AND_whyNow}}

## User-Visible Outcome

### When this milestone is complete, the user can:

- {{literalUserActionInRealEnvironment}}
- {{literalUserActionInRealEnvironment}}

### Entry point / environment

- Entry point: {{CLI command / URL / bot / extension / service / workflow}}
- Environment: {{local dev / browser / mobile / launchd / CI / production-like}}
- Live dependencies involved: {{telegram / database / webhook / rpc subprocess / none}}

## Completion Class

- Contract complete means: {{what can be proven by tests / fixtures / artifacts}}
- Integration complete means: {{what must work across real subsystems}}
- Operational complete means: {{what must work under real lifecycle conditions, or none}}

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- {{one real end-to-end scenario}}
- {{one real end-to-end scenario}}
- {{what cannot be simulated if this milestone is to be considered truly done}}

## Architectural Decisions

### {{decisionTitle}}

**Decision:** {{decisionStatement}}

**Rationale:** {{rationale}}

**Alternatives Considered:**
- {{alternative}} — {{whyNotChosen}}

---

> Add additional decisions as separate `### Decision Title` blocks following the same structure above.
> See `.gsd/DECISIONS.md` for the full append-only register of all project decisions.

## Error Handling Strategy

{{errorHandlingStrategy}}

> Describe the approach for handling failures, edge cases, and error propagation. Include retry policies, fallback behaviors, and user-facing error messages where relevant.

## Risks and Unknowns

- {{riskOrUnknown}} — {{whyItMatters}}

## Existing Codebase / Prior Art

- `{{fileOrModule}}` — {{howItRelates}}
- `{{fileOrModule}}` — {{howItRelates}}

## Relevant Requirements

- {{requirementId}} — {{howThisMilestoneAdvancesIt}}

## Scope

### In Scope

- {{inScopeItem}}

### Out of Scope / Non-Goals

- {{outOfScopeItem}}

## Technical Constraints

- {{constraint}}

## Integration Points

- {{systemOrService}} — {{howThisMilestoneInteractsWithIt}}

## Testing Requirements

{{testingRequirements}}

> Specify test types (unit, integration, e2e), coverage expectations, and specific test scenarios that must pass.

## Acceptance Criteria

{{acceptanceCriteria}}

> Per-slice acceptance criteria gathered during discussion. Each slice should have clear, testable criteria.

## Open Questions

- {{question}} — {{currentThinking}}
