# Requirements

This file is the explicit capability and coverage contract for the project.

Use it to track what is actively in scope, what has been validated by completed work, what is intentionally deferred, and what is explicitly out of scope.

Guidelines:
- Keep requirements capability-oriented, not a giant feature wishlist.
- Requirements should be atomic, testable, and stated in plain language.
- Every **Active** requirement should be mapped to a slice, deferred, blocked with reason, or moved out of scope.
- Each requirement should have one accountable primary owner and may have supporting slices.
- Research may suggest requirements, but research does not silently make them binding.
- Validation means the requirement was actually proven by completed work and verification, not just discussed.

## Active

### R001 — SQLite DB layer with schema versioning
- Class: core-capability
- Status: active
- Description: A SQLite database at `.gsd/gsd.db` using `better-sqlite3` with typed wrappers, schema init, and forward-only versioned migrations
- Why it matters: Foundation for all structured storage — nothing else works without this
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01 — DB opens, schema inits with version table, typed wrappers work. S02 — Forward-only migration v1→v2 proven (artifacts table added without data loss).
- Notes: WAL mode enabled. Schema version tracked in `schema_version` table. Provider chain: node:sqlite → better-sqlite3 → null (D010).

### R002 — Graceful fallback to markdown if better-sqlite3 unavailable
- Class: failure-visibility
- Status: validated
- Description: If `better-sqlite3` fails to load (native addon build failure, unsupported platform), the system falls back to current markdown file loading with no crash
- Why it matters: GSD ships as an npm package to diverse environments — a native addon failure must not break the product
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: S01 — query/format functions return empty when DB unavailable, no crash. S03 — all 9 prompt builders fall back to inlineGsdRootFile when isDbAvailable() returns false; 52 test assertions verify fallback behavior.
- Notes: Fallback is transparent — same prompt output, just without token savings

### R003 — Markdown importers for all artifact types
- Class: core-capability
- Status: validated
- Description: Importers that parse existing markdown files (DECISIONS.md, REQUIREMENTS.md, roadmaps, plans, summaries, contexts, research, continues, queue, secrets manifest, PROJECT.md) into DB rows using existing parsers from `files.ts`
- Why it matters: Existing projects must seamlessly transition to DB storage without data loss
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: S02 — parseDecisionsTable, parseRequirementsSections, and importHierarchyArtifacts tested with 70 assertions. All artifact types imported and queryable. Round-trip fidelity verified.
- Notes: Custom parsers (not reusing files.ts parsers) for DECISIONS.md pipe-table and REQUIREMENTS.md section/bullet format. Hierarchy artifacts stored as full_content blobs.

### R004 — Silent auto-migration on first run
- Class: primary-user-loop
- Status: validated
- Description: On startup, if `.gsd/` exists with markdown files but no `gsd.db`, migration runs automatically with zero user interaction. One-line log summary.
- Why it matters: Must feel automagical — zero friction transition
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: S02 — Auto-migration wired into startAuto() with dynamic imports and try/catch guard. Compiles clean. Detects DECISIONS.md, REQUIREMENTS.md, or milestones/ before importing.
- Notes: Detection: no gsd.db + markdown files present → migrate. Atomic transaction wraps all inserts. Failure logs to stderr, never blocks auto-mode (D003, D014).

### R005 — Selective context queries for decisions
- Class: core-capability
- Status: validated
- Description: Query active (non-superseded) decisions scoped by milestone, slice, and/or scope category. `active_decisions` view eliminates superseded rows.
- Why it matters: A project with 50 decisions where 20 are superseded currently injects all 50. This eliminates the 20 irrelevant ones.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: S01 — queryDecisions with milestone/scope filters verified, superseded exclusion tested. S03 — milestone-scoped decisions wired into all 9 prompt builders; 43 test assertions prove scoped content delivery.
- Notes: Query patterns: planning gets milestone + global + architecture scope; task execution gets slice + architecture only

