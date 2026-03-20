# Roadmap — Milestone M007: Telemetry, Metrics, and Experiment Fixtures

## Slices

- [x] **S01: Telemetry Schema & Dispatch Hooking** `risk:medium` `depends:[]`
  - Define telemetry JSONL schema.
  - Integrate `metrics.js` snapshot hooks into `auto-dispatch.ts` unit loop (start/end).
  - Implement durable activity log writer in `.gsd/activity/`.
  - Ensure metric writing is non-blocking (write-behind).

- [ ] **S02: Metrics Aggregation & Reporting** `risk:low` `depends:[S01]`
  - Implement metrics summary utility script to read activity logs.
  - Produce comparison tables (token count, intervention, time).
  - Verify metrics durability across unit crashes/restarts.

- [ ] **S03: Fixture Harness** `risk:medium` `depends:[S02]`
  - Implement `experiment-runner.ts` for fixture environment restoration.
  - Create 3 concept fixtures with known success criteria (e.g., "high unknowns" scenario).
  - End-to-end verification of full run + metric extraction.

## Strategy

1. **Passive Telemetry First**: Get the raw data capture working reliably before building the reporting/analysis layers.
2. **Durable Records**: Ensure records survive crashes/restarts immediately; otherwise, metrics are biased by failure recovery.
3. **Fixture-Driven Development**: Once telemetry is captured, use the fixture harness to prove the telemetry works as intended by standardizing input scenarios.

---
Roadmap initialized.

```yaml
slices:
  S01: Telemetry Schema & Dispatch Hooking
  S02: Metrics Aggregation & Reporting
  S03: Fixture Harness
```
