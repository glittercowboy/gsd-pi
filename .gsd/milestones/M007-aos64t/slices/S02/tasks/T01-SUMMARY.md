---
id: T01
parent: S02
milestone: M007-aos64t
provides:
  - factcheck-reroute dispatch rule for plan-impacting refutations
  - loadFactcheckEvidence helper for prompt injection
key_files:
  - src/resources/extensions/gsd/auto-dispatch.ts
  - src/resources/extensions/gsd/auto-prompts.ts
key_decisions:
  - Dispatch rule checks planImpacting boolean before rerouting
  - Evidence injection filters to REFUTED claims with corrected values
patterns_established:
  - Dispatch rules read artifact files from slice factcheck/ subdirectory
  - Evidence sections inlined after research, before decisions
observability_surfaces:
  - Dispatch rule match name: "factcheck-reroute → plan-slice"
  - Fact-Check Evidence section header in generated prompt for grep-ability
duration: 15m
verification_result: passed
completed_at: 2026-03-18T19:35:00Z
blocker_discovered: false
---

# T01: Wire factcheck reroute dispatch rule and corrected-evidence prompt injection

**Added factcheck-reroute dispatch rule and loadFactcheckEvidence helper for plan-impacting refutation injection into slice plans.**

## What Happened

Implemented the production runtime code for fact-check-driven planner reroute. Added a new dispatch rule in auto-dispatch.ts that detects FACTCHECK-STATUS.json with planImpacting=true and dispatches plan-slice with evidence injection. Added the loadFactcheckEvidence helper in auto-prompts.ts that reads claim annotations, filters to REFUTED claims, and formats an evidence section with corrected values. The evidence section is injected into buildPlanSlicePrompt after the research inline but before the decisions inline.

The dispatch rule is inserted before the normal "planning → plan-slice" rule (line 217 vs 251), ensuring factcheck reroute takes precedence when applicable. The helper exports for T02 testing.

## Verification

- Dispatch rule "factcheck-reroute → plan-slice" exists at line 217 in auto-dispatch.ts
- Rule reads FACTCHECK-STATUS.json from slice factcheck/ subdirectory
- Rule only reroutes when planImpacting is strictly true
- loadFactcheckEvidence helper exports from auto-prompts.ts
- Evidence injection includes REFUTED claim annotations with corrected values
- TypeScript error count unchanged (2 pre-existing errors)
- S01 fixture tests pass (30/30 tests)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -n "factcheck-reroute" src/resources/extensions/gsd/auto-dispatch.ts` | 0 | ✅ pass | <1s |
| 2 | `grep -n "Fact-Check Evidence\|factcheck\|FACTCHECK" src/resources/extensions/gsd/auto-prompts.ts` | 0 | ✅ pass | <1s |
| 3 | `npx tsc --noEmit 2>&1 \| grep -c "error TS"` | 0 | ✅ pass (2 errors, unchanged) | 12s |
| 4 | `node --test src/resources/extensions/gsd/tests/factcheck-runtime-fixture.test.ts` | 0 | ✅ pass (30/30) | 95s |

## Diagnostics

- Dispatch rule match name "factcheck-reroute → plan-slice" appears in dispatch trace logs
- Fact-Check Evidence section header appears in generated prompts when REFUTED claims exist
- FACTCHECK-STATUS.json in slice factcheck/ directory is the trigger artifact

## Deviations

None. Implementation matched the task plan exactly.

## Known Issues

None. The S02 live test file will be created in T02.

## Files Created/Modified

- `src/resources/extensions/gsd/auto-dispatch.ts` — Added factcheck-reroute dispatch rule before planning → plan-slice rule, added resolveSlicePath import
- `src/resources/extensions/gsd/auto-prompts.ts` — Added loadFactcheckEvidence helper function with REFUTED claim formatting, injected evidence into buildPlanSlicePrompt
