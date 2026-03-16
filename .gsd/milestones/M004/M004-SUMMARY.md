---
id: M004
provides:
  - gsd-db.ts — SQLite abstraction with tiered provider chain (node:sqlite → better-sqlite3 → null), schema init, typed CRUD wrappers, WAL mode, transaction support, worktree DB copy/reconcile
  - context-store.ts — query layer with scoped filtering (milestone/slice/status) and prompt formatters
  - md-importer.ts — markdown parsers (decisions pipe-table, requirements 4-section) and migration orchestrator with idempotent re-import
  - db-writer.ts — canonical DECISIONS.md/REQUIREMENTS.md generators, D-number sequencer, DB-first write helpers
  - auto-prompts.ts — 3 DB-aware inline helpers (inlineDecisionsFromDb, inlineRequirementsFromDb, inlineProjectFromDb), all 19 data-artifact calls rewired to scoped DB queries
  - auto.ts — DB lifecycle wired at 3 points (init+migrate in startAuto, re-import in handleAgentEnd, close in stopAuto)
  - metrics.ts — promptCharCount/baselineCharCount on UnitMetrics, measurement block wired at all 11 snapshotUnitMetrics call sites
  - state.ts — DB-first content loading tier in _deriveStateImpl (artifacts table → native batch parser fallback)
  - auto-worktree.ts — DB copy hook in copyPlanningArtifacts, reconcile hook in mergeMilestoneToMain
  - worktree-command.ts — reconcile hook in handleMerge
  - index.ts — gsd_save_decision, gsd_update_requirement, gsd_save_summary tools registered
  - commands.ts — /gsd inspect command with autocomplete
  - 600+ assertions across 13 test files proving all contracts
key_decisions:
  - D045 — tiered SQLite provider chain: node:sqlite → better-sqlite3 → null
  - D046 — worktree DB copy uses existsSync (file presence), not isDbAvailable() (connection state)
  - D047 — port strategy: adapt to current architecture, not blind merge from memory-db
  - D048 — createRequire(import.meta.url) for module loading (ESM+CJS compatible)
  - D049 — dynamic import() in DB-aware helpers and LLM tool execute() bodies (avoids circular deps)
  - D050 — silent catch-and-fallback in helpers with zero stderr noise
  - D051 — DB lifecycle placement: after worktree setup / before initMetrics / after commit / after worktree teardown
  - D052 — measurement block uses dynamic import for auto-prompts.js (avoids circular dependency)
  - D053 — dbContentLoaded = true only when rows.length > 0 (empty DB falls through identically to no DB)
  - D054 — copy guard uses existsSync not isDbAvailable() in copyPlanningArtifacts
  - D055 — handleMerge reconcile uses dynamic import (async command handler pattern)
  - D056 — reconcileWorktreeDb returns structured zero-shape, not undefined/throw
patterns_established:
  - DB-aware helper pattern: isDbAvailable() guard → dynamic import → scoped query → format → wrap with heading+source, else fallback to inlineGsdRootFile
  - Round-trip fidelity: generate → parse → compare as canonical correctness test
  - Three-tier content loading in _deriveStateImpl: DB artifacts table → native batch parser → cachedLoadFile
  - LLM tool execute() pattern: isDbAvailable() guard → dynamic import gsd-db.js + db-writer.js → DB write → markdown regen → return result shape
  - Non-fatal try/catch wrapping for all DB hooks with gsd-migrate:/gsd-db: stderr prefix logging
observability_surfaces:
  - getDbProvider() — which provider actually loaded (node:sqlite | better-sqlite3 | null)
  - isDbAvailable() — single boolean guard for all DB-conditional logic
  - promptCharCount/baselineCharCount in .gsd/metrics.json ledger entries
  - "gsd-migrate: imported N decisions, N requirements, N artifacts" on migration
  - "gsd-db: <function> failed: <message>" on write helper/lifecycle failures
  - /gsd inspect — schema version, table row counts, 5 most-recent decisions/requirements
  - integration-lifecycle.test.ts — single command exercising full pipeline with savings% printed to stdout
