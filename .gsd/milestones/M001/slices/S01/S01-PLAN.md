# S01: DB Foundation + Decisions + Requirements

**Goal:** SQLite database opens with schema, decisions and requirements tables exist with typed wrappers, active_decisions and active_requirements views return correct filtered subsets, and the system degrades gracefully without better-sqlite3.
**Demo:** Open DB, insert decision and requirement rows, query active views, verify superseded rows are excluded. Repeat on fallback path — system returns null/empty instead of crashing.

## Must-Haves

- `node:sqlite` → `better-sqlite3` → null provider chain with cached detection
- Schema: `schema_version`, `decisions`, `requirements` tables with correct columns and types
- `active_decisions` and `active_requirements` SQL views filtering `WHERE superseded_by IS NULL`
- WAL mode enabled on file-backed databases
- Typed insert/query wrappers for decisions and requirements
- `isDbAvailable()` function that downstream code can check
- Query functions: `queryDecisions(milestoneId?, scope?)`, `queryRequirements(sliceId?, status?)`
- Format functions that produce prompt-injectable text from query results
- Sub-5ms query latency on local disk
- Schema PKs designed for future vector search joins (auto-increment `seq` for decisions, natural `id` for requirements)
- Graceful fallback: all query functions return empty results when DB unavailable, no crash
- DB sidecar files gitignored

## Proof Level

- This slice proves: contract
- Real runtime required: yes (SQLite must actually open, execute queries, return results)
- Human/UAT required: no

## Verification

- `npm run test:unit -- --test-name-pattern "gsd-db"` — DB abstraction layer tests pass
- `npm run test:unit -- --test-name-pattern "context-store"` — Query layer + fallback tests pass
- Test file: `src/resources/extensions/gsd/tests/gsd-db.test.ts`
- Test file: `src/resources/extensions/gsd/tests/context-store.test.ts`
- Tests cover: schema init, decisions CRUD, requirements CRUD, view filtering of superseded rows, query by milestone/scope/slice/status, format output shape, fallback returns empty, WAL mode on file-backed DB, sub-5ms query timing assertion

## Observability / Diagnostics

- Runtime signals: `isDbAvailable()` returns boolean indicating which provider loaded (or none); provider name exposed via `getDbProvider()` returning `'node:sqlite' | 'better-sqlite3' | null`
- Inspection surfaces: `openDatabase(path)` and `closeDatabase()` for explicit lifecycle control; schema version queryable via `schema_version` table
- Failure visibility: Provider load failures logged to stderr on first attempt; all query functions return typed empty results (never throw) when DB unavailable
- Redaction constraints: none (no secrets in DB)

## Integration Closure

- Upstream surfaces consumed: `paths.ts` (`gsdRoot()` for DB path resolution), `native-parser-bridge.ts` (pattern reference for graceful loading), `gitignore.ts` (`BASELINE_PATTERNS` for sidecar files), `types.ts` (new type definitions)
- New wiring introduced in this slice: `gsd-db.ts` (DB abstraction), `context-store.ts` (query layer) — no runtime hookup yet, consumed by S02/S03
- What remains before the milestone is truly usable end-to-end: S02 (importers to populate DB from markdown), S03 (prompt builder rewiring to consume queries), S04-S07 (measurement, worktree, tools, integration)

## Tasks

- [x] **T01: SQLite abstraction layer with schema and typed wrappers** `est:45m`
  - Why: Foundation module — every other task and slice depends on the DB opening, schema existing, and typed insert/query working. Retires the core of R001, R020, R021.
  - Files: `src/resources/extensions/gsd/gsd-db.ts`, `src/resources/extensions/gsd/types.ts`, `src/resources/extensions/gsd/tests/gsd-db.test.ts`
  - Do: (1) Add `Decision` and `Requirement` types to `types.ts`. (2) Create `gsd-db.ts` with provider abstraction (`node:sqlite` → `better-sqlite3` → null) following the `native-parser-bridge.ts` lazy-load pattern. Suppress `node:sqlite` ExperimentalWarning. (3) Implement `openDatabase(path)`, `closeDatabase()`, `getDbProvider()`, `isDbAvailable()`. (4) Schema init: `schema_version` table (version int, applied_at text), `decisions` table (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, when_context TEXT, scope TEXT, decision TEXT, choice TEXT, rationale TEXT, revisable TEXT, superseded_by TEXT), `requirements` table (id TEXT PRIMARY KEY, class TEXT, status TEXT, description TEXT, why TEXT, source TEXT, primary_owner TEXT, supporting_slices TEXT, validation TEXT, notes TEXT, full_content TEXT, superseded_by TEXT). (5) Create `active_decisions` and `active_requirements` views. (6) WAL mode via `PRAGMA journal_mode=WAL` on open (file-backed only). (7) Typed wrappers: `insertDecision(d)`, `insertRequirement(r)`, `getDecisionById(id)`, `getRequirementById(id)`, `transaction(fn)`. (8) Write tests covering: schema init on fresh DB, double-init idempotency, insert + retrieve decisions, insert + retrieve requirements, view filtering with superseded rows, WAL mode on temp file DB, provider detection.
  - Verify: `npm run test:unit -- --test-name-pattern "gsd-db"`
  - Done when: All gsd-db tests pass. DB opens, schema inits, rows insert/query, views filter correctly, WAL mode confirmed on file-backed DB.

- [x] **T02: Context store query layer, formatters, fallback, and gitignore** `est:45m`
  - Why: Completes the slice contract — downstream slices need `queryDecisions()`, `queryRequirements()`, format functions for prompt injection, and the guarantee that missing DB doesn't crash. Retires R002, R005, R006, R017.
  - Files: `src/resources/extensions/gsd/context-store.ts`, `src/resources/extensions/gsd/gitignore.ts`, `src/resources/extensions/gsd/tests/context-store.test.ts`
  - Do: (1) Create `context-store.ts` with query functions: `queryDecisions(opts?: { milestoneId?, scope? })` returns `Decision[]` filtered from `active_decisions` view; `queryRequirements(opts?: { sliceId?, status? })` returns `Requirement[]` filtered from `active_requirements` view. (2) Format functions: `formatDecisionsForPrompt(decisions: Decision[]): string` renders a markdown table; `formatRequirementsForPrompt(requirements: Requirement[]): string` renders structured sections. (3) All query/format functions check `isDbAvailable()` and return empty string/array when DB is unavailable — never throw. (4) Add `gsd.db`, `gsd.db-wal`, `gsd.db-shm` to `BASELINE_PATTERNS` in `gitignore.ts` (scoped under `.gsd/`). (5) Write tests covering: query all active decisions, query by milestone, query by scope, query requirements by slice owner, query by status, format output contains expected columns/fields, superseded rows excluded from queries, fallback returns empty when DB not opened, sub-5ms timing assertion on query (insert 50 rows then query), gitignore patterns present.
  - Verify: `npm run test:unit -- --test-name-pattern "context-store"`
  - Done when: All context-store tests pass. Query functions return correct filtered results. Format output is clean prompt-injectable text. Fallback path returns empty without error. Gitignore updated.

## Files Likely Touched

- `src/resources/extensions/gsd/gsd-db.ts` (new)
- `src/resources/extensions/gsd/context-store.ts` (new)
- `src/resources/extensions/gsd/types.ts` (add Decision, Requirement types)
- `src/resources/extensions/gsd/gitignore.ts` (add DB sidecar patterns)
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` (new)
- `src/resources/extensions/gsd/tests/context-store.test.ts` (new)
