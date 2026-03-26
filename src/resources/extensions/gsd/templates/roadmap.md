# {{milestoneId}}: {{milestoneTitle}}

**Vision:** {{vision}}

## Success Criteria

<!-- Write success criteria as observable truths, not implementation tasks.
     Prefer user-visible or runtime-visible outcomes that can be re-checked at
     milestone completion.

     Good:
     - "User can complete the full import flow end-to-end"
     - "The daemon reconnects automatically after restart"

     Bad:
     - "Add import API and UI"
     - "Refactor reconnect logic" -->

- {{criterion}}
- {{criterion}}

## Key Risks / Unknowns

<!-- List the real risks and uncertainties that shape how slices are ordered.
     If the project is straightforward, this section can be short or empty.
     Don't invent risks — only list things that could actually invalidate downstream work. -->

- {{risk}} — {{whyItMatters}}
- {{risk}} — {{whyItMatters}}

## Proof Strategy

<!-- For each real risk above, name which slice retires it and what "proven" looks like.
     Proof comes from building the real thing, not from spikes or research.
     Skip this section for straightforward projects with no major unknowns. -->

- {{riskOrUnknown}} → retire in {{sliceId}} by proving {{whatWillBeProven}}
- {{riskOrUnknown}} → retire in {{sliceId}} by proving {{whatWillBeProven}}

## Verification Classes

- Contract verification: {{tests / shell verifiers / fixtures / artifact checks}}
- Integration verification: {{real subsystem interaction that must be exercised, or none}}
- Operational verification: {{service lifecycle / restart / reconnect / supervision / deploy-install behavior, or none}}
- UAT / human verification: {{what needs real human judgment, or none}}

## Milestone Definition of Done

This milestone is complete only when all are true:

- {{all slice deliverables are complete}}
- {{shared components are actually wired together}}
- {{the real entrypoint exists and is exercised}}
- {{success criteria are re-checked against live behavior, not just artifacts}}
- {{final integrated acceptance scenarios pass}}

## Requirement Coverage

- Covers: {{R001, R002}}
- Partially covers: {{R003 or none}}
- Leaves for later: {{R004 or none}}
- Orphan risks: {{none or what is still unmapped}}

## Slices

- [ ] **S01: {{sliceTitle}}** `risk:high` `depends:[]`
  > After this: {{whatIsDemoableWhenThisSliceIsDone}}
- [ ] **S02: {{sliceTitle}}** `risk:medium` `depends:[S01]`
  > After this: {{whatIsDemoableWhenThisSliceIsDone}}
- [ ] **S03: {{sliceTitle}}** `risk:low` `depends:[S01]`
  > After this: {{whatIsDemoableWhenThisSliceIsDone}}

<!--
  Format rules (parsers depend on this exact structure):
  - Checkbox line: - [ ] **S01: Title** `risk:high|medium|low` `depends:[S01,S02]`
  - Demo line:     >  After this: one sentence showing what's demoable
  - Mark done:     change [ ] to [x]
  - Order slices by risk (highest first)
  - Each slice must be a vertical, demoable increment — not a layer
  - If all slices are completed exactly as written, the milestone's promised outcome should actually work at the stated proof level
  - depends:[X,Y] means X and Y must be done before this slice starts

  Planning quality rules:
  - Every slice must ship real, working, demoable code — no research-only or foundation-only slices
  - Early slices should prove the hardest thing works by building through the uncertain path
  - Each slice should establish a stable surface that downstream slices can depend on
  - Demo lines should describe concrete, verifiable evidence — not vague claims
  - In brownfield projects, ground slices in existing modules and patterns
  - If a slice doesn't produce something testable end-to-end, it's probably a layer — restructure it
  - If the milestone crosses multiple runtime boundaries (for example daemon + API + UI, bot + subprocess + service manager, or extension + RPC + filesystem), include an explicit final integration slice that proves the assembled system works end-to-end in a real environment
  - Contract or fixture proof does not replace final assembly proof when the user-visible outcome depends on live wiring
  - Each "After this" line must be truthful about proof level: if only fixtures or tests prove it, say so; do not imply the user can already perform the live end-to-end behavior unless that has actually been exercised
-->

## Horizontal Checklist

<!-- Cross-cutting concerns across all slices. Check each that was considered.
     OMIT ENTIRELY for trivial milestones. -->

- [ ] Every active R### re-read against new code — still fully satisfied?
- [ ] Every D### from prior milestones re-evaluated — still valid at new scope?
- [ ] Graceful shutdown / cleanup on termination verified
- [ ] Revenue / billing path impact assessed (or N/A)
- [ ] Auth boundary documented — what's protected vs public
- [ ] Shared resource budget confirmed — connection pools, caches, rate limits hold under peak
- [ ] Reconnection / retry strategy verified for every external dependency

## Boundary Map

<!-- Be specific. Name concrete outputs: API endpoints, event payloads, shared types/interfaces,
     persisted record shapes, CLI contracts, file formats, or invariants.
     "Produces: auth system" is too vague. "Produces: session middleware that attaches
     authenticated user to request context" is useful.
     Consumes should name what downstream slices assume is already available and stable.
     If the project has a test framework, boundary contracts should ideally be exercised by tests. -->

### S01 → S02

Produces:
- {{concreteOutput — API, type, data shape, interface, or invariant}}

Consumes:
- nothing (first slice)

### S01 → S03

Produces:
- {{concreteOutput — API, type, data shape, interface, or invariant}}

Consumes:
- nothing (first slice)
