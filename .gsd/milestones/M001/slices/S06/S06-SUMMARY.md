---
id: S06
parent: M001
milestone: M001
provides:
  - gsd_save_decision tool — records decisions to DB with auto-assigned IDs and regenerates DECISIONS.md
  - gsd_update_requirement tool — updates existing requirements in DB and regenerates REQUIREMENTS.md
  - gsd_save_summary tool — saves artifacts (summary/research/context/assessment) to DB and disk
  - /gsd inspect slash command — dumps schema version, table counts, and recent decisions/requirements
  - generateDecisionsMd — generates DECISIONS.md from Decision[]
  - generateRequirementsMd — generates REQUIREMENTS.md from Requirement[]
  - saveDecisionToDb, updateRequirementInDb, saveArtifactToDb — DB-first write helpers with dual-write
requires:
  - slice: S03
    provides: context-store.ts query layer, dual-write infrastructure, gsd-db.ts typed insert/update wrappers
  - slice: S01
    provides: gsd-db.ts openDatabase, initSchema, isDbAvailable, _getAdapter
affects:
  - S07
key_files:
  - src/resources/extensions/gsd/db-writer.ts
  - src/resources/extensions/gsd/index.ts
  - src/resources/extensions/gsd/commands.ts
  - src/resources/extensions/gsd/tests/db-writer.test.ts
  - src/resources/extensions/gsd/tests/gsd-tools.test.ts
  - src/resources/extensions/gsd/tests/gsd-inspect.test.ts
key_decisions:
  - Used _getAdapter() directly for fetching all decisions/requirements in generators instead of getActiveDecisions/getActiveRequirements, because DECISIONS.md contains ALL rows and REQUIREMENTS.md needs all non-superseded rows
  - Tools return isError with structured details.error field matching google-search pattern, not throwing exceptions
  - Extracted formatInspectOutput as a pure exported function for testability
patterns_established:
  - DB-first write pattern: upsert to DB → fetch all rows → generate markdown → write file via saveFile()
  - Tool registration with TypeBox schemas, promptSnippet, and promptGuidelines following google-search extension pattern
  - DB availability check at tool entry with early isError return before any dynamic imports
  - Dynamic import of gsd-db.js inside async functions with try/catch (D014 compliance)
observability_surfaces:
  - /gsd inspect command — primary diagnostic for DB state verification
  - Tool results include isError: true with details.error for DB unavailable, not-found, and invalid input conditions
  - stderr logs with gsd-db: prefix on all write helper and tool execution failures
  - Structured details on every tool result: details.operation, details.id/path on success, details.error on failure
drill_down_paths:
  - .gsd/milestones/M001/slices/S06/tasks/T01-SUMMARY.md
  - .gsd/milestones/M001/slices/S06/tasks/T02-SUMMARY.md
  - .gsd/milestones/M001/slices/S06/tasks/T03-SUMMARY.md
duration: 52m
verification_result: passed
completed_at: 2026-03-15
---

# S06: Structured LLM Tools + /gsd inspect

**Three structured LLM tools (gsd_save_decision, gsd_update_requirement, gsd_save_summary) and /gsd inspect slash command, eliminating the markdown-then-parse roundtrip for decisions, requirements, and summaries**

## What Happened

Built the DB→markdown generation layer, registered three LLM-callable tools, and added a diagnostic inspect command across three tasks.

**T01** created `db-writer.ts` with 6 exports: `generateDecisionsMd` and `generateRequirementsMd` produce full markdown file content from DB row arrays, `nextDecisionId` auto-assigns the next D-number, and `saveDecisionToDb`/`updateRequirementInDb`/`saveArtifactToDb` implement the DB-first write pattern (upsert to DB → fetch all rows → generate markdown → write file). The critical invariant — round-trip fidelity — was proven: generated markdown parses back to field-identical data through existing `parseDecisionsTable` and `parseRequirementsSections` parsers.

**T02** registered three `pi.registerTool()` tools in `index.ts` following the google-search extension pattern: TypeBox parameter schemas, promptSnippet/promptGuidelines for system prompt injection, and execute functions with DB availability checks and structured error returns. `gsd_save_decision` auto-assigns IDs so the LLM never guesses. `gsd_update_requirement` verifies the requirement exists before updating. `gsd_save_summary` validates artifact type and computes file paths from IDs.

**T03** added `/gsd inspect` to `commands.ts` — a diagnostic subcommand that queries schema_version, counts rows across all tables, and fetches the 5 most recent decisions and requirements. The pure `formatInspectOutput` function is exported for testing. "No GSD database available" message when DB is unavailable.

## Verification

