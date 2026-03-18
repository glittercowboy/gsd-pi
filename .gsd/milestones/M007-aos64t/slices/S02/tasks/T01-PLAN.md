---
estimated_steps: 4
estimated_files: 2
---

# T01: Wire factcheck reroute dispatch rule and corrected-evidence prompt injection

**Slice:** S02 — Live Reroute Proof Run
**Milestone:** M007-aos64t

## Description

Add the production runtime code that enables fact-check-driven planner reroute. Two changes:
1. A new dispatch rule in auto-dispatch.ts that detects FACTCHECK-STATUS.json with planImpacting=true and triggers a plan-slice reroute.
2. Fact-check evidence injection in auto-prompts.ts buildPlanSlicePrompt that includes aggregate status and REFUTED claim annotations with corrected values.

The S01 fixture proved the data contract exists. This task wires the runtime code that reads it.

**Forward intelligence from S01:** ESM module resolution chain is fragile — don't add new cross-module imports with .js extensions for .ts files. Use the same import patterns already in auto-dispatch.ts and auto-prompts.ts. Pre-existing TypeScript errors in headless.ts are unrelated.

## Steps

1. In `auto-dispatch.ts`, add a new dispatch rule named `"factcheck-reroute → plan-slice"` inserted **before** the existing `"planning → plan-slice"` rule. The rule should:
   - Only match when `state.phase === "planning"` (same guard as the normal plan-slice rule)
   - Check for existence of `FACTCHECK-STATUS.json` in the active slice's `factcheck/` subdirectory using `resolveSlicePath` + `join(..., "factcheck", "FACTCHECK-STATUS.json")`
   - Read and parse the JSON; if `planImpacting === true`, dispatch `plan-slice` (same as the normal rule, so the prompt builder handles evidence injection)
   - If `planImpacting` is false or file doesn't exist, return `null` to fall through to the normal rule

2. In `auto-prompts.ts` `buildPlanSlicePrompt`, after the existing research inline but before template inlining, add a conditional fact-check evidence section:
   - Check for `FACTCHECK-STATUS.json` in the slice's `factcheck/` directory
   - If it exists and has `overallStatus === "has-refutations"`, read all claim annotation files from the `claims/` subdirectory
   - Filter to REFUTED claims and format them as an inlined section with claim ID, original claim description (from annotation notes or claim file), corrected value, and impact level
   - Include the aggregate status summary (counts, rerouteTarget)
   - Push this as a "Fact-Check Evidence" inlined section

3. Export a helper function `loadFactcheckEvidence(base: string, mid: string, sid: string)` from auto-prompts.ts (or a small factcheck-evidence.ts utility) that T02 can call directly for testing.

4. Verify: `npx tsc --noEmit 2>&1 | grep -v headless` should show no new errors. Grep for the new rule name in auto-dispatch.ts.

## Must-Haves

- [ ] Dispatch rule named "factcheck-reroute → plan-slice" exists before the normal "planning → plan-slice" rule
- [ ] Rule reads FACTCHECK-STATUS.json from the active slice's factcheck/ directory
- [ ] Rule only reroutes when planImpacting is true
- [ ] buildPlanSlicePrompt includes fact-check evidence section when REFUTED claims exist
- [ ] Corrected values from REFUTED claims appear in the generated prompt text
- [ ] No new npm dependencies added

## Verification

- `grep -n "factcheck-reroute" src/resources/extensions/gsd/auto-dispatch.ts` returns the rule
- `grep -n "Fact-Check Evidence\|factcheck\|FACTCHECK" src/resources/extensions/gsd/auto-prompts.ts` shows evidence injection code
- `npx tsc --noEmit 2>&1 | grep -c "error TS"` shows same count as before (pre-existing errors only)
- S01 fixture tests still pass: `node --test src/resources/extensions/gsd/tests/factcheck-runtime-fixture.test.ts`

## Inputs

- `src/resources/extensions/gsd/auto-dispatch.ts` — existing dispatch rule table (343 lines, rule array pattern)
- `src/resources/extensions/gsd/auto-prompts.ts` — existing buildPlanSlicePrompt (line 603+, uses resolveSliceFile, inlineFile patterns)
- `src/resources/extensions/gsd/tests/fixtures/factcheck-runtime/` — S01 fixture data for reference (FACTCHECK-STATUS.json schema, claim annotation schema)
- S01 summary: FACTCHECK-STATUS.json has fields: overallStatus, planImpacting, rerouteTarget, planImpactingClaims, counts. Claim annotations have: claimId, verdict, correctedValue, impact, citations, notes.
- D073: FIXTURE-MANIFEST.json is the contract boundary for expected outcomes

## Expected Output

- `src/resources/extensions/gsd/auto-dispatch.ts` — modified with factcheck-reroute dispatch rule
- `src/resources/extensions/gsd/auto-prompts.ts` — modified with fact-check evidence injection in buildPlanSlicePrompt

## Observability Impact

**Signals changed:**
- Dispatch rule match name "factcheck-reroute → plan-slice" appears in dispatch trace logs when factcheck reroute triggers
- "Fact-Check Evidence" section header appears in generated plan-slice prompts when REFUTED claims with plan impact exist

**How future agents inspect this task:**
- `grep -n "factcheck-reroute" src/resources/extensions/gsd/auto-dispatch.ts` finds the rule at line 217
- `grep -n "Fact-Check Evidence" src/resources/extensions/gsd/auto-prompts.ts` finds the evidence section formatting
- The exported `loadFactcheckEvidence` function can be called directly from tests or diagnostics

**Failure state visibility:**
- If factcheck reroute fails to trigger: check that FACTCHECK-STATUS.json exists in slice factcheck/ dir with planImpacting=true
- If evidence injection fails: check that claim annotations exist in factcheck/claims/*.json with verdict="refuted" and correctedValue field
- JSON parsing errors are caught and logged, causing graceful fallback to normal dispatch