### R006 — Selective context queries for requirements
- Class: core-capability
- Status: validated
- Description: Query active (non-superseded) requirements filtered by status and/or slice ownership. `active_requirements` view eliminates superseded rows.
- Why it matters: Requirements with 30 entries (12+ lines each) get loaded in full even when the task touches 3
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: S01 — queryRequirements with slice/status filters verified, superseded exclusion tested. S03 — slice-filtered requirements wired into all 9 prompt builders; 43 test assertions prove scoped content delivery.
- Notes: Query patterns: planning gets all non-superseded; task execution gets only active mapped to current slice

### R007 — Context store query layer for all dispatch unit types
- Class: core-capability
- Status: validated
- Description: Typed query functions that return precisely the context needed for each dispatch unit type: research-milestone, plan-milestone, plan-slice, execute-task, complete-slice, complete-milestone, replan-slice, reassess-roadmap, run-uat
- Why it matters: Each unit type has different context needs — the query layer encodes the injection matrix from the PRD
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: S03 — queryArtifact, queryProject, queryDecisions (milestone/scope), queryRequirements (slice) wired into all 9 prompt builders per injection matrix. 52 test assertions in prompt-db.test.ts prove scoped content delivery and fallback.
- Notes: See PRD Section 5 for the full injection matrix per unit type

### R008 — Prompt builder rewiring
- Class: core-capability
- Status: validated
- Description: Replace `inlineGsdRootFile()` calls in all `build*Prompt()` functions with targeted DB queries via the context store. Prompt output is equivalent or better.
- Why it matters: This is the integration point — where token savings actually happen
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: S03 — all 19 inlineGsdRootFile call sites replaced with DB-aware helpers (inlineDecisionsFromDb, inlineRequirementsFromDb, inlineProjectFromDb). grep confirms zero direct usage in builders. 43 test assertions prove scoped content and fallback.
- Notes: Affects: buildResearchMilestonePrompt, buildPlanMilestonePrompt, buildPlanSlicePrompt, buildExecuteTaskPrompt, buildCompleteSlicePrompt, buildCompleteMilestonePrompt, buildReplanSlicePrompt, buildReassessRoadmapPrompt, buildRunUatPrompt

### R009 — Dual-write: markdown alongside DB
- Class: continuity
- Status: validated
- Description: When the DB is the source of truth, markdown files continue to be written alongside for human readability, git history, and rollback safety
- Why it matters: Preserves the human-readable file trail and provides a rollback path — delete gsd.db and fall back to markdown
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: M001/S06
- Validation: S03 — handleAgentEnd re-imports changed markdown files into DB via migrateFromMarkdown after auto-commit. 8 test assertions prove DB updates when source markdown changes. Re-import failure is non-fatal.
- Notes: Post-unit hooks or explicit write calls keep markdown in sync after DB writes. S06 will add tool-triggered dual-write for structured LLM tools.

### R010 — Built-in token measurement
- Class: differentiator
- Status: validated
- Description: Measure and log token counts per dispatch unit, showing before (markdown loading) vs after (DB query) savings
- Why it matters: User wants to see this is a good idea in practice — measurable proof, not trust
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: none
- Validation: S04 — promptCharCount/baselineCharCount fields in UnitMetrics, measurement wired into all 13 dispatch path call sites, values persisted in metrics.json. 5 grep matches in metrics.ts confirm fields. Clean compilation and 287 tests pass.
- Notes: Integrated into existing metrics system. Shows savings percentage per unit type.

### R011 — State derivation from DB
- Class: core-capability
- Status: validated
- Description: `deriveState()` reads from DB tables instead of scanning the `.gsd/` file tree and parsing markdown
- Why it matters: State derivation currently does O(N) file reads with batch native parsing. DB makes this a handful of indexed queries.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: none
- Validation: S04 — deriveState() queries artifacts table when DB available, falls back to native batch parse. 51-assertion derive-state-db test suite proves field-by-field equality across 7 scenarios (DB path, fallback, empty DB, partial DB, requirements, multi-milestone, cache invalidation).
- Notes: DB replaces content-reading step only; file discovery (milestone IDs, path resolution) still uses disk.

