// GSD2 — ADR-013: Memory Store Consolidation

# ADR-013: Memory Store Consolidation

**Status:** Accepted
**Date:** 2026-04-19
**Author:** Jeremy (@jeremymcs)
**Related:** PR #4469 (memory tools Phase 1), commits f4bd65a8 / 59e1f830 / 03f77f36 / 9d9ccfe8 / fc6c93c2 (Phase 2-5), Issue #4495, PR #4496

## Context

After PR #4469 landed, GSD has **two parallel knowledge persistence surfaces** that overlap in purpose but not in interface, schema, or auto-injection behavior:

| Surface | Persistence | Auto-injected? | Schema | LLM-callable write | MCP-readable |
|---|---|---|---|---|---|
| `decisions` table | DB-backed; `.gsd/DECISIONS.md` is a projection | Yes — `inlineDecisionsFromDb` (`src/resources/extensions/gsd/auto-prompts.ts:336`) | Structured: `scope`, `decision`, `choice`, `rationale`, `made_by`, `revisable` | `gsd_save_decision` | Yes (`gsd_knowledge`, `gsd_save_decision`) |
| `.gsd/KNOWLEDGE.md` | File-canonical (no DB) | Yes — `loadKnowledgeBlock` (`src/resources/extensions/gsd/bootstrap/system-context.ts`) | Three markdown tables: Rules / Patterns / Lessons | Direct file append (no tool) | Yes (`gsd_knowledge`) |
| `memories` table | DB-backed (`src/resources/extensions/gsd/bootstrap/memory-tools.ts`) | **No** | Flat: `category` (architecture / convention / gotcha / pattern / preference / environment), `content`, `confidence`, tags | `capture_thought`, `memory_query`, `gsd_graph` | **No** |

