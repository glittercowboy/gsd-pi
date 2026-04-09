# {{milestoneId}}: {{milestoneTitle}}

**Gathered:** {{date}}
**Status:** Ready for planning

## Project Description

{{description}}

## Why This Milestone

{{whatProblemThisSolves_AND_whyNow}}

## Codebase Brief

### Technology Stack

{{techStack}}

### Key Modules

{{keyModules}}

### Patterns in Use

{{patternsInUse}}

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

## Architectural Decisions

### {{decisionTitle}}

**Decision:** {{decisionStatement}}

**Rationale:** {{rationale}}

**Evidence:** {{evidence}}

**Alternatives Considered:**
- {{alternative1}} — {{whyNotChosen1}}
- {{alternative2}} — {{whyNotChosen2}}

---

> Add additional decisions as separate `### Decision Title` blocks following the same structure above.

## Interface Contracts

{{interfaceContracts}}

> Document API boundaries, function signatures, data shapes, or protocol agreements that must be honored. Leave blank or remove if not applicable to this milestone.

## Error Handling Strategy

{{errorHandlingStrategy}}

> Describe the approach for handling failures, edge cases, and error propagation. Include retry policies, fallback behaviors, and user-facing error messages where relevant.

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- {{one real end-to-end scenario}}
- {{one real end-to-end scenario}}
- {{what cannot be simulated if this milestone is to be considered truly done}}

## Testing Requirements

{{testingRequirements}}

> Specify test types (unit, integration, e2e), coverage expectations, and any specific test scenarios that must pass.

## Acceptance Criteria

{{acceptanceCriteria}}

> Per-slice acceptance criteria gathered during discussion. Each slice should have clear, testable criteria.

## Risks and Unknowns

- {{riskOrUnknown}} — {{whyItMatters}}

## Existing Codebase / Prior Art

- `{{fileOrModule}}` — {{howItRelates}}
- `{{fileOrModule}}` — {{howItRelates}}

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

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

## Ecosystem Notes

{{ecosystemNotes}}

> Research findings, best practices, known issues, and relevant external documentation discovered during preparation.

## Open Questions

- {{question}} — {{currentThinking}}
