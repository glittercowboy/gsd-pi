# S02: Action pipeline performance — UAT

**Milestone:** M002
**Written:** 2026-03-12

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: This is a structural refactor reducing evaluate call count. The behavior is verified by build success and code-level grep checks. No runtime or visual verification needed — the tool output format is unchanged.

## Preconditions

- Repository cloned and dependencies installed
- Node.js available

## Smoke Test

`npm run build` exits 0 — confirms all refactored tool files compile without type errors.

## Test Cases

### 1. No standalone countOpenDialogs in tool files

1. Run `grep -c "countOpenDialogs" src/resources/extensions/browser-tools/tools/*.ts`
2. **Expected:** All 9 files return 0.

### 2. No postActionSummary in interaction tools

1. Run `grep -c "postActionSummary" src/resources/extensions/browser-tools/tools/interaction.ts`
2. **Expected:** Returns 0.

### 3. Explicit signal classification in interaction tools

1. Run `grep "includeBodyText" src/resources/extensions/browser-tools/tools/interaction.ts`
2. **Expected:** Shows `includeBodyText: true` for high-signal tools (click, type, key_press, select_option, set_checked) and `includeBodyText: false` for low-signal tools (scroll, hover, drag, upload_file).

### 4. Zero-mutation short-circuit exists

1. Run `grep "zero_mutation_shortcut" src/resources/extensions/browser-tools/settle.ts`
2. **Expected:** Finds the settle reason in the return path.

### 5. Combined settle poll evaluate

1. Open `src/resources/extensions/browser-tools/settle.ts`
2. Find the `readSettleState` function
3. **Expected:** Single `target.evaluate()` call returning `{ mutationCount, focusDescriptor }`.

## Edge Cases

### postActionSummary still works for summary-only tools

1. Run `grep "postActionSummary" src/resources/extensions/browser-tools/tools/navigation.ts`
2. **Expected:** go_back, go_forward, reload still use postActionSummary (non-zero count). Only action-pattern tools were migrated.

## Failure Signals

- Build failure in any tool file — indicates a broken import or type mismatch from the refactor
- `countOpenDialogs` appearing in tool files — indicates incomplete migration
- Missing `includeBodyText` parameter in action tool's captureCompactPageState call — tool would get default behavior instead of explicit classification

## Requirements Proved By This UAT

- R017 — Consolidated capture pipeline verified by absence of postActionSummary and countOpenDialogs in action tools
- R018 — Conditional body text capture verified by explicit includeBodyText per tool
- R019 — Zero-mutation settle short-circuit verified by presence of zero_mutation_shortcut reason and combined poll evaluate

## Not Proven By This UAT

- Actual millisecond savings per action — would require runtime timing instrumentation
- Correctness of settle short-circuit under real DOM mutation patterns — deferred to S06 test coverage
- Whether 60ms/30ms thresholds are optimal for all SPA frameworks — would require real-world benchmarking

## Notes for Tester

This is a pure structural refactor. The tool output format is identical before and after — users won't see any difference in responses. The value is fewer evaluate round-trips (lower latency) and skipped body text capture on low-signal actions (less work per action). All verification is code-level.