- `npm run test:unit -- --test-name-pattern "db-writer"` — 127 assertions passed ✓
- `npm run test:unit -- --test-name-pattern "gsd-tools"` — 35 assertions passed ✓
- `npm run test:unit -- --test-name-pattern "gsd-inspect"` — 32 assertions passed ✓
- `npm run test:unit` — 288 tests passed, 0 failed, no regressions ✓
- `npx tsc --noEmit` — clean compilation ✓
- Round-trip fidelity: generateDecisionsMd → parseDecisionsTable and generateRequirementsMd → parseRequirementsSections produce identical data ✓
- All 3 tools register, execute correctly, and return structured results ✓
- /gsd inspect autocomplete, handler, and unknown-command help all include "inspect" ✓

## Requirements Advanced

- R014 — Structured LLM tools now exist: gsd_save_decision, gsd_update_requirement, gsd_save_summary all write to DB and trigger markdown dual-write. Eliminates the markdown-then-parse roundtrip.
- R015 — /gsd inspect shows schema version, table counts, and recent entries when DB is available.
- R009 — Dual-write now works in both directions: S03 wired markdown→DB re-import, S06 adds DB→markdown generation via structured tools.

## Requirements Validated

- R014 — 35 test assertions prove all three tools register, execute with valid params, produce correct DB state, return structured results, handle DB unavailable, and regenerate markdown files.
- R015 — 32 test assertions prove inspect output formatting with full data, empty data, null schema version, and output structure. Handler wired with autocomplete and unknown-command help.

## New Requirements Surfaced

- None

## Requirements Invalidated or Re-scoped

- None

## Deviations

- T01: Used `_getAdapter()` directly for full-table queries instead of `getActiveDecisions()`/`getActiveRequirements()`, because DECISIONS.md contains ALL rows (including superseded) and REQUIREMENTS.md needs all non-superseded rows grouped by status. The active_* views filter too aggressively.
- T03: Used `_getAdapter()` directly instead of importing `context-store.js` as the task plan suggested. Simpler and avoids unnecessary abstraction for table count queries.

## Known Limitations

- Tools require DB to be available — no graceful degradation to markdown-only writing (by design: tools exist specifically for DB-first workflow)
- `/gsd inspect` shows counts and recent rows only — no query or filter capabilities (R031 DB export command deferred)
- `generateRequirementsMd` produces a complete file replacement — no incremental updates to individual sections

## Follow-ups

- S07: Integration verification — run full auto-mode cycle with structured tools active to confirm end-to-end behavior
- S07: Verify tools work correctly when invoked during real dispatch units (not just unit tests)

## Files Created/Modified

- `src/resources/extensions/gsd/db-writer.ts` — new module with 6 exports: generateDecisionsMd, generateRequirementsMd, nextDecisionId, saveDecisionToDb, updateRequirementInDb, saveArtifactToDb
- `src/resources/extensions/gsd/tests/db-writer.test.ts` — 127 assertions covering round-trip fidelity, next-ID computation, DB write helpers, and error cases
- `src/resources/extensions/gsd/index.ts` — added Type import and 3 tool registrations (~175 LOC)
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — 35 assertions covering all three tools
- `src/resources/extensions/gsd/commands.ts` — added inspect to autocomplete, handleInspect(), formatInspectOutput(), InspectData interface, updated unknown-command help
- `src/resources/extensions/gsd/tests/gsd-inspect.test.ts` — 32 assertions for inspect output formatting

## Forward Intelligence

### What the next slice should know
- All three tools are registered in index.ts after the dynamic file tool registrations (line ~193). They follow the google-search extension pattern exactly — TypeBox schemas, promptSnippet, promptGuidelines, execute with AgentToolResult return.
- The DB-first write pattern in db-writer.ts is: upsert → fetch all → generate markdown → saveFile. This means every write regenerates the entire DECISIONS.md or REQUIREMENTS.md file.
- `/gsd inspect` queries are direct `_getAdapter()` calls, not through context-store.ts. If the query API changes, inspect needs updating too.

### What's fragile
- Round-trip fidelity depends on exact markdown format matching between generators and parsers. If `parseDecisionsTable` or `parseRequirementsSections` in md-importer.ts change their expected format, the generators must update in lockstep.
- The full-file regeneration pattern means concurrent writes from different sources (tool + handleAgentEnd re-import) could conflict. In practice this shouldn't happen since they run sequentially in the same auto-mode loop.

### Authoritative diagnostics
- `/gsd inspect` output is the primary DB state diagnostic — use it to verify table counts and recent entries during integration testing
- `npm run test:unit -- --test-name-pattern "db-writer|gsd-tools|gsd-inspect"` covers all S06 code paths

### What assumptions changed
- Original plan suggested using context-store.ts for inspect queries — direct _getAdapter() calls turned out simpler and more appropriate for count queries and raw row fetching.