### R012 — Worktree DB isolation
- Class: core-capability
- Status: validated
- Description: Each GSD worktree gets its own `gsd.db` at its `.gsd/` root, copied from the source branch on worktree creation
- Why it matters: Worktrees are isolated workspaces — DB state must be isolated too
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: none
- Validation: S05 — copyWorktreeDb copies gsd.db (not WAL/SHM) to worktree, wired into createWorktree(). 37-assertion test suite proves copy correctness, non-fatal failure, and data queryability.
- Notes: Existing worktree creation in `auto-worktree.ts` and `worktree-manager.ts` needs DB copy logic

### R013 — Worktree row-level merge reconciliation
- Class: core-capability
- Status: validated
- Description: When a worktree merges back, row-level reconciliation occurs with conflict detection. Deterministic PKs use INSERT OR REPLACE; auto-increment PKs remap sequences; conflicting rows flagged for review.
- Why it matters: Git can't merge binary SQLite files — need explicit reconciliation logic
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: none
- Validation: S05 — reconcileWorktreeDb ATTACHes worktree DB, merges all 3 tables via INSERT OR REPLACE, detects conflicts. Wired into both deterministic and LLM merge paths. 37-assertion test suite proves merge, conflict detection, and edge cases.
- Notes: Three strategies per PRD: INSERT OR REPLACE for deterministic PKs, sequence remapping for auto-increment, conflict flagging for divergent modifications

### R014 — Structured LLM tools
- Class: core-capability
- Status: validated
- Description: Lightweight tool calls (gsd_save_decision, gsd_update_requirement, gsd_save_summary, etc.) that let the LLM write structured data directly to the DB, eliminating the markdown-then-parse roundtrip
- Why it matters: Eliminates the most fragile part of the pipeline — regex parsing of LLM-generated markdown
- Source: user
- Primary owning slice: M001/S06
- Supporting slices: none
- Validation: S06 — 35 test assertions prove all three tools register, execute with valid params, produce correct DB state, return structured results, handle DB unavailable, and regenerate markdown files. Round-trip fidelity proven via 127 assertions in db-writer tests.
- Notes: User emphasized "lightweight — whatever is fastest." Tools write to DB and trigger dual-write to markdown.

### R015 — /gsd inspect slash command
- Class: operability
- Status: validated
- Description: A `/gsd inspect` command that dumps DB contents for debugging — table counts, recent entries, schema version, query results
- Why it matters: When something goes wrong, need visibility into DB state without external tooling
- Source: user
- Primary owning slice: M001/S06
- Supporting slices: none
- Validation: S06 — 32 test assertions prove inspect output formatting with full data, empty data, null schema version, and output structure. Handler wired with autocomplete, DB availability check, and unknown-command help.
- Notes: Slash command inside pi, not a standalone CLI

### R016 — ≥30% token reduction in planning/research prompts
- Class: quality-attribute
- Status: validated
- Description: Planning and research dispatch unit prompts show at least 30% fewer tokens on projects with 20+ decisions and mature requirement sets
- Why it matters: The entire point — if this doesn't deliver measurable savings, the migration isn't worth it
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S03, M001/S07
- Validation: S04 — 99-assertion token-savings test with 24 decisions across 3 milestones and 21 requirements across 5 slices. Plan-slice: 52.2% savings. Decisions-only: 66.3% savings. Research composite: 32.2% savings. All exceed 30% threshold.
- Notes: Measured via built-in token measurement (R010). Fixture-proven; real project validation in S07.

### R017 — Sub-5ms query latency
- Class: quality-attribute
- Status: validated
- Description: All context store queries complete in <5ms on local disk
- Why it matters: Must feel instant — no perceptible delay in prompt building
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01 — 50 decisions + 50 requirements queried in 0.62ms. Test assertion enforces <5ms.
- Notes: SQLite on local disk with WAL mode. Validated by context-store.test.ts timing assertion.

