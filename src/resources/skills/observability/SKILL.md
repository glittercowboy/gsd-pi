---
name: observability
description: Add agent-first observability to code — structured logs, health endpoints, failure-state persistence, and explicit failure modes — so the next agent hitting a problem at 3am has the signals it needs to diagnose. Use when asked to "add logging", "add observability", "add metrics", "debug later", "make this observable", or when building/refactoring a subsystem that will run unattended (auto-mode engine, background jobs, servers, watchers). Operationalizes VISION.md's "agent-first observability" principle.
---

<objective>
Instrument code so that a cold-start agent can understand what happened by reading signals, not by rerunning with extra logging. The deliverable is a set of specific instrumentation additions: structured logs at decision points, health/status surfaces for long-running processes, persisted failure state, and explicit failure modes that don't get swallowed.
</objective>

<context>
GSD-2's `VISION.md` lists "agent-first observability" as a principle, and the system prompt calls it out: "A future version of you will land in this codebase with no memory… you add observability because you're the one who'll need it at 3am." GSD-2 already exemplifies this — `activity/*.jsonl`, `journal/*.jsonl`, `metrics.json`, `doctor-history.jsonl` — but new code doesn't get that treatment automatically.

This skill is the thinking process for adding it. Not "add logs everywhere" — add the *right* signals at the *right* decision points.

Invocation points:
- Building auto-mode-style code (loops, dispatch, guards, retries)
- Adding a background job, watcher, or scheduled task
- Writing a server or long-running process
- Refactoring a subsystem that has been hard to debug
- Addressing a production bug where "we had no visibility" surfaced
</context>

<core_principle>
**LOG DECISIONS, NOT ACTIVITY.** "Entering function X" is noise. "Dispatched unit `slice/S02` after guard check passed because `status=pending`" is signal. Every log line should answer a question a future debugger will ask.

**FAIL LOUDLY AND PERSIST THE REASON.** Silent `try/catch` that returns `undefined` is an anti-pattern. If something fails, the failure state needs to be somewhere a fresh agent can find it — a JSONL, a status file, a health endpoint.

**OBSERVABILITY IS NOT FREE.** Every log allocation, every metric, every health check costs CPU and disk. Add only what you would actually read.
</core_principle>

<process>

## Step 1: Map the failure modes

Before instrumenting, list what can go wrong:

1. **What inputs could be invalid?** External API responses, user-submitted data, filesystem state, env vars.
2. **What external dependencies could fail?** Network, DB, child processes, filesystem permissions.
3. **What internal invariants could break?** State transitions, lock acquisition, concurrency assumptions.
4. **What silent corruption is possible?** Truncated writes, partial transactions, stale caches.

This map tells you where to instrument. Don't instrument uniformly — instrument at the decision points where these failures would manifest.

## Step 2: Structured logs at decision points

For each decision the code makes that could plausibly go wrong later:

- **What decision?** ("Dispatching unit X", "Retrying with backoff", "Skipping validation because flag set")
- **Why?** ("status=pending", "previous attempt exit=1", "--dev flag set")
- **What would a future debugger want to know?** (The values that drove the choice.)

Format:

```ts
log.info({
  event: "unit-dispatched",
  unitType: "slice",
  unitId: "S02",
  reason: "pending",
  attempt: 1,
  flowId,
});
```

Use the project's existing logger if one exists. In gsd-2, follow the patterns in `src/resources/extensions/gsd/activity-log.ts` and `src/resources/extensions/gsd/journal.ts` — structured JSONL, one event per line, with `ts`, `event`, and domain-specific fields.

Avoid:
- `console.log("here")` — what does "here" mean in six months?
- Logging secrets, tokens, or PII — ever.
- Formatting structured data into a prose string — it can't be grepped or filtered.

## Step 3: Persist failure state

When something fails in a way the caller can't immediately handle, write the failure state to disk:

```ts
await writeAtomically(
  resolve(".gsd/runtime/last-error.json"),
  JSON.stringify({
    ts: new Date().toISOString(),
    phase: "execute",
    unitId,
    error: { message, stack, code },
    retryCount,
  })
);
```

A fresh agent reading `.gsd/runtime/` sees what happened last, what was retried, and where the process stopped. Pattern exists already in gsd-2 — reuse the `atomic-write.ts` helpers and the `.gsd/runtime/` and `.gsd/forensics/` directories.

## Step 4: Health and status surfaces

For long-running processes:

- **Health endpoint** (HTTP server) or **status file** (CLI tool). Cheap to call, no side effects. Returns current state: `{status: "healthy" | "degraded" | "down", ...diagnostics}`.
- **Digest view** — a small representation of recent work. In gsd-2, this is `STATE.md` and the health widget. In a server, it's `/internal/status` with last 10 request summaries.
- **Minimal metrics** — counters for the 3–5 things that matter (requests, errors, active jobs). Not everything — just what drives alerts.

Don't build a metrics empire. Build exactly what you'd check at 3am.

## Step 5: Explicit failure modes

Replace silent handling with explicit:

```ts
// Bad
try {
  return await db.getUser(id);
} catch {
  return null;
}

// Good
try {
  return await db.getUser(id);
} catch (err) {
  log.error({ event: "db-getuser-failed", userId: id, err: serializeError(err) });
  throw new DatabaseError("Failed to load user", { cause: err, userId: id });
}
```

The caller now knows the failure happened, gets an error type it can branch on, and a log line exists for forensics.

## Step 6: Remove the scaffolding

Before shipping, cull the ad-hoc instrumentation you used while debugging. Keep only:
- Decision-point logs that a future agent would use
- Persistent failure state
- Health/status surfaces
- Explicit failure modes

Drop:
- Temporary `console.log` debug lines
- Spammy per-iteration logs that no one will read
- Metrics that were "might be useful someday"

The system prompt says it plainly: "Remove noisy one-off instrumentation before finishing unless it provides durable diagnostic value."

## Step 7: Verify the signals work

Pick one plausible failure mode from Step 1 and simulate it (inject an error, point at a missing file, break a dependency). Confirm:

1. The failure produced a log line a cold-start agent could understand.
2. The failure state persisted somewhere durable.
3. The health surface reflects the degraded state.
4. Nothing was swallowed silently.

If any signal is missing, add it — that's the gap this skill exists to catch.

</process>

<anti_patterns>

- **Uniform logging.** Logging every function entry/exit buries signal in noise.
- **Prose logs.** `"Processing user 42 now"` vs `{event: "user-process-start", userId: 42}` — the latter is queryable, the former is not.
- **Silent swallowing.** `catch {}` or `catch (err) { /* ignore */ }` without a log is a deferred production incident.
- **Metrics empire.** 200 Prometheus metrics nobody reads. Ship 5 that drive alerts.
- **Logging secrets.** API keys, tokens, passwords, full request bodies with PII — never.
- **"I'll add logging when it breaks."** By then you don't have the signal. Instrument now.
- **Over-instrumenting hot paths.** Logging inside a tight loop kills performance. Sample or aggregate.

</anti_patterns>

<success_criteria>

- [ ] Failure modes were listed before instrumenting.
- [ ] Logs are at decision points, structured, and contain the driving values.
- [ ] Failure state is persisted to a known location (`.gsd/runtime/`, `/var/log/`, a status file).
- [ ] Long-running processes expose a health or status surface.
- [ ] No silent `try/catch` swallowing errors.
- [ ] Ad-hoc debug instrumentation was removed.
- [ ] One plausible failure was simulated and the signals were confirmed to reach a fresh reader.

</success_criteria>
