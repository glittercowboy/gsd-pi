# Performance Audit Workflow

<template_meta>
name: performance-audit
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/perf/
</template_meta>

<purpose>
Find and fix real performance problems. Measure first, fix with evidence,
measure again. Avoids the common trap of "optimizations" that don't move
actual user-facing metrics.
</purpose>

<phases>
1. profile     — Gather real measurements from representative workloads
2. prioritize  — Pick the fixes with the best effort/impact ratio
3. fix         — Apply the changes with before/after numbers
4. verify      — Confirm the improvements hold under realistic load
</phases>

<process>

## Phase 1: Profile

**Goal:** Replace intuition with measurements.

1. **Define the workload.** What's slow, for whom, and under what conditions?
   - Interactive: which user flow?
   - Batch: which job?
   - API: which endpoint, at what QPS?
   Without this, you're optimizing in the dark.

2. **Establish a baseline metric** that reflects what users feel:
   - Latency at p50, p95, p99.
   - Throughput.
   - Memory high-water-mark.
   - Cold-start / warm-start times.
   Pick one or two metrics — not all five.

3. **Run a profiler.**
   - Node: `node --prof`, `clinic.js`, Chrome DevTools flamegraphs.
   - Python: `cProfile`, `py-spy`, `scalene`.
   - Go: `pprof`.
   - Web: Lighthouse, Chrome Performance tab, Web Vitals.
   - Database: `EXPLAIN ANALYZE`, slow query log.

4. **Write `BASELINE.md`** with:
   - Exact workload description (so we can re-run it).
   - Metric values.
   - Profile output or flamegraph attached.
   - Top 5 hot functions / queries / network calls.

5. **Gate:** The user confirms the baseline matches their experience. If it
   doesn't, the workload isn't representative — go back and fix that first.

## Phase 2: Prioritize

**Goal:** Pick the fixes that actually matter.

1. **For each hot spot in the profile**, estimate:
   - Potential improvement (guesstimate the % reduction).
   - Implementation effort (hours / days).
   - Risk (probability of introducing bugs).

2. **Prioritize by impact / (effort × risk).** A 50% reduction in a
   p99-tail function often beats a 90% reduction in a warm path.

3. **Write `PLAN.md`** with:
   - A ranked list of fixes (top 3–5).
   - For each: what changes, why it should help, what could go wrong.
   - Explicitly call out hot spots you're choosing to SKIP and why.

4. **Gate:** Confirm the plan with the user before coding. It's cheap to
   change direction here, expensive later.

## Phase 3: Fix

**Goal:** Apply changes with receipts.

1. **One fix at a time.** Each becomes an atomic commit. Don't bundle
   unrelated perf changes — you'll lose the ability to attribute gains.

2. **Before/after measurement** for each fix:
   - Run the same workload from Phase 1.
   - Record the new metrics.
   - If a fix doesn't help, revert it and say so.

3. **Commit message format:**
   ```
   perf(<area>): <change summary>

   Before: p95 400ms
   After:  p95 180ms
   ```

4. **Append to `PROGRESS.md`:**
   - Fix name, before/after, whether kept or reverted.

## Phase 4: Verify

**Goal:** Make sure the improvements hold up in reality.

1. **Re-run the full Phase 1 workload.** Compare against baseline.

2. **Test under stress** — 2x the normal load, cold caches, realistic data
   sizes. Perf fixes that only help a synthetic microbenchmark aren't
   worth shipping.

3. **Check for regressions** elsewhere — run the full test suite, watch
   memory, check other endpoints. Sometimes local gains come with global
   costs.

4. **Write `REPORT.md`:**
   - Summary: which metric improved by how much, and under what conditions.
   - Fixes kept vs reverted.
   - Remaining hot spots that weren't worth it.
   - Monitoring recommendation: what metric to track so regressions surface.

5. **Gate:** Present the report. If the improvement isn't meaningful at the
   user-facing level, that's important to surface — don't pretend a win.

</process>
