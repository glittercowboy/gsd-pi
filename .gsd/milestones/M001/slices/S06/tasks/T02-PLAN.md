---
estimated_steps: 5
estimated_files: 2
---

# T02: Register structured LLM tools

**Slice:** S06 — Structured LLM Tools + /gsd inspect
**Milestone:** M001

## Description

Register three tools in the GSD extension via `pi.registerTool()`: `gsd_save_decision`, `gsd_update_requirement`, and `gsd_save_summary`. These let the LLM write structured data directly to the DB and trigger markdown dual-write, eliminating the fragile markdown-then-parse roundtrip (R014). Follows the google-search extension pattern for tool registration with TypeBox schemas.

## Steps

1. In `index.ts`, add `import { Type } from "@sinclair/typebox"` (already available as a dependency). Register `gsd_save_decision` tool with TypeBox schema: `scope` (String, required), `decision` (String, required), `choice` (String, required), `rationale` (String, required), `revisable` (Optional String), `when_context` (Optional String). Execute function: check `isDbAvailable()` → dynamic import `db-writer.js` → call `saveDecisionToDb()` → return `{content: [{type: "text", text: "Saved decision ${id}"}], details: {operation: "save_decision", id}}`.

2. Register `gsd_update_requirement` tool with schema: `id` (String, required — the RXXX identifier), `status` (Optional String), `validation` (Optional String), `notes` (Optional String), `description` (Optional String), `primary_owner` (Optional String), `supporting_slices` (Optional String). Execute: check `isDbAvailable()` → dynamic import `gsd-db.js` to get `getRequirementById` → verify requirement exists → dynamic import `db-writer.js` → call `updateRequirementInDb()` → return success result.

3. Register `gsd_save_summary` tool with schema: `milestone_id` (String, required), `slice_id` (Optional String), `task_id` (Optional String), `artifact_type` (String, required — one of SUMMARY, RESEARCH, CONTEXT, ASSESSMENT), `content` (String, required). Execute: check `isDbAvailable()` → compute relative path from IDs (e.g. `milestones/M001/slices/S01/S01-SUMMARY.md`) → dynamic import `db-writer.js` → call `saveArtifactToDb()` → return success result.

4. Add `promptSnippet` and `promptGuidelines` to each tool so they appear correctly in the system prompt. Guidelines should explain when to use each tool and the auto-ID behavior for decisions.

5. Write `gsd-tools.test.ts`: test each tool's execute function with an in-memory DB. Verify: (a) decision tool creates DB row + returns new ID, (b) requirement update tool modifies existing requirement, (c) summary tool creates artifact row, (d) all tools return `isError: true` when DB unavailable, (e) decision tool auto-assigns correct next ID.

## Must-Haves

- [ ] All 3 tools registered with TypeBox schemas
- [ ] Tools return `isError: true` with message when DB is unavailable
- [ ] Decision IDs auto-assigned (LLM never guesses IDs)
- [ ] Tool results follow `AgentToolResult` interface: `{content: [{type: "text", text}], details}`
- [ ] Dynamic imports with try/catch for all DB/writer module access (D014)

## Verification

- `npm run test:unit -- --test-name-pattern "gsd-tools"` — all assertions pass
- `npx tsc --noEmit` — clean compilation
- Tools produce correct DB state: decisions row inserted, requirement row updated, artifact row created

## Inputs

- `src/resources/extensions/gsd/db-writer.ts` — saveDecisionToDb, updateRequirementInDb, saveArtifactToDb (from T01)
- `src/resources/extensions/gsd/gsd-db.ts` — isDbAvailable, getRequirementById, openDatabase
- `src/resources/extensions/google-search/index.ts` — reference pattern for pi.registerTool() with TypeBox
- `packages/pi-coding-agent/src/core/extensions/types.ts` — ToolDefinition, AgentToolResult interfaces

## Expected Output

- `src/resources/extensions/gsd/index.ts` — modified with 3 new tool registrations (~150 LOC addition)
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — new test file with tool execution tests

## Observability Impact

- **Tool result `isError: true`**: All three tools return structured error results with `details.error` field when DB is unavailable or inputs are invalid. The LLM sees the error message directly.
- **stderr logging**: Each tool logs failures to stderr with `gsd-db:` prefix (e.g. `gsd-db: gsd_save_decision tool failed: ...`), consistent with the existing db-writer pattern.
- **Structured details**: Every tool result includes `details.operation` (e.g. `"save_decision"`, `"update_requirement"`, `"save_summary"`) for programmatic inspection, plus `details.id` or `details.path` on success.
- **Failure visibility**: Invalid artifact types, missing requirement IDs, and DB unavailability all produce `isError: true` results that surface in both the LLM conversation and UI rendering.
