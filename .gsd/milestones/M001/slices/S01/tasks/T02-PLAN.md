---
estimated_steps: 5
estimated_files: 3
---

# T02: Context store query layer, formatters, fallback, and gitignore

**Slice:** S01 — DB Foundation + Decisions + Requirements
**Milestone:** M001

## Description

Create the `context-store.ts` module with typed query functions that filter decisions and requirements from the DB views, format functions that produce prompt-injectable text, and graceful fallback behavior (empty results, never throws). Update gitignore with DB sidecar file patterns. Write comprehensive tests including timing assertions.

## Steps

1. Create `context-store.ts` — `queryDecisions(opts?: { milestoneId?: string, scope?: string }): Decision[]` queries `active_decisions` view with optional WHERE clauses for `when_context LIKE '%milestoneId%'` and `scope = :scope`. `queryRequirements(opts?: { sliceId?: string, status?: string }): Requirement[]` queries `active_requirements` view with optional WHERE clauses for `primary_owner LIKE '%sliceId%' OR supporting_slices LIKE '%sliceId%'` and `status = :status`. All functions check `isDbAvailable()` first and return `[]` if DB not available.
2. Format functions — `formatDecisionsForPrompt(decisions: Decision[]): string` renders a markdown table matching the DECISIONS.md format (columns: #, When, Scope, Decision, Choice, Rationale, Revisable?). `formatRequirementsForPrompt(requirements: Requirement[]): string` renders structured H3 sections matching REQUIREMENTS.md format (id, class, status, description, etc.). Both return empty string for empty input arrays.
3. Add gitignore patterns — append `.gsd/gsd.db`, `.gsd/gsd.db-wal`, `.gsd/gsd.db-shm` to `BASELINE_PATTERNS` in `gitignore.ts`. These need to be inside the `.gsd/` directory since `.gsd/` is already gitignored as a whole, but the DB files specifically need to be listed for environments where `.gsd/` is force-added. Actually — `.gsd/` is already in BASELINE_PATTERNS which covers everything. But the DB files should be in the patterns for documentation clarity and for the case where durable paths are force-added back. Check the `MIGRATION_DURABLE_PATHS` to ensure `gsd.db` isn't accidentally force-added.
4. Write `context-store.test.ts` — tests: query all active decisions (insert 3, supersede 1, expect 2), query decisions by milestone scope, query decisions by scope category, query all active requirements, query requirements by slice owner, query requirements by status, format decisions produces valid markdown table, format requirements produces structured sections, fallback returns empty array when DB not opened, sub-5ms timing assertion (insert 50 decisions + 50 requirements, query all, assert < 5ms).
5. Verify gitignore patterns are present in `BASELINE_PATTERNS` array.

## Must-Haves

- [ ] `queryDecisions()` with optional milestone and scope filters
- [ ] `queryRequirements()` with optional slice and status filters
- [ ] `formatDecisionsForPrompt()` renders markdown table
- [ ] `formatRequirementsForPrompt()` renders structured sections
- [ ] All query/format functions return empty results (never throw) when DB unavailable
- [ ] Sub-5ms query latency verified by test
- [ ] Gitignore updated with DB sidecar patterns
- [ ] All context-store tests pass

## Verification

- `npm run test:unit -- --test-name-pattern "context-store"` passes
- Query functions return correct filtered subsets
- Format output matches expected markdown structure
- Fallback path returns empty without error
- Timing assertion passes (< 5ms for 50-row queries)

## Inputs

- `src/resources/extensions/gsd/gsd-db.ts` — DB abstraction from T01 (openDatabase, isDbAvailable, insert/query wrappers, typed interfaces)
- `src/resources/extensions/gsd/types.ts` — Decision, Requirement types from T01
- `src/resources/extensions/gsd/gitignore.ts` — BASELINE_PATTERNS array to update
- `src/resources/extensions/gsd/tests/test-helpers.ts` — assertion helpers

## Observability Impact

- **`queryDecisions()` / `queryRequirements()`** — return `[]` silently when DB unavailable (checked via `isDbAvailable()`). No stderr output on fallback path; the caller can distinguish "no results" from "DB down" by calling `isDbAvailable()` separately.
- **Format functions** — pure transforms, no side effects. Empty input → empty string output. No new runtime signals.
- **Inspection surface** — a future agent can verify the query layer by: `openDatabase(':memory:')`, insert test rows, call `queryDecisions()`/`queryRequirements()` with filters, and confirm correct filtered subsets. `_getAdapter()` exposes the raw adapter for direct SQL if needed.
- **Failure visibility** — query functions catch and swallow all exceptions, returning `[]`. This means SQL errors are silent; the tradeoff is that prompt injection never crashes. If debugging query issues, use `_getAdapter()?.prepare(sql).all()` directly to see raw errors.

## Expected Output

- `src/resources/extensions/gsd/context-store.ts` — complete query + format module with fallback
- `src/resources/extensions/gsd/gitignore.ts` — updated with DB sidecar patterns
- `src/resources/extensions/gsd/tests/context-store.test.ts` — comprehensive test file with timing assertions