### R018 — 100% migration fidelity
- Class: quality-attribute
- Status: validated
- Description: All data from markdown artifacts is recoverable from the DB after import — no silent data loss
- Why it matters: Trust in the migration — users must not lose project history
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: S02 — 70-assertion round-trip test suite. Decision fields (id, when_context, scope, decision, choice, rationale, revisable, superseded_by) verified. Requirement fields (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes) verified across all sections. Hierarchy artifacts content-checked.
- Notes: Validated by round-trip tests: import markdown → query from DB → compare field values.

### R019 — No regression in auto-mode output quality
- Class: quality-attribute
- Status: active
- Description: Auto-mode produces equivalent or better output quality with DB-backed context compared to markdown loading
- Why it matters: Token reduction must not come at the cost of output quality
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S07
- Validation: unmapped
- Notes: Validated by running a real project through full auto-mode cycle

### R020 — WAL mode enabled
- Class: quality-attribute
- Status: validated
- Description: SQLite database opened with WAL (Write-Ahead Logging) mode for concurrent read performance
- Why it matters: WAL allows concurrent readers without blocking, and is faster for the read-heavy workload
- Source: inferred
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01 — PRAGMA journal_mode returns 'wal' on file-backed DB. Test assertion in gsd-db.test.ts confirms.
- Notes: `PRAGMA journal_mode=WAL` on database open

### R021 — Schema designed for future vector search
- Class: constraint
- Status: validated
- Description: Schema uses stable PKs and structures that allow a future Rust crate to add embedding virtual tables to the same gsd.db without schema conflicts
- Why it matters: Phase 4 (vector search) must be able to bolt on without schema rewrites
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: S01 — Decisions use auto-increment `seq` PK, requirements use stable `id` PK. Schema structure verified in tests.
- Notes: Decisions use auto-increment `seq` as PK; requirements use stable `id` (R001, R002, ...). Both are joinable by future embedding tables.

## Validated

### R002 — Graceful fallback to markdown if better-sqlite3 unavailable
- Validated by: M001/S01 + M001/S03
- Proof: S01 — query/format functions return empty when DB unavailable. S03 — all 9 prompt builders fall back to inlineGsdRootFile when isDbAvailable() returns false; 52 test assertions verify fallback behavior. Full end-to-end fallback chain proven.

### R003 — Markdown importers for all artifact types
- Validated by: M001/S02
- Proof: 70-assertion test suite covering parseDecisionsTable, parseRequirementsSections, importHierarchyArtifacts, migrateFromMarkdown orchestrator. All artifact types imported and round-trip verified.

### R004 — Silent auto-migration on first run
- Validated by: M001/S02
- Proof: Auto-migration wired into startAuto() with dynamic imports and try/catch guard. Detects markdown files, opens DB, runs migrateFromMarkdown. Compiles clean, tested via compilation.

### R005 — Selective context queries for decisions
- Validated by: M001/S01 + M001/S03
- Proof: S01 — queryDecisions with milestone/scope filters verified, superseded exclusion tested. S03 — milestone-scoped decisions wired into all 9 prompt builders; 43 test assertions prove scoped content delivery and fallback.

### R006 — Selective context queries for requirements
- Validated by: M001/S01 + M001/S03
- Proof: S01 — queryRequirements with slice/status filters verified, superseded exclusion tested. S03 — slice-filtered requirements wired into all 9 prompt builders; 43 test assertions prove scoped content delivery and fallback.

### R007 — Context store query layer for all dispatch unit types
- Validated by: M001/S03
- Proof: queryArtifact, queryProject, queryDecisions (milestone/scope), queryRequirements (slice) wired into all 9 prompt builders per injection matrix. 52 test assertions in prompt-db.test.ts prove scoped content delivery and fallback.