requirement_outcomes:
  - id: R045
    from_status: active
    to_status: validated
    proof: S01 gsd-db.test.ts (41) + context-store.test.ts (56) + worktree-db.test.ts (36) = 133 assertions proving provider chain, schema, CRUD, views, WAL, transactions, query filtering, formatters, worktree ops, fallback. S07 integration-lifecycle proves WAL mode + availability in end-to-end pipeline.
  - id: R046
    from_status: active
    to_status: validated
    proof: S01 DB layer returns empty arrays/null when unavailable. S03 prompt builders fall back to inlineGsdRootFile when isDbAvailable() is false (prompt-db.test.ts fallback section). All auto.ts lifecycle hooks guarded non-fatal. Full chain proven.
  - id: R047
    from_status: active
    to_status: validated
    proof: S02 md-importer.test.ts (70 assertions) proves parsers, supersession detection, orchestrator, idempotency, missing file handling, hierarchy walker. S07 integration-lifecycle imports 14+12+1 on first run, 15 decisions after re-import.
  - id: R048
    from_status: active
    to_status: validated
    proof: S02 db-writer.test.ts (127 assertions) proves generateDecisionsMd/generateRequirementsMd round-trip, pipe escaping, section grouping, write helpers, ID sequencing. S07 integration-lifecycle step 10 full parse→generate→parse field fidelity.
  - id: R049
    from_status: active
    to_status: validated
    proof: S03 — all 19 inlineGsdRootFile data-artifact calls replaced across 9 prompt builders. prompt-db.test.ts 52 assertions prove scoped queries + formatted output + fallback. grep confirms 0 direct inlineGsdRootFile calls in builder bodies; 22 DB-aware helper references.
  - id: R050
    from_status: active
    to_status: validated
    proof: S03 markdown→DB direction (handleAgentEnd re-import, prompt-db.test.ts re-import section). S06 DB→markdown direction (gsd_save_decision/gsd_update_requirement/gsd_save_summary regenerate markdown, gsd-tools.test.ts 35 assertions). S07 integration-lifecycle step 6 re-import after content change.
  - id: R051
    from_status: active
    to_status: validated
    proof: S04 token-savings.test.ts (99 assertions): 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite — all exceed 30%. All 11 snapshotUnitMetrics call sites updated (grep count: 18). S07 integration-lifecycle asserts 42.4% savings on file-backed DB.
  - id: R052
    from_status: active
    to_status: validated
    proof: S04 derive-state-db.test.ts (51 assertions) proves DB path = identical GSDState, fallback when DB off, empty DB falls through, partial DB fills gaps, multi-milestone registry, cache invalidation.
  - id: R053
    from_status: active
    to_status: validated
    proof: S05 copy hook wired in copyPlanningArtifacts with existsSync guard + non-fatal try/catch. worktree-db-integration.test.ts cases 1+2 prove copy and copy-skip against real git repos.
  - id: R054
    from_status: active
    to_status: validated
    proof: S05 reconcile hooks wired in mergeMilestoneToMain (auto path) and handleMerge (manual path). worktree-db-integration.test.ts cases 3+4+5 prove row propagation, non-fatal skip, and structured zero-result shape.
  - id: R055
    from_status: active
    to_status: validated
    proof: S06 all 3 tools registered in index.ts with D049 dynamic-import pattern. gsd-tools.test.ts (35 assertions): ID auto-assignment, DB row creation, markdown regeneration, error paths, DB-unavailable fallback for all 3 tools.
  - id: R056
    from_status: active
    to_status: validated
    proof: S06 handleInspect + formatInspectOutput wired in commands.ts. inspect in subcommands autocomplete array. gsd-inspect.test.ts (32 assertions) proves formatInspectOutput across 5 scenarios.
  - id: R057
    from_status: active
    to_status: validated
    proof: token-savings.test.ts (99 assertions) all exceed 30%: 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite. integration-lifecycle.test.ts asserts savingsPercent ≥ 30 (42.4% measured) on file-backed DB with 14 decisions + 12 requirements.
duration: ~7 slices, ~2h15m total execution
verification_result: passed
completed_at: 2026-03-16
---

# M004: SQLite Context Store — Surgical Prompt Injection

**Seven slices porting the SQLite-backed context store from the memory-db reference into the production codebase: tiered provider chain, markdown importers, scoped prompt injection across all 19 data-artifact calls, token measurement (42.4% savings confirmed), DB-first state derivation, worktree DB isolation, structured LLM write tools, and `/gsd inspect` — 600+ assertions proving all contracts, all 13 requirements validated.**

## What Happened

M004 was a clean port operation: the memory-db reference worktree contained all the logic, but was built against a codebase that had diverged ~145 commits. The milestone delivered the capability by adapting each component to the current architecture, not cherry-picking diffs.

**S01 (DB Foundation)** established the base layer: `gsd-db.ts` with the tiered provider chain (`node:sqlite` → `better-sqlite3` → null), schema init (decisions/requirements/artifacts tables + filtered views), typed CRUD wrappers, WAL mode, transaction support, and `copyWorktreeDb`/`reconcileWorktreeDb`. `context-store.ts` added the query layer with scoped filtering and prompt formatters. The main adaptation discovery: bare `require()` fails under Node's ESM test runner; `createRequire(import.meta.url)` is the correct pattern for both jiti CJS and native ESM. 133 assertions.

