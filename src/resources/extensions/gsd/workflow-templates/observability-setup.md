# Observability Setup Workflow

<template_meta>
name: observability-setup
version: 1
mode: markdown-phase
requires_project: false
artifact_dir: .gsd/workflows/observability/
</template_meta>

<purpose>
Add structured logging, metrics, and tracing to a project that has none (or
not enough). Picks tools appropriate to the stack, instruments the
highest-value code paths first, and verifies that operators can actually use
the output to debug an incident.
</purpose>

<phases>
1. survey    — Understand what exists, what's missing, and what we need
2. design    — Pick tools + plan instrumentation
3. implement — Add logs / metrics / traces to the prioritized paths
4. verify    — Run a synthetic incident and confirm we'd catch it
</phases>

<process>

## Phase 1: Survey

**Goal:** Know the starting point so the plan is honest.

1. **Inventory existing instrumentation:**
   - Logging framework (winston / pino / logging / zap / ...)?
   - Log destination (stdout / file / remote aggregator)?
   - Existing metrics (Prometheus / OpenTelemetry / custom)?
   - Existing traces (Jaeger / Zipkin / OTEL)?
   - Error reporting (Sentry / Rollbar / ...)?

2. **Identify the critical paths:**
   - The top 3–5 user-facing flows.
   - Any background jobs or schedulers.
   - External dependencies (DBs, HTTP APIs, queues).

3. **Classify each path:**
   - Fully instrumented, partially, or not at all.
   - What question would an operator want to answer about this path at 2 AM?

4. **Write `SURVEY.md`:**
   - Current state summary.
   - Prioritized list of gaps (what's missing where).
   - Constraints (budget, existing tooling, cloud provider).

5. **Gate:** Confirm priorities. Observability work is easy to over-engineer —
   focus on the top 3 paths rather than blanket coverage.

## Phase 2: Design

**Goal:** Pick tools and agree on conventions before coding.

1. **Choose the stack:**
   - **Logs:** structured JSON with a consistent schema (timestamp, level,
     service, request_id, user_id when safe, message, fields).
   - **Metrics:** counter / gauge / histogram; decide the naming scheme
     (`<service>.<area>.<what>_<unit>`).
   - **Traces:** OpenTelemetry is the modern default unless the project
     is already committed to something else.

2. **Define the conventions** and write them to `CONVENTIONS.md`:
   - Log levels: when to use debug / info / warn / error.
   - Trace naming: span names as `verb.object`.
   - Metric labels: what's allowed, what's banned (high-cardinality warning).
   - PII / secret-scrubbing rules — critical, document them.

3. **Plan the instrumentation** — `PLAN.md`:
   - For each critical path: what logs, what metrics, what trace spans.
   - The order to implement (start with the highest-value path).

4. **Gate:** Review the plan. Conventions are hard to change later — get them
   right now.

## Phase 3: Implement

**Goal:** Ship instrumentation one path at a time.

1. **Bootstrap the libraries:**
   - Install chosen packages.
   - Create a shared `observability.ts` / `observability.py` module:
     logger factory, metric registry, tracer setup.
   - Add env-based configuration (log level, trace sampling, metrics endpoint).

2. **Instrument one critical path end-to-end:**
   - Entry-point log with all relevant context.
   - Key decision points logged at debug level.
   - Outbound calls wrapped in a trace span.
   - Errors logged at error level with stack traces.
   - Counter + histogram for the operation.

3. **Commit atomically** — one path per commit. Run the path and inspect the
   output to make sure it's actually useful.

4. **Repeat** for the remaining prioritized paths.

5. **Write `IMPL.md`** as you go, noting anything that surprised you or that
   operators should know.

## Phase 4: Verify

**Goal:** Prove that we'd catch a real incident.

1. **Run a synthetic incident:**
   - Inject a failure (kill the DB connection, throw a timeout, slow down
     a dependency).
   - From the logs / metrics / traces alone, could an operator who didn't
     write the code diagnose it?

2. **Fix the gaps** surfaced by the drill — usually missing context in
   error logs, or metrics that don't label the failure mode.

3. **Write `VERIFY.md`:**
   - What scenarios were tested.
   - What was observable vs what wasn't.
   - Recommended alerts to set up (thresholds, not tools).

4. **Document for operators** — update the runbook or README "operating"
   section:
   - Where logs go.
   - How to view traces.
   - Key metrics and their healthy ranges.

5. **Gate:** Final review. Observability that nobody uses is overhead, not
   value — the user should be able to demo "here's how I'd debug X" using
   the new instrumentation.

</process>
