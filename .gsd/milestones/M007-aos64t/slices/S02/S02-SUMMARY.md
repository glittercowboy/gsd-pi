---
id: S02
parent: M007-aos64t
milestone: M007-aos64t
provides:
  - factcheck-reroute dispatch rule for plan-impacting refutations
  - loadFactcheckEvidence helper for prompt injection
  - Live integration test proving dispatch reroute and corrected evidence injection
  - Proof artifacts written to temp dir for S03 consumption
requires:
  - slice: S01
    provides: Deterministic fixture data (FIXTURE-MANIFEST.json, FACTCHECK-STATUS.json, claim annotations)
affects:
  - slice: S03
key_files:
  - src/resources/extensions/gsd/auto-dispatch.ts
  - src/resources/extensions/gsd/auto-prompts.ts
  - src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts
  - src/resources/extensions/gsd/tests/dist-redirect.mjs
key_decisions:
  - Dispatch rule checks planImpacting boolean before rerouting to plan-slice
  - Evidence injection filters to REFUTED claims with corrected values
  - Tests use .ts imports with --experimental-strip-types for ESM compatibility
  - dist-redirect.mjs updated to reference main repo packages for worktree test execution
patterns_established:
  - Dispatch rules read artifact files from slice factcheck/ subdirectory
  - Evidence sections inlined after research, before decisions in plan-slice prompt
  - Integration tests use temp directories with isolated .gsd project structures
  - Dispatch tests use DispatchContext construction with planning phase and activeSlice
observability_surfaces:
  - Dispatch rule match name: "factcheck-reroute → plan-slice" appears in dispatch trace logs
  - Fact-Check Evidence section header in generated prompts for grep-ability
  - FACTCHECK-STATUS.json in slice factcheck/ directory is the trigger artifact
  - Test output shows stage progress: setup → dispatch → prompt → negative → artifacts
  - Proof artifacts written to proof-output/ subdirectory in temp dir
drill_down_paths:
  - .gsd/milestones/M007-aos64t/slices/S02/tasks/T01-SUMMARY.md
  - .gsd/milestones/M007-aos64t/slices/S02/tasks/T02-SUMMARY.md
duration: 35m
verification_result: passed
completed_at: 2026-03-18T19:45:00Z
---

# S02: Live Reroute Proof Run

**Added factcheck-reroute dispatch rule, loadFactcheckEvidence helper, and live integration test proving planner reroute and corrected evidence injection.**

## What Happened

Implemented the core runtime machinery for fact-check-driven planner reroute. Added a dispatch rule in auto-dispatch.ts that detects FACTCHECK-STATUS.json with planImpacting=true and dispatches plan-slice with a factcheck reroute flag. The rule is inserted before the normal "planning → plan-slice" rule (line 217 vs 251), ensuring factcheck reroute takes precedence.

Added loadFactcheckEvidence helper in auto-prompts.ts that reads claim annotations from the slice factcheck/ directory, filters to REFUTED claims, and formats them as an evidence section. This is injected into buildPlanSlicePrompt after the research inline but before the decisions inline.

Created the live integration test (factcheck-runtime-live.test.ts) that exercises the real dispatch rules and prompt builders (not mocks) with S01 fixture data. The test verifies: (1) dispatch reroutes when planImpacting=true, (2) prompt contains corrected value "5.2.0", (3) negative cases fall through when status is missing or planImpacting=false, and (4) proof artifacts are written to disk.

Updated dist-redirect.mjs to reference the main repo's built packages (packages/pi-ai/dist, packages/pi-coding-agent/dist) since worktrees share the same packages but don't have separate builds.

## Verification

All 9 live integration tests pass, proving dispatch reroute works with real production code. Tests assert:
- Dispatch rule returns `{ action: "dispatch", unitType: "plan-slice" }` when planImpacting=true
- Generated prompt contains "5.2.0" (corrected value from refuted claim C001)
- Generated prompt contains "Fact-Check Evidence" section header
- Negative cases fall through when FACTCHECK-STATUS.json is missing or planImpacting=false
- Proof artifacts (reroute-action.json, prompt-excerpt.txt) written to disk

## New Requirements Surfaced

None. R064, R066, R068, R069, R070, R071 remain active — S02 provides the production wiring that enables them to be validated in future slices.

## Deviations

Updated dist-redirect.mjs to reference main repo packages at `/home/ubuntulinuxqa2/repos/gsd-2/packages/` instead of relative paths. This was necessary because worktrees don't have separate package builds.

## Known Limitations

None. The live integration test successfully proves the full runtime path.

## Follow-ups

- S03 needs to consume the proof artifacts and create durable validation report

## Files Created/Modified

- `src/resources/extensions/gsd/auto-dispatch.ts` — Added factcheck-reroute dispatch rule, imports resolveSlicePath
- `src/resources/extensions/gsd/auto-prompts.ts` — Added loadFactcheckEvidence helper, injected evidence into buildPlanSlicePrompt
- `src/resources/extensions/gsd/tests/factcheck-runtime-live.test.ts` — Created live integration test with 9 test cases
- `src/resources/extensions/gsd/tests/dist-redirect.mjs` — Updated to reference main repo packages for worktree test execution

## Forward Intelligence

### What the next slice should know
- Proof artifacts from S02 are written to temp dir in test runs — S03 needs to either use a fixed path or capture the artifact location
- The dispatch rule insertion position (line 217) is intentional — it must come before normal planning to take precedence on fact-check reroute
- The loadFactcheckEvidence helper reads from `slicePath/factcheck/` subdirectory — ensure fixture and real runtime paths match this pattern

### What's fragile
- The worktree package resolution via dist-redirect.mjs is a workaround — if package structure changes, tests may fail with import errors

### Authoritative diagnostics
- Dispatch rule name "factcheck-reroute → plan-slice" appears in trace output
- Generated prompts contain "## Fact-Check Evidence" header when refutations exist
- Test logs show each stage: setup → dispatch → prompt → negative → artifacts

### What assumptions changed
- Initial assumption that relative paths would work in worktree context — proved false, required absolute path to main repo packages