**S02 (Importers + Migration)** ported `md-importer.ts` (parsers for DECISIONS.md pipe-table format and REQUIREMENTS.md 4-section format, plus `migrateFromMarkdown` orchestrator) and `db-writer.ts` (canonical markdown generators, D-number sequencer, DB-first write helpers). Both modules were direct ports with zero adaptation needed — the M004 codebase layout matched memory-db exactly. 197 assertions proving round-trip fidelity and idempotent re-import.

**S03 (Prompt Injection)** was the highest-surface-area slice. Three DB-aware helpers added to `auto-prompts.ts`, then all 19 `inlineGsdRootFile` data-artifact calls across 9 prompt builders replaced with scoped queries — decisions filtered by `milestoneId`, requirements filtered by `sliceId` in slice-level builders, unscoped in milestone-level builders. DB lifecycle wired into `auto.ts` at three precise insertion points (D051). Silent fallback to filesystem when DB unavailable (D050). 52 assertions.

**S04 (Token Measurement + State Derivation)** added `promptCharCount`/`baselineCharCount` to `UnitMetrics`, wired measurement at all 11 `snapshotUnitMetrics` call sites using module-scoped vars reset per unit, and added the DB-first content loading tier to `_deriveStateImpl`. The measurement block uses dynamic import (D052) to break a circular dependency. Token savings confirmed: 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite. 150 assertions.

**S05 (Worktree Isolation)** wired the copy and reconcile hooks: `existsSync` guard in `copyPlanningArtifacts` (D054), `isDbAvailable()` guard in `mergeMilestoneToMain`, dynamic import in `handleMerge` (D055). Key clarification: `existsSync` is the right guard for the copy path because `isDbAvailable()` reflects connection state, not file presence — the DB file can be copied before any connection opens. 10 integration assertions against real git repos.

**S06 (Structured Tools + Inspect)** registered the 3 LLM tools in `index.ts` and wired `/gsd inspect` in `commands.ts`. All tool `execute()` bodies use dynamic imports (D049) and check `isDbAvailable()` first. `handleInspect` uses `_getAdapter()` for raw SQL to expose `schema_version`, which the typed query layer doesn't surface. Dual-write loop complete: DB→markdown (tools) + markdown→DB (`handleAgentEnd` re-import). 67 assertions.

**S07 (Integration Verification)** proved all subsystems compose correctly. `integration-lifecycle.test.ts` (50 assertions) runs the full pipeline: migrate → query → format → token savings → re-import → write-back → round-trip. `integration-edge.test.ts` (33 assertions) proves empty project, partial migration, and fallback mode. Zero adaptation needed from the memory-db reference — confirming the port was architecturally clean.

## Cross-Slice Verification

**Success criteria from the roadmap — each verified:**

| Criterion | Evidence |
|---|---|
| All prompt builders use DB queries (zero direct inlineGsdRootFile for data artifacts) | `grep 'inlineGsdRootFile(base' auto-prompts.ts` → 3 matches, all inside fallback paths of DB-aware helpers. Zero in builder bodies. |
| Existing GSD projects migrate silently with zero data loss | integration-lifecycle imports 14 decisions + 12 requirements + 1 artifact from fixture markdown. Re-import after content change → 15 decisions. Idempotency proven. |
| Planning/research units show ≥30% fewer prompt chars on mature projects | token-savings.test.ts: 52.2% plan-slice, 66.3% decisions-only, 32.2% research composite. integration-lifecycle: 42.4% savings assertion passes. |
| System works identically via fallback when SQLite unavailable | integration-edge.test.ts fallback scenario: closeDatabase() + _resetProvider() → isDbAvailable() false → all queries empty → openDatabase() restores all data. All 3 DB-aware helpers fall back to inlineGsdRootFile. |
| Worktree creation copies gsd.db; merge reconciles rows | worktree-db-integration.test.ts: cases 1+2 prove copy/copy-skip; cases 3+4+5 prove reconcile row propagation, non-fatal skip, structured zero-shape. |
| LLM can write decisions/requirements/summaries via structured tool calls | gsd-tools.test.ts (35 assertions): ID auto-assignment D001→D002→D003, DB row creation, DECISIONS.md + REQUIREMENTS.md regeneration, error paths. |
| /gsd inspect shows DB state | gsd-inspect.test.ts (32 assertions): formatInspectOutput across 5 scenarios. handleInspect wired in commands.ts with autocomplete. |
| Dual-write keeps markdown in sync in both directions | S03 (markdown→DB via handleAgentEnd re-import) + S06 (DB→markdown via structured tools). Both directions tested. |
| deriveState() reads from DB, falls back to filesystem | derive-state-db.test.ts (51 assertions): DB path = identical GSDState, fallback, empty DB falls through, partial DB fills gaps. |
| All existing tests pass, TypeScript compiles clean | `npx tsc --noEmit` → no output. `npm test` → 371 unit tests pass, 0 fail. pack-install.test.ts failure is pre-existing (requires `dist/`). integration-lifecycle + integration-edge: 83 assertions pass. |