### R008 — Prompt builder rewiring
- Validated by: M001/S03
- Proof: All 19 inlineGsdRootFile call sites replaced with DB-aware helpers. grep confirms zero direct usage in builders (7 remaining = 1 def + 3 fallback + 3 JSDoc). 43 test assertions prove scoped content and fallback.

### R009 — Dual-write: markdown alongside DB
- Validated by: M001/S03
- Proof: handleAgentEnd re-imports changed markdown files into DB via migrateFromMarkdown after auto-commit. 8 test assertions prove DB updates when source markdown changes. Re-import failure is non-fatal.

### R017 — Sub-5ms query latency
- Validated by: M001/S01
- Proof: 50 decisions + 50 requirements queried in 0.62ms. Test assertion in context-store.test.ts enforces <5ms.

### R018 — 100% migration fidelity
- Validated by: M001/S02
- Proof: 70-assertion round-trip test suite. All Decision and Requirement fields verified against source markdown. Hierarchy artifact content verified. Supersession chains preserved. Idempotent re-import confirmed.

### R020 — WAL mode enabled
- Validated by: M001/S01
- Proof: PRAGMA journal_mode returns 'wal' on file-backed DB. Test assertion in gsd-db.test.ts confirms.

### R021 — Schema designed for future vector search
- Validated by: M001/S01
- Proof: Decisions use auto-increment `seq` PK, requirements use stable `id` PK. Schema structure verified in gsd-db.test.ts.

### R010 — Built-in token measurement
- Validated by: M001/S04
- Proof: promptCharCount/baselineCharCount fields in UnitMetrics interface; measurement wired into all 13 dispatch path snapshotUnitMetrics call sites; values persisted in metrics.json. 5 grep matches in metrics.ts. Clean compilation, 287 tests pass.

### R011 — State derivation from DB
- Validated by: M001/S04
- Proof: deriveState() queries `SELECT path, full_content FROM artifacts` when DB available, populates fileContentCache. Falls back to native batch parse when unavailable. 51-assertion derive-state-db test suite proves field-by-field equality across 7 scenarios.

### R016 — ≥30% token reduction in planning/research prompts
- Validated by: M001/S04
- Proof: 99-assertion token-savings test with 24 decisions across 3 milestones, 21 requirements across 5 slices. Plan-slice: 52.2% savings. Decisions-only: 66.3%. Research composite: 32.2%. All exceed 30% threshold.

### R012 — Worktree DB isolation
- Validated by: M001/S05
- Proof: copyWorktreeDb copies gsd.db (not WAL/SHM) to worktree, wired into createWorktree(). 37-assertion test suite proves copy correctness, non-fatal failure, and data queryability.

### R013 — Worktree row-level merge reconciliation
- Validated by: M001/S05
- Proof: reconcileWorktreeDb ATTACHes worktree DB, merges all 3 tables via INSERT OR REPLACE, detects conflicts by comparing content columns. Wired into both deterministic and LLM merge paths. 37-assertion test suite proves merge, conflict detection, and edge cases.

### R014 — Structured LLM tools
- Validated by: M001/S06
- Proof: 35 test assertions prove gsd_save_decision, gsd_update_requirement, gsd_save_summary register, execute, write to DB, trigger markdown dual-write, return structured results, and handle DB unavailable. 127 db-writer assertions prove round-trip fidelity for generated markdown.

### R015 — /gsd inspect slash command
- Validated by: M001/S06
- Proof: 32 test assertions prove formatInspectOutput with full data, empty data, null schema version. Handler includes autocomplete, DB availability check, unknown-command help text.

## Deferred

### R030 — Vector search layer
- Class: differentiator
- Status: deferred
- Description: Rust crate (`native/crates/vecstore`) that opens the same gsd.db and adds embedding virtual tables for semantic context retrieval
- Why it matters: Enables "find the 5 decisions most relevant to this task" — the next level of context curation
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred to M002. Schema in M001 is designed to accommodate this.

