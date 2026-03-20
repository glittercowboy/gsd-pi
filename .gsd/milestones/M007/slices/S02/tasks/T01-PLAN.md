---
estimated_steps: 4
estimated_files: 2
---

# T01: Implement JSONL reader and CLI report entry point

**Slice:** S02 — Metrics Aggregation & Reporting
**Milestone:** M007

## Description

Create the I/O bridge between durable JSONL telemetry on disk and the existing `summarizeMetrics`/`formatComparisonTable` functions. Two new files: a reader module and a CLI script.

The existing `summarize-metrics.ts` already has all aggregation and formatting logic (11 passing tests). What's missing is reading `.gsd/activity/dispatch-metrics.jsonl` from disk and wiring it to the formatter via a CLI entry point.

**Relevant skill:** `create-gsd-extension` — this is a gsd extension utility.

## Steps

1. Create `src/resources/extensions/gsd/metrics-reader.ts` with a `readMetricsJsonl(filePath: string): UnitMetrics[]` function. Read the file with `readFileSync`, split by newline, `JSON.parse` each non-empty line in a try/catch, collect valid `UnitMetrics` objects, skip malformed lines silently.
2. Create `src/resources/extensions/gsd/report-metrics.ts` as a CLI script. Parse `process.argv` for one or more JSONL file paths. For each path: if file doesn't exist, print a message and continue. Otherwise call `readMetricsJsonl`, build a `LedgerInput` (label = filename), pass to `summarizeMetrics` → `formatComparisonTable`, print to stdout.
3. Handle edge cases: no args prints usage, missing files skip with warning, empty files produce "no metrics" message.
4. Manual smoke test: `npx tsx src/resources/extensions/gsd/report-metrics.ts /nonexistent` should exit 0 with a helpful message.

## Must-Haves

- [ ] `readMetricsJsonl` returns `UnitMetrics[]` and silently skips malformed JSON lines
- [ ] CLI script accepts file path(s) and prints Markdown comparison table
- [ ] Missing/empty files handled gracefully (no crash, informative message)

## Verification

- `npx tsx src/resources/extensions/gsd/report-metrics.ts /nonexistent` — exits 0 with message
- `npx tsx --test src/resources/extensions/gsd/tests/summarize-metrics.test.ts` — existing 11 tests still pass (no regressions)

## Inputs

- `src/resources/extensions/gsd/summarize-metrics.ts` — existing aggregation/formatting (exports `summarizeMetrics`, `formatComparisonTable`, `LedgerInput`)
- `src/resources/extensions/gsd/metrics.ts` — `UnitMetrics` type, `MetricsLedger` type
- `src/resources/extensions/gsd/metrics-logger.ts` — shows the JSONL write format (single JSON line per `UnitMetrics`)
- S01 contract: each line in `dispatch-metrics.jsonl` is a complete `JSON.stringify(UnitMetrics)` followed by newline

## Expected Output

- `src/resources/extensions/gsd/metrics-reader.ts` — new module with `readMetricsJsonl` export
- `src/resources/extensions/gsd/report-metrics.ts` — new CLI script
