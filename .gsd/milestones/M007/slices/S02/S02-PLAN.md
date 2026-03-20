# S02: Metrics Aggregation & Reporting

**Goal:** A CLI-invocable utility reads dispatch-metrics.jsonl, produces comparison tables, and handles malformed/partial lines gracefully.
**Demo:** `npx tsx src/resources/extensions/gsd/report-metrics.ts .gsd/activity/dispatch-metrics.jsonl` prints a Markdown comparison table to stdout. Tests prove accuracy and crash-resilience.

## Must-Haves

- JSONL reader that parses `dispatch-metrics.jsonl` lines into `UnitMetrics[]`, skipping malformed lines
- CLI entry point that accepts file path(s) and prints `formatComparisonTable` output
- Test coverage for malformed-line resilience (partial writes, truncated JSON, empty lines)
- Existing `summarize-metrics.test.ts` (11 tests) continues passing

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/summarize-metrics.test.ts` — 11+ pass (existing + new)
- `npx tsx --test src/resources/extensions/gsd/tests/metrics-reader.test.ts` — new reader tests pass
- `npx tsx src/resources/extensions/gsd/report-metrics.ts .gsd/activity/dispatch-metrics.jsonl` exits 0 (or prints "no metrics found" if file absent)

## Tasks

- [ ] **T01: Implement JSONL reader and CLI report entry point** `est:30m`
  - Why: No code currently reads dispatch-metrics.jsonl from disk. The summarize-metrics module operates on in-memory MetricsLedger objects. This task bridges the gap — reading JSONL, skipping bad lines, and wiring to the existing formatter.
  - Files: `src/resources/extensions/gsd/metrics-reader.ts`, `src/resources/extensions/gsd/report-metrics.ts`
  - Do: Create `readMetricsJsonl(filePath)` that reads file line-by-line, JSON.parse each, collects valid UnitMetrics, skips malformed. Create `report-metrics.ts` CLI script that takes file path arg, calls reader → `summarizeMetrics` → `formatComparisonTable`, prints to stdout. Handle missing file gracefully.
  - Verify: `npx tsx src/resources/extensions/gsd/report-metrics.ts /nonexistent` exits 0 with message
  - Done when: CLI script runs against a real or mock JSONL file and outputs a Markdown table

- [ ] **T02: Add reader and durability tests** `est:25m`
  - Why: Crash resilience is a slice must-have — partial writes from interrupted dispatches must not break the reader. Need tests for malformed lines, empty files, mixed valid/invalid content.
  - Files: `src/resources/extensions/gsd/tests/metrics-reader.test.ts`
  - Do: Test `readMetricsJsonl` with: valid multi-line JSONL, empty file, lines with truncated JSON, blank lines interspersed, file with only malformed content (returns empty array). Test that existing summarize-metrics tests still pass.
  - Verify: `npx tsx --test src/resources/extensions/gsd/tests/metrics-reader.test.ts` — all pass
  - Done when: Reader correctly handles all malformed-input cases and 0 regressions in existing tests

## Files Likely Touched

- `src/resources/extensions/gsd/metrics-reader.ts` (new)
- `src/resources/extensions/gsd/report-metrics.ts` (new)
- `src/resources/extensions/gsd/tests/metrics-reader.test.ts` (new)