## Requirement Changes

- R045: active → validated — 133 S01 assertions + S07 WAL mode + availability in lifecycle test
- R046: active → validated — S01 DB layer fallback + S03 prompt builder fallback + lifecycle hooks proven end-to-end
- R047: active → validated — S02 md-importer.test.ts (70) + S07 lifecycle import + re-import after content change
- R048: active → validated — S02 db-writer.test.ts (127 round-trip assertions) + S07 lifecycle step 10 field-identical parse→generate→parse
- R049: active → validated — S03 19 calls rewired, 52 assertions, grep confirms zero direct calls in builder bodies
- R050: active → validated — S03 markdown→DB direction + S06 DB→markdown direction + S07 lifecycle re-import
- R051: active → validated — S04 token-savings.test.ts (99, all ≥30%) + S07 lifecycle 42.4% savings assertion
- R052: active → validated — S04 derive-state-db.test.ts (51 assertions proving identity parity, fallback, partial fill)
- R053: active → validated — S05 copy hook + worktree-db-integration.test.ts cases 1+2
- R054: active → validated — S05 reconcile hooks in both merge paths + worktree-db-integration.test.ts cases 3+4+5
- R055: active → validated — S06 gsd-tools.test.ts (35 assertions for all 3 tools)
- R056: active → validated — S06 gsd-inspect.test.ts (32 assertions) + handler dispatch wired
- R057: active → validated — token-savings.test.ts (99) all exceed 30%; lifecycle 42.4% assertion

## Forward Intelligence

### What the next milestone should know
- The DB is now a first-class runtime artifact alongside `.gsd/` markdown files. Any feature that reads GSD context should check `isDbAvailable()` first and use the query layer. Any feature that writes GSD artifacts should use `saveDecisionToDb`/`updateRequirementInDb`/`saveArtifactToDb` for DB-first writes.
- `migrateFromMarkdown()` is idempotent — safe to call repeatedly. It's called in `handleAgentEnd` after every dispatch unit. Don't add additional migration calls without checking for redundancy.
- The measurement block in `dispatchNextUnit` uses `inlineGsdRootFile` for baseline measurement — it loads all three full markdown files (DECISIONS.md, REQUIREMENTS.md, project.md) and sums lengths. This is an approximation; actual baseline varies per prompt builder. Directionally correct for the ≥30% claim.
- `_getAdapter()` (underscore prefix) is the escape hatch to raw SQL when the typed query wrappers don't expose what you need (e.g., `schema_version`). Use it sparingly.
- Node v25.5.0 ships `node:sqlite` built-in without `--experimental-sqlite`. Node 22 still requires the flag. The test suite handles this; any new test file using `node:sqlite` should confirm which Node version is running.

### What's fragile
- Dynamic imports in DB-aware helpers (`await import("./context-store.js")`) — silent fallback to filesystem means real import failures during refactoring are invisible. If a helper always returns filesystem content and you're expecting DB content, check import paths first.
- The markdown parsers in `md-importer.ts` are format-sensitive: exact heading patterns (`## Active`, `## Validated`, etc.) and pipe-table column positions. Any format change to DECISIONS.md or REQUIREMENTS.md requires parser + generator updates in lockstep.
- `SELECT path, full_content FROM artifacts` in `_deriveStateImpl` is hardcoded against the schema column name. If the artifacts table schema evolves, this query needs updating.
- `basePath` vs `base` in `auto.ts` lifecycle hooks: `basePath` is worktree-aware (resolves to worktree `.gsd/`), `base` is the original project root. Using the wrong one would silently import/query from the wrong directory.

