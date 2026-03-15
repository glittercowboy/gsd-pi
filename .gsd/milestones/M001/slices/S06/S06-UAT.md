# S06: Structured LLM Tools + /gsd inspect — UAT

**Milestone:** M001
**Written:** 2026-03-15

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: All components (markdown generators, tool execute functions, inspect formatter) are pure functions testable with in-memory DB. No live runtime, server, or UI required. 194 unit test assertions cover all code paths.

## Preconditions

- Repository checked out with S06 changes applied
- `npm install` completed (better-sqlite3 / node:sqlite available)
- `npx tsc --noEmit` passes
- `npm run test:unit` passes with 288+ tests, 0 failures

## Smoke Test

Run `npm run test:unit -- --test-name-pattern "db-writer|gsd-tools|gsd-inspect"` — all 194 assertions pass across the three test files covering round-trip fidelity, tool execution, and inspect output formatting.

## Test Cases

### 1. Decision round-trip fidelity

1. Create 3 Decision objects with varied fields (including pipe characters in values, empty revisable fields, superseded_by references)
2. Pass to `generateDecisionsMd(decisions)`
3. Parse the output with `parseDecisionsTable(markdown)`
4. **Expected:** All 7 fields per decision match exactly: id, when_context, scope, decision, choice, rationale, revisable. Pipe characters in cells escaped with `\|`.

### 2. Requirements round-trip fidelity

1. Create requirements spanning all 4 status groups: active, validated, deferred, out-of-scope
2. Pass to `generateRequirementsMd(requirements)`
3. Parse the output with `parseRequirementsSections(markdown)`
4. **Expected:** All fields match per requirement: id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes. Empty sections omitted. Traceability table and Coverage Summary present.

### 3. Auto-assigned decision IDs

1. Open in-memory DB, initialize schema
2. Call `nextDecisionId()` on empty DB
3. Insert a decision with id D005
4. Call `nextDecisionId()` again
5. **Expected:** First call returns "D001". Second call returns "D006" (max existing + 1, zero-padded to 3 digits).

### 4. gsd_save_decision tool execution

1. Open in-memory DB, initialize schema, set basePath
2. Call `gsd_save_decision` execute with scope="arch", decision="Test decision", choice="Option A", rationale="Because"
3. **Expected:** Returns `isError: false`, `details.operation: "save_decision"`, `details.id: "D001"`. DB contains row with matching fields. DECISIONS.md file written to disk with the decision row.

### 5. gsd_save_decision sequential ID assignment

1. Call `gsd_save_decision` three times with different inputs
2. **Expected:** Returns D001, D002, D003 respectively. Each subsequent call increments the ID.

### 6. gsd_update_requirement tool execution

1. Insert requirement R001 into DB with status "active"
2. Call `gsd_update_requirement` execute with id="R001", status="validated", validation="Proven by test"
3. **Expected:** Returns `isError: false`, `details.operation: "update_requirement"`. DB row updated with new status and validation. Untouched fields preserved. REQUIREMENTS.md regenerated.

### 7. gsd_update_requirement with non-existent ID

1. Call `gsd_update_requirement` execute with id="R999"
2. **Expected:** Returns `isError: true`, `details.error` contains "not found" or similar message. No DB changes.

### 8. gsd_save_summary tool execution

1. Call `gsd_save_summary` with milestone_id="M001", slice_id="S01", artifact_type="SUMMARY", content="Test summary"
2. **Expected:** Returns `isError: false`, `details.operation: "save_summary"`, `details.path` contains the computed relative path. DB artifacts table has a row. File written to disk at the path.

### 9. gsd_save_summary invalid artifact type

1. Call `gsd_save_summary` with artifact_type="INVALID"
2. **Expected:** Returns `isError: true` with validation error about invalid artifact type. No DB write or file creation.

### 10. Tools with DB unavailable

1. Ensure `isDbAvailable()` returns false (no DB opened)
2. Call any of the 3 tools
3. **Expected:** Returns `isError: true`, text indicates "GSD database is not available". No crash, no unhandled exception.

### 11. /gsd inspect output formatting

1. Create `InspectData` with: schemaVersion=2, decisionCount=5, requirementCount=10, artifactCount=20, recent decisions and requirements
2. Call `formatInspectOutput(data)`
3. **Expected:** Output includes "Schema version: 2", "Decisions: 5", "Requirements: 10", "Artifacts: 20", recent entry lines with IDs and summaries.

### 12. /gsd inspect with empty data

1. Create `InspectData` with all zero counts and empty recent arrays
2. Call `formatInspectOutput(data)`
3. **Expected:** Output shows "Schema version:", zero counts, "None" for recent entries sections.

### 13. /gsd inspect autocomplete and help

1. Check the autocomplete array in commands.ts
2. Check the unknown-command notification text
3. **Expected:** Both include "inspect" in the list of valid subcommands.

## Edge Cases

### Pipe characters in decision fields

1. Create a decision with `|` in the rationale field
2. Generate DECISIONS.md
3. **Expected:** Pipe characters escaped as `\|` in the table output. Parses back correctly.

### Requirements with missing optional fields

1. Create requirements with empty/undefined supporting_slices, validation, notes
2. Generate REQUIREMENTS.md
3. **Expected:** Missing fields omitted from output (no "- Supporting slices:" line with empty value). Parses back with undefined/empty fields matching originals.

### nextDecisionId on DB failure

1. Call `nextDecisionId()` when dynamic import of gsd-db.js fails
2. **Expected:** Returns "D001" as safe fallback. No crash.

### saveArtifactToDb path computation

1. Call with milestone_id only → path should be `milestones/M001/...`
2. Call with milestone_id + slice_id → path should be `milestones/M001/slices/S01/...`
3. Call with milestone_id + slice_id + task_id → path should include task reference
4. **Expected:** Correct relative paths computed for all hierarchy levels.

## Failure Signals

- Any of the 3 test pattern runs return failures
- `npx tsc --noEmit` reports type errors in db-writer.ts, index.ts, or commands.ts
- Full test suite drops below 288 tests (regression in other modules)
- Tool execute returns unhandled exception instead of structured `isError: true`
- Generated DECISIONS.md or REQUIREMENTS.md fails to parse through existing parsers
- `/gsd inspect` not in autocomplete array or unknown-command help text

## Requirements Proved By This UAT

- R014 — Structured LLM tools: all three tools register, execute, write to DB, trigger dual-write, and return structured results
- R015 — /gsd inspect: displays schema version, table counts, recent entries; handles DB unavailable gracefully
- R009 — Dual-write in DB→markdown direction: tools write DB first then regenerate markdown files

## Not Proven By This UAT

- R019 — No regression in auto-mode output quality (requires full auto-mode cycle in S07)
- Real LLM invocation of tools during actual dispatch units (S07 integration test)
- Tool behavior under concurrent access or race conditions (not applicable for single-process SQLite)

## Notes for Tester

- All test cases are already covered by the 194 unit test assertions — this UAT documents what those tests prove for traceability
- The tools are registered but won't appear in LLM conversations until the extension is loaded in a real pi session — unit tests verify the execute functions directly
- `/gsd inspect` handler displays via `ctx.ui.notify()` which requires a real pi session — the pure `formatInspectOutput()` function is what's tested
