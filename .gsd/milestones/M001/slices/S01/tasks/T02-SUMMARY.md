---
id: T02
parent: S01
milestone: M001
provides:
  - queryDecisions() with milestone and scope filters against active_decisions view
  - queryRequirements() with slice and status filters against active_requirements view
  - formatDecisionsForPrompt() renders markdown table matching DECISIONS.md format
  - formatRequirementsForPrompt() renders structured H3 sections matching REQUIREMENTS.md format
  - Graceful fallback — all query/format functions return empty results when DB unavailable
  - DB sidecar gitignore patterns (.gsd/gsd.db, .gsd/gsd.db-wal, .gsd/gsd.db-shm)
key_files:
  - src/resources/extensions/gsd/context-store.ts
  - src/resources/extensions/gsd/gitignore.ts
  - src/resources/extensions/gsd/tests/context-store.test.ts
key_decisions:
  - Query functions catch all exceptions and return [] — SQL errors are silent to prevent prompt injection from crashing; use _getAdapter()?.prepare(sql).all() for debugging
patterns_established:
  - Query functions check isDbAvailable() + _getAdapter() before executing; try/catch swallows errors to return typed empty results
  - Format functions are pure transforms: empty input → empty string, no side effects
  - Named parameters in SQL via Record<string, unknown> passed to adapter.prepare().all()
observability_surfaces:
  - queryDecisions()/queryRequirements() return [] when DB unavailable — distinguish from "no results" by checking isDbAvailable() separately
  - _getAdapter() provides raw SQL access for debugging query issues
duration: 15m
verification_result: passed
completed_at: 2026-03-14
blocker_discovered: false
---

# T02: Context store query layer, formatters, fallback, and gitignore

**Built query layer with filtered views, markdown formatters, graceful fallback, and DB sidecar gitignore patterns — 47 test assertions pass including sub-5ms timing.**

## What Happened

Created `context-store.ts` with two query functions (`queryDecisions`, `queryRequirements`) that query the `decisions` table directly with `superseded_by IS NULL` filter and optional WHERE clauses. `queryDecisions` supports `milestoneId` (LIKE on `when_context`) and `scope` (exact match). `queryRequirements` supports `sliceId` (LIKE on `primary_owner` OR `supporting_slices`) and `status` (exact match).

Format functions produce prompt-injectable text: `formatDecisionsForPrompt` renders a markdown table with columns matching DECISIONS.md (# | When | Scope | Decision | Choice | Rationale | Revisable?), `formatRequirementsForPrompt` renders H3 sections with structured bullet fields, omitting empty optional fields (supporting_slices, notes).

All functions degrade gracefully — `isDbAvailable()` check + try/catch means the DB being closed or unavailable never throws, just returns `[]` or `''`.

Added `.gsd/gsd.db`, `.gsd/gsd.db-wal`, `.gsd/gsd.db-shm` to `BASELINE_PATTERNS` in `gitignore.ts`. Verified these don't appear in `MIGRATION_DURABLE_PATHS` (which would force-add them back).

## Verification

- `npm run test:unit -- --test-name-pattern "context-store"` — **47 assertions pass, 0 fail**
- Query tests: active decisions (3 inserted, 1 superseded → 2 returned), by milestone, by scope, active requirements (3 inserted, 1 superseded → 2 returned), by slice owner (primary + supporting), by status
- Format tests: empty input → empty string, markdown table structure validated (header, separator, row count), requirement sections have H3 headers and structured fields, empty optional fields omitted
- Fallback: DB closed → queryDecisions/queryRequirements return `[]` with no error
- Timing: 50 decisions + 50 requirements inserted, queried in **0.62ms** (well under 5ms threshold)
- Gitignore: DB sidecar patterns present in BASELINE_PATTERNS, absent from MIGRATION_DURABLE_PATHS
- Slice-level verification: both `gsd-db` and `context-store` test suites pass (combined 88 assertions)

## Diagnostics

- `queryDecisions()` / `queryRequirements()` — return `[]` when DB unavailable; caller can check `isDbAvailable()` to distinguish "no results" from "DB down"
- `_getAdapter()` — returns raw `DbAdapter` for direct SQL debugging if query results are unexpected
- Format functions are pure — feed them any `Decision[]`/`Requirement[]` array and inspect output directly
- Silent error swallowing in query functions means SQL syntax errors won't surface unless you use `_getAdapter()` directly

## Deviations

None — implementation matches the task plan.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/context-store.ts` — new: query layer with queryDecisions, queryRequirements, formatDecisionsForPrompt, formatRequirementsForPrompt
- `src/resources/extensions/gsd/gitignore.ts` — modified: added .gsd/gsd.db, .gsd/gsd.db-wal, .gsd/gsd.db-shm to BASELINE_PATTERNS
- `src/resources/extensions/gsd/tests/context-store.test.ts` — new: 47 assertions covering queries, filters, formats, fallback, and timing
- `.gsd/milestones/M001/slices/S01/tasks/T02-PLAN.md` — modified: added Observability Impact section (pre-flight fix)
