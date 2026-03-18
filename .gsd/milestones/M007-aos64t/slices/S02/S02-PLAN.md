# S02: Live Reroute Proof Run

**Goal:** The assembled runtime path proves coordinator artifact writing, planner reroute, and corrected evidence injection in one live scenario.
**Demo:** A test exercises the real auto-dispatch rule and auto-prompts builder with S01 fixture data, proving: (1) dispatch reroutes to plan-slice when FACTCHECK-STATUS.json has planImpacting=true, (2) the regenerated plan-slice prompt contains the corrected evidence value "5.2.0" from the refuted claim.

## Must-Haves

- A dispatch rule in auto-dispatch.ts that reads FACTCHECK-STATUS.json and reroutes to plan-slice when planImpacting is true
- Factcheck evidence injection in buildPlanSlicePrompt that includes aggregate status and REFUTED claim annotations with corrected values
- A live integration test that exercises both paths with S01 deterministic fixture data
- Proof artifacts written to disk showing the reroute action and the corrected-evidence prompt content

## Proof Level

- This slice proves: integration
- Real runtime required: yes (real dispatch rules and prompt builders, not mocks)
- Human/UAT required: no

## Verification

- `node --test src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts` — all tests pass
- Test asserts dispatch rule returns `action: "dispatch", unitType: "plan-slice"` when FACTCHECK-STATUS.json has planImpacting=true
- Test asserts generated prompt contains "5.2.0" (corrected value from C001)
- Test asserts generated prompt contains "REFUTED" or equivalent fact-check evidence section
- Test writes proof artifacts (reroute action JSON, prompt excerpt) to temp dir for S03 consumption

## Observability / Diagnostics

- Runtime signals: dispatch rule match name identifies factcheck reroute path; prompt builder includes factcheck section header for grep-ability
- Inspection surfaces: FACTCHECK-STATUS.json in slice factcheck/ directory; test writes proof artifacts to temp dir
- Failure visibility: test output shows which stage failed (dispatch-rule-match, prompt-generation, evidence-injection); FixtureValidationError shape from S01
- Redaction constraints: synthetic data only, no secrets or PII

## Integration Closure

- Upstream surfaces consumed: S01 fixture data (FIXTURE-MANIFEST.json, FACTCHECK-STATUS.json, claim annotations), auto-dispatch.ts dispatch rule table, auto-prompts.ts buildPlanSlicePrompt
- New wiring introduced in this slice: factcheck-reroute dispatch rule, factcheck evidence injection in plan-slice prompt builder
- What remains before the milestone is truly usable end-to-end: S03 durable validation artifacts and closeout report

## Tasks

- [x] **T01: Wire factcheck reroute dispatch rule and corrected-evidence prompt injection** `est:1h`
  - Why: The dispatch table has no factcheck-aware rule and the plan-slice prompt builder doesn't inject corrected evidence. Without these, the runtime path cannot reroute or inform the planner.
  - Files: `src/resources/extensions/gsd/auto-dispatch.ts`, `src/resources/extensions/gsd/auto-prompts.ts`
  - Do: (1) Add a dispatch rule before "planning → plan-slice" that checks for FACTCHECK-STATUS.json with planImpacting=true in the active slice's factcheck/ dir; when found, dispatch plan-slice with a flag indicating factcheck reroute. (2) In buildPlanSlicePrompt, read FACTCHECK-STATUS.json and REFUTED claim annotation files from the slice factcheck/ dir; format them as an inlined "Fact-Check Evidence" section in the prompt. (3) Use the same path resolution patterns already in auto-dispatch.ts and auto-prompts.ts. Do NOT add new npm dependencies.
  - Verify: `npx tsc --noEmit` passes (or has only pre-existing errors); the new dispatch rule name appears in grep of auto-dispatch.ts; buildPlanSlicePrompt references factcheck evidence.
  - Done when: auto-dispatch.ts has a named "factcheck-reroute" rule and auto-prompts.ts buildPlanSlicePrompt conditionally includes fact-check evidence when FACTCHECK-STATUS.json exists with refutations.

- [ ] **T02: Write live integration test proving dispatch reroute and corrected-evidence prompt** `est:1h30m`
  - Why: The production code from T01 must be proven with a live test using S01 deterministic fixtures. This is the core proof artifact for the milestone.
  - Files: `src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts`
  - Do: (1) Create test file that copies S01 fixture data to an isolated temp dir mimicking a real .gsd/ layout. (2) Test the dispatch rule: construct a DispatchContext with phase "planning" and an active slice whose factcheck/ dir contains FACTCHECK-STATUS.json with planImpacting=true; call the rule's match function; assert it returns action "dispatch" with unitType "plan-slice". (3) Test prompt injection: call buildPlanSlicePrompt with the temp dir as base; assert the returned prompt contains "5.2.0" and a factcheck evidence section. (4) Test negative case: remove FACTCHECK-STATUS.json and verify the dispatch rule falls through (returns null). (5) Write proof artifacts (reroute action JSON, prompt excerpt with corrected value) to a proof-output/ subdir in the temp dir. (6) Follow S01 determinism constraints: no network calls, synthetic data only, use FixtureValidationError shape for failures. Skills to load: none required beyond node:test.
  - Verify: `node --test src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts` exits 0 with all tests passing
  - Done when: All tests pass proving (a) dispatch reroutes on planImpacting, (b) prompt contains corrected value "5.2.0", (c) negative case falls through, (d) proof artifacts written to disk.

## Files Likely Touched

- `src/resources/extensions/gsd/auto-dispatch.ts`
- `src/resources/extensions/gsd/auto-prompts.ts`
- `src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts`