A 3-agent parallel audit (Issue #4495) found:

- Zero of 50+ files in `src/resources/extensions/gsd/prompts/` reference `capture_thought` / `memory_query` / `gsd_graph`.
- Restrictive agent frontmatter (`src/resources/agents/researcher.md:4`, `src/resources/agents/scout.md:4`) silently excludes the new tools.
- `packages/mcp-server/src/server.ts:807-816` registers a *different* tool also named `gsd_graph` (project knowledge graph from `.gsd/` artifacts) — name collision with the memory `gsd_graph` (supersedes-edge walker).
- `src/resources/extensions/gsd/tests/commands-extract-learnings.test.ts:248,268` has #4429 regression guards asserting the extract-learnings prompt does NOT reference `capture_thought` / `gsd_graph`. The guard comments call them "non-existent" — a description that became stale when PR #4469 landed.

The two surfaces are not just redundant; they fragment durable knowledge across different retrieval paths, neither of which is complete on its own.

## Decision

**Consolidate to the `memories` table as the single source of truth for cross-session durable knowledge.** Migrate via a six-step plan executed across separate commits on PR #4496. Until step 6 lands, dual-write into both surfaces — never silently drop a legacy write before its replacement is observably equivalent.

### Source-of-truth boundaries (post-cutover)

| Artifact | Role |
|---|---|
| `memories` table | **Canonical** durable knowledge store. All `capture_thought` writes land here. All `memory_query` reads come from here. Auto-injected via a new `loadMemoryBlock` analogous to `loadKnowledgeBlock`. |
| `.gsd/DECISIONS.md` | **Read-only projection** rendered from `memories` rows where `category = "architecture"`. Continues to satisfy human review and external MCP consumers. |
| `.gsd/KNOWLEDGE.md` | **Read-only projection** rendered from `memories` rows where `category in ("pattern", "convention", "gotcha")`. Continues to satisfy human review and external MCP consumers. Rules table (manually authored via `/gsd knowledge`) is a separate concern and is **not** migrated. |
| `.gsd/milestones/*/M*-LEARNINGS.md` | **Audit trail** of each extraction. Unchanged — written by `buildExtractionStepsBlock` Step 2; never read back by automation. |
| `decisions` table | **Removed** in step 6 after backfill into `memories` completes. |

### Migration plan (six commits on PR #4496)

1. **Phase 0 ADR (this document).**
2. **Add `structuredFields` JSON column to `memories` table.** Preserves the structured fields `gsd_save_decision` records today (`scope`, `decision`, `choice`, `rationale`, `made_by`, `revisable`) so a row migrated from `decisions` retains schema fidelity. The `capture_thought` tool gains an optional `structuredFields` parameter that mirrors the same shape.
3. **Register `capture_thought` and `memory_query` in `packages/mcp-server/src/server.ts`.** Resolve the `gsd_graph` name collision by renaming the memory variant to `gsd_memory_graph` (or namespacing similarly). External MCP clients (studio, vscode-extension) gain access to the new surface before any cutover removes their current sources.
4. **Auto-injection parity in `src/resources/extensions/gsd/bootstrap/system-context.ts`.** Implement `loadMemoryBlock` mirroring `loadKnowledgeBlock`: query top-N highest-confidence and most-reinforced memories scoped to the project, inject on `before_agent_start`. After this lands, `memory_query` becomes a discretionary refinement, not the only path to retrieval.
5. **Backfill `decisions` -> `memories`.** Idempotent migration runs on the next `session_start` after a migration version bump. Each `decisions` row produces a `memories` row with `category = "architecture"`, `content` synthesised from `decision + choice + rationale`, and `structuredFields` populated verbatim. Re-running the migration is a no-op (matched on `structuredFields.sourceDecisionId`).
6. **Cutover.** Remove KNOWLEDGE.md / DECISIONS.md / `gsd_save_decision` write paths from `buildExtractionStepsBlock`, `execute-task.md`, `complete-slice.md`. Replace with single `capture_thought` calls. Re-render DECISIONS.md and KNOWLEDGE.md from the `memories` table on every project mutation that touches them. Update remaining #4429 regression tests. Deprecate the `decisions` table (read-only for one minor version, then drop).

### Cutover criteria

Step 6 may land only when **all** of the following are observable on `feat/memory-tools-dual-write`:

- Step 4 auto-injection produces a memory block measurably similar in coverage to the current KNOWLEDGE.md inline injection on at least three real GSD projects (manual spot check).
- Step 5 backfill is idempotent (rerunnable with no diff) on at least one real `.gsd/gsd.db` that contains historical decisions.
- MCP `capture_thought` and `memory_query` calls succeed end-to-end from a non-CLI client (studio or vscode integration test).
- No regression test in `src/resources/extensions/gsd/tests/` is silenced or removed without an explicit rationale comment in the diff.
- A two-week dual-write bake period elapses with no in-flight project reporting lost decisions or knowledge entries.

### Rollback plan

The dual-write design is its own rollback. Any step 1-5 commit can be reverted in isolation:

- Steps 1-3 are additive (new column, new tool registration, new MCP exposure). Reverting removes the addition without affecting legacy paths.
- Step 4 (auto-injection) is purely a context expansion. Revert removes the new block; legacy `loadKnowledgeBlock` and `inlineDecisionsFromDb` continue unchanged.
- Step 5 (backfill) writes new rows; revert deletes rows where `structuredFields.sourceDecisionId IS NOT NULL`.
- Step 6 (cutover) is the only destructive step. Its rollback is a revert that restores the dual-write code paths. Any new memories written between cutover and rollback are preserved (still in the `memories` table); legacy surfaces resume receiving new writes from the next operation forward.

If step 6 must be rolled back after the `decisions` table is dropped, a forward fix re-creates the table from `memories` rows with `structuredFields IS NOT NULL` — the structured fields blob exists precisely so that this projection is lossless.

## Consequences

### Positive

- One canonical knowledge store. Future tools (semantic retrieval, knowledge graph traversal, decay scoring) operate on a single table instead of being implemented twice.
- MCP parity: external clients gain access to the new surface as a precondition of cutover, not as an afterthought.
- The `gsd_graph` name collision (memory tool vs project knowledge graph tool) is resolved by step 3 before either surface depends on the other.
- Regression tests stop guarding against tools that exist (#4429 stale guards). Asserting the dual-write contract makes the migration's intent self-documenting.

### Caveats

- KNOWLEDGE.md and DECISIONS.md become projections. Manual edits are already overwritten today (DECISIONS.md is DB-projected) — the change extends that contract to KNOWLEDGE.md, which currently accepts manual appends. Anyone hand-editing KNOWLEDGE.md after step 6 will see their changes discarded on the next render. The migration commits include a one-time scan that warns if any KNOWLEDGE.md row in the working tree has no corresponding `memories` row at cutover time.
- `category` enum is fixed at six values (`architecture | convention | gotcha | pattern | preference | environment`). Adding a seventh requires a schema change. The current set is adequate for the migration; future categories are out of scope for this ADR.
- The `structuredFields` blob is intentionally schemaless inside the JSON. Schema for `architecture`-category memories is documented in step 2's commit; future categories may grow their own structured shapes.

### Excluded from scope

- `src/resources/agents/scout.md` keeps its read-only contract — orchestrator captures, scout doesn't. The audit confirmed adding `capture_thought` to scout would violate the agent's stated purpose.
- The `## Rules` table inside `.gsd/KNOWLEDGE.md` is manually authored via `/gsd knowledge` and is a different concern; not migrated.
- The auto-extraction memory pipeline at `packages/pi-coding-agent/src/resources/extensions/memory/` (a separate `memory_summary.md` injection from session transcripts) is independent of this consolidation. Whether to merge those two memory surfaces is a follow-up ADR.

### Follow-ups

- After cutover bakes (one minor version), evaluate whether to merge the auto-extraction memory pipeline (`packages/pi-coding-agent/src/resources/extensions/memory/`) into the same `memories` table.
- Semantic (embedding) retrieval was scaffolded in Phase 3 (commit `03f77f36`) but is keyword-only at the call sites this ADR covers. Re-evaluate after step 4 lands; the auto-injection block is a natural place for embedding-ranked retrieval.