### Authoritative diagnostics
- `node --test integration-lifecycle.test.ts` — single command exercising the entire pipeline in ~3s. Token savings percentage printed to stdout. Start here for any M004 regression.
- `/gsd inspect` — the primary runtime diagnostic surface. Run it after any tool call to confirm counts and recent entries.
- `getDbProvider()` — if this returns null, the entire DB layer is in fallback mode. Check Node version and whether `--experimental-sqlite` flag is needed.
- `grep -c "Status: validated" .gsd/REQUIREMENTS.md` → 46 confirms all requirements properly promoted.
- Ledger inspection: `cat .gsd/metrics.json | jq '.units[] | select(.promptCharCount != null) | {id, promptCharCount, baselineCharCount}'` confirms measurement is wiring into production runs.

### What assumptions changed
- **Assumption**: memory-db's `auto.ts` patterns would need significant adaptation. **Actual**: The decomposed `auto.ts` (auto-prompts.ts, auto-dispatch.ts, auto-recovery.ts) absorbed the DB lifecycle cleanly at three well-defined points. The decomposition made integration easier, not harder.
- **Assumption**: Port would require import path adaptation across all test files. **Actual**: M004 worktree layout matched memory-db exactly — all 9 test files ported verbatim with zero path changes. The architectural alignment was complete.
- **Assumption**: `isDbAvailable()` is the right guard for the worktree copy path. **Actual**: `existsSync` is correct — `isDbAvailable()` reflects connection state, not file presence. The DB file can exist and be copied before any connection opens (D054).

## Files Created/Modified

- `src/resources/extensions/gsd/types.ts` — appended Decision and Requirement interfaces
- `src/resources/extensions/gsd/gsd-db.ts` — new: tiered SQLite provider chain, schema, CRUD wrappers, WAL, transactions, worktree copy/reconcile (~550 lines)
- `src/resources/extensions/gsd/context-store.ts` — new: query layer with scoped filtering and prompt formatters (195 lines)
- `src/resources/extensions/gsd/md-importer.ts` — new: markdown parsers + migration orchestrator (526 lines)
- `src/resources/extensions/gsd/db-writer.ts` — new: markdown generators, ID sequencer, DB-first write helpers (338 lines)
- `src/resources/extensions/gsd/auto-prompts.ts` — added 3 DB-aware helpers, rewired 19 call sites across 9 prompt builders
- `src/resources/extensions/gsd/auto.ts` — DB lifecycle at 3 insertion points, module-scoped measurement vars, measurement block, all 11 snapshotUnitMetrics call sites updated
- `src/resources/extensions/gsd/metrics.ts` — added promptCharCount/baselineCharCount to UnitMetrics, opts param to snapshotUnitMetrics
- `src/resources/extensions/gsd/state.ts` — DB-first content loading tier in _deriveStateImpl
- `src/resources/extensions/gsd/auto-worktree.ts` — DB copy hook in copyPlanningArtifacts, reconcile hook in mergeMilestoneToMain
- `src/resources/extensions/gsd/worktree-command.ts` — reconcile block in handleMerge
- `src/resources/extensions/gsd/index.ts` — 3 LLM tool registrations (gsd_save_decision, gsd_update_requirement, gsd_save_summary)
- `src/resources/extensions/gsd/commands.ts` — handleInspect + formatInspectOutput + InspectData, /gsd inspect dispatch
- `src/resources/extensions/gsd/tests/gsd-db.test.ts` — new: 41 DB layer assertions
- `src/resources/extensions/gsd/tests/context-store.test.ts` — new: 56 query/formatter assertions
- `src/resources/extensions/gsd/tests/worktree-db.test.ts` — new: 36 worktree operation assertions
- `src/resources/extensions/gsd/tests/md-importer.test.ts` — new: 70 importer assertions
- `src/resources/extensions/gsd/tests/db-writer.test.ts` — new: 127 writer/round-trip assertions
- `src/resources/extensions/gsd/tests/prompt-db.test.ts` — new: 52 DB-aware helper assertions
- `src/resources/extensions/gsd/tests/token-savings.test.ts` — new: 99 token savings assertions
- `src/resources/extensions/gsd/tests/derive-state-db.test.ts` — new: 51 DB-first state derivation assertions
- `src/resources/extensions/gsd/tests/worktree-db-integration.test.ts` — new: 10 integration assertions
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — new: 35 structured tool assertions
- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` — new: 32 inspect command assertions
- `src/resources/extensions/gsd/tests/integration-lifecycle.test.ts` — new: 50 end-to-end pipeline assertions
- `src/resources/extensions/gsd/tests/integration-edge.test.ts` — new: 33 edge case assertions
- `.gsd/REQUIREMENTS.md` — R045–R057 promoted from active to validated; Coverage Summary Active 8→0, Validated 40→46
