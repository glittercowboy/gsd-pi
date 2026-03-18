# M007-aos64t: Live Runtime Proof for Fact-Check Loop

**Vision:** Prove the assembled M006 fact-check correction loop in one deterministic runtime path: research-triggered fact-checking writes artifacts, causes the correct planner reroute, injects corrected evidence into the reinvoked planner, and blocks stale execution from continuing.

## Success Criteria

- A deterministic live runtime scenario triggers the fact-check coordinator after research completion and writes both per-claim annotation files and FACTCHECK-STATUS.json on disk.
- The dispatcher reroutes to `plan-slice` or `plan-milestone` from the real runtime path when a plan-impacting REFUTED claim is present.
- Verification output proves the reinvoked planner received corrected evidence through the real prompt assembly path, not just helper-level tests.
- The proof run is repeatable and leaves durable diagnostics that a future agent can inspect without reconstructing the session from memory.

## Key Risks / Unknowns

- The current test coverage may still be too synthetic — helper-level tests can pass while runtime sequencing fails.
- Coordinator/scout behavior may be nondeterministic under live execution unless the evidence source is controlled.
- A proof that relies only on console output will rot quickly; durable artifacts and assertions are needed.

## Proof Strategy

- Runtime sequencing uncertainty → retire in S01 by proving a controlled live fixture can execute the real hook + dispatch + prompt path with deterministic inputs.
- Reroute and corrected-prompt proof gap → retire in S02 by proving a live runtime pass reaches reroute and captures the reinvoked planner input with corrected evidence.
- Repeatability / future-debugging risk → retire in S03 by proving the live proof flow emits durable validation artifacts and diagnostics that can be rerun and inspected.

## Verification Classes

- Contract verification: fixture schema checks, validation artifact format checks, file existence checks
- Integration verification: real research → hook/coordinator → artifact write → dispatcher reroute → prompt assembly path
- Operational verification: repeatable proof run with durable diagnostics and explicit failure surfaces
- UAT / human verification: inspect proof report and artifacts to confirm the runtime path is auditable, or none if automated validation is sufficient

## Milestone Definition of Done

This milestone is complete only when all are true:

- A deterministic runtime fixture exists for at least one slice-impact and one milestone-impact correction scenario, or one scenario plus a justified scope decision if only one target is needed immediately.
- The real hook, dispatcher, and planner prompt code paths are exercised together by the proof flow.
- The proof output shows corrected evidence reached the reinvoked planner before stale execution continued.
- Validation artifacts and diagnostics are written to disk and are sufficient for future agents to inspect failures without replaying the entire run manually.
- The final integrated proof is re-run successfully at milestone closeout.

## Requirement Coverage

- Covers: R064, R068, R069, R070, R071
- Partially covers: R066
- Leaves for later: R073, R074
- Orphan risks: none

## Slices

- [x] **S01: Deterministic Runtime Fixture** `risk:high` `depends:[]`
  > After this: A controlled proof fixture can drive the real fact-check runtime path with known refutation inputs and stable expected outputs.
- [x] **S02: Live Reroute Proof Run** `risk:high` `depends:[S01]`
  > After this: The assembled runtime path proves coordinator artifact writing, planner reroute, and corrected evidence injection in one live scenario.
- [ ] **S03: Durable Validation and Closeout** `risk:medium` `depends:[S02]`
  > After this: The proof flow writes durable validation artifacts and milestone closeout can pass on repeatable live evidence instead of test-only inference.

## Boundary Map

### S01 → S02

Produces:
- Deterministic proof fixture inputs representing a known verifiable false claim and expected corrected outcome
- Runtime harness or controlled execution entrypoint that still exercises real hook/dispatch/prompt code
- Validation helpers for locating proof artifacts on disk

Consumes:
- nothing (first slice)

### S02 → S03

Produces:
- Live proof artifacts: claim annotation files, FACTCHECK-STATUS.json, reroute evidence, captured reinvoked planner input or equivalent validation output
- Repeatable command or test entrypoint for the proof run

Consumes:
- S01 deterministic fixture and controlled runtime harness

### S03 → milestone complete

Produces:
- Durable validation artifact/report summarizing proof-run results and diagnostic surfaces
- Closeout evidence sufficient to re-mark the M006 proof gap as resolved in project memory

Consumes:
- S02 live runtime proof outputs
