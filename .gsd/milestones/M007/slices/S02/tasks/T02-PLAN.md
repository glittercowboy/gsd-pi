---
estimated_steps: 4
estimated_files: 1
---

# T02: Add reader and durability tests

**Slice:** S02 — Metrics Aggregation & Reporting
**Milestone:** M007

## Description

Test `readMetricsJsonl` for crash resilience — the reader must handle partial writes, truncated JSON, blank lines, and completely malformed files without throwing. This validates the "metrics durability across crashes/restarts" requirement from the roadmap.

Use the same test infrastructure as existing gsd tests (`node:test`, `node:assert`). Write to temp files using `os.tmpdir()` + `crypto.randomUUID()` for isolation.

**Important:** Tests run with `npx tsx --test` (not `node --test`) per K007.

## Steps

1. Create `src/resources/extensions/gsd/tests/metrics-reader.test.ts`.
2. Test cases for `readMetricsJsonl`:
   - Valid multi-line JSONL → returns all UnitMetrics objects
   - Empty file → returns `[]`
   - File with blank lines interspersed → skips blanks, returns valid entries
   - File with truncated JSON lines (simulating crash mid-write) → skips bad lines, returns valid ones
   - File with only malformed content → returns `[]`
   - Nonexistent file → returns `[]` (or throws — match implementation from T01)
3. Use `makeUnit` helper pattern from existing tests for fixture creation.
4. Verify existing tests still pass: `npx tsx --test src/resources/extensions/gsd/tests/summarize-metrics.test.ts`

## Must-Haves

- [ ] At least 5 test cases covering valid, empty, malformed, mixed, and truncated inputs
- [ ] All new tests pass
- [ ] Existing `summarize-metrics.test.ts` (11 tests) still passes

## Verification

- `npx tsx --test src/resources/extensions/gsd/tests/metrics-reader.test.ts` — all pass
- `npx tsx --test src/resources/extensions/gsd/tests/summarize-metrics.test.ts` — 11 pass (no regression)

## Inputs

- `src/resources/extensions/gsd/metrics-reader.ts` — the module under test (from T01)
- `src/resources/extensions/gsd/metrics.ts` — `UnitMetrics` type for fixture creation
- `src/resources/extensions/gsd/tests/summarize-metrics.test.ts` — reference for test patterns and `makeUnit` helper

## Expected Output

- `src/resources/extensions/gsd/tests/metrics-reader.test.ts` — new test file with 5+ test cases