### R031 — DB export command
- Class: operability
- Status: deferred
- Description: A `gsd db export` command that regenerates markdown files from DB contents for archival or migration
- Why it matters: Useful for debugging, backup, or moving to a system without SQLite
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Deferred — dual-write (R009) makes this less urgent since markdown files stay in sync

## Out of Scope

### R040 — Web UI/dashboard for DB contents
- Class: anti-feature
- Status: out-of-scope
- Description: No web interface for browsing or editing DB contents
- Why it matters: Prevents scope creep — CLI inspection via /gsd inspect is sufficient
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Explicitly excluded in PRD non-goals

### R041 — Multi-user/networked DB
- Class: anti-feature
- Status: out-of-scope
- Description: No support for multiple users or networked database access
- Why it matters: SQLite is single-process. GSD is an agent-local store, not a collaboration database.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Explicitly excluded in PRD non-goals

### R042 — Replacing git version control
- Class: anti-feature
- Status: out-of-scope
- Description: The DB does not replace git. Version control stays as-is. DB is local derived state.
- Why it matters: Prevents confusion about what the DB is for
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Explicitly excluded in PRD non-goals

### R043 — Real-time sync across machines
- Class: anti-feature
- Status: out-of-scope
- Description: No sync of DB state across machines. Each clone rebuilds from its own artifacts.
- Why it matters: Prevents over-engineering for a problem that doesn't exist
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Explicitly excluded in PRD non-goals

### R044 — Replacing prompt templates
- Class: anti-feature
- Status: out-of-scope
- Description: Static instruction text (prompts/*.md, templates/*.md) stays as markdown files. Only data artifacts move to DB.
- Why it matters: Prompt templates are static text, not queryable data — moving them to DB adds complexity with zero benefit
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Explicitly excluded in PRD non-goals

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | active | M001/S01 | none | S01+S02 partial |
| R002 | failure-visibility | validated | M001/S01 | M001/S03 | S01+S03 validated |
| R003 | core-capability | validated | M001/S02 | none | S02 validated |
| R004 | primary-user-loop | validated | M001/S02 | none | S02 validated |
| R005 | core-capability | validated | M001/S01 | M001/S03 | S01+S03 validated |
| R006 | core-capability | validated | M001/S01 | M001/S03 | S01+S03 validated |
| R007 | core-capability | validated | M001/S03 | none | S03 validated |
| R008 | core-capability | validated | M001/S03 | none | S03 validated |
| R009 | continuity | validated | M001/S03 | M001/S06 | S03 validated |
| R010 | differentiator | validated | M001/S04 | none | S04 validated |
| R011 | core-capability | validated | M001/S04 | none | S04 validated |
| R012 | core-capability | validated | M001/S05 | none | S05 validated |
| R013 | core-capability | validated | M001/S05 | none | S05 validated |
| R014 | core-capability | validated | M001/S06 | none | S06 validated |
| R015 | operability | validated | M001/S06 | none | S06 validated |
| R016 | quality-attribute | validated | M001/S04 | M001/S03, M001/S07 | S04 validated |
| R017 | quality-attribute | validated | M001/S01 | none | S01 validated |
| R018 | quality-attribute | validated | M001/S02 | none | S02 validated |
| R019 | quality-attribute | active | M001/S04 | M001/S07 | unmapped |
| R020 | quality-attribute | validated | M001/S01 | none | S01 validated |
| R021 | constraint | validated | M001/S01 | none | S01 validated |
| R030 | differentiator | deferred | none | none | unmapped |
| R031 | operability | deferred | none | none | unmapped |
| R040 | anti-feature | out-of-scope | none | none | n/a |
| R041 | anti-feature | out-of-scope | none | none | n/a |
| R042 | anti-feature | out-of-scope | none | none | n/a |
| R043 | anti-feature | out-of-scope | none | none | n/a |
| R044 | anti-feature | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 2
- Mapped to slices: 2
- Validated: 19 (R002, R003, R004, R005, R006, R007, R008, R009, R010, R011, R012, R013, R014, R015, R016, R017, R018, R020, R021)
- Unmapped active requirements: 0
