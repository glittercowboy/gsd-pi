---
id: T02
parent: S06
milestone: M001
provides:
  - gsd_save_decision tool — records decisions to DB with auto-assigned IDs and regenerates DECISIONS.md
  - gsd_update_requirement tool — updates existing requirements in DB and regenerates REQUIREMENTS.md
  - gsd_save_summary tool — saves artifacts (summary/research/context/assessment) to DB and disk
key_files:
  - src/resources/extensions/gsd/index.ts
  - src/resources/extensions/gsd/tests/gsd-tools.test.ts
key_decisions:
  - Tools return isError with structured details.error field matching google-search pattern, not throwing exceptions
  - Tool result details include operation field for programmatic identification (save_decision, update_requirement, save_summary)
patterns_established:
  - Tool registration with TypeBox schemas, promptSnippet, and promptGuidelines following google-search extension pattern
  - DB availability check at tool entry with early isError return before any dynamic imports
observability_surfaces:
  - Tool results include isError: true with details.error for DB unavailable, not-found, and invalid input conditions
  - stderr logs with gsd-db: prefix on tool execution failures
  - Structured details on every result: details.operation, details.id/path on success, details.error on failure
duration: 15m
verification_result: passed
completed_at: 2026-03-15
blocker_discovered: false
---

# T02: Register structured LLM tools

**Registered three pi.registerTool() tools (gsd_save_decision, gsd_update_requirement, gsd_save_summary) with TypeBox schemas, auto-ID assignment, and DB-first write path**

## What Happened

Added three LLM-callable tools to the GSD extension in `index.ts`, inserted after the dynamic file tool registrations. Each tool follows the google-search extension pattern: TypeBox parameter schema, `promptSnippet` for system prompt tool list, `promptGuidelines` for usage instructions, and an `execute` function that checks DB availability → performs the operation → returns structured `AgentToolResult`.

Key behaviors:
- `gsd_save_decision`: Takes scope/decision/choice/rationale (required) + revisable/when_context (optional). Calls `saveDecisionToDb()` which auto-assigns the next D-number ID. LLM never guesses IDs.
- `gsd_update_requirement`: Takes id (required) + optional update fields. Verifies the requirement exists before updating, returns `isError` with "not_found" if missing.
- `gsd_save_summary`: Takes milestone_id + artifact_type (required) + optional slice_id/task_id/content. Computes the relative file path from IDs automatically. Validates artifact_type against allowed values.

All tools use dynamic `import()` inside `try/catch` for D014 compliance. Each has two error paths: DB unavailable (checked before any work) and operation failure (caught from the writer functions).

## Verification

- `npm run test:unit -- --test-name-pattern "gsd-tools"` — 35 assertions, all passed
- `npm run test:unit` — 290/290 tests pass, 0 regressions
- `npx tsc --noEmit` — clean compilation, no errors
- Tests verify: decision creation with auto-ID (D001→D002→D003), requirement update with field preservation, artifact creation at milestone/slice/task levels, DB unavailable fallback, DECISIONS.md and REQUIREMENTS.md file regeneration on disk

### Slice-level verification status (intermediate task):
- ✅ `npm run test:unit -- --test-name-pattern "db-writer"` — passes
- ✅ `npm run test:unit -- --test-name-pattern "gsd-tools"` — passes
- ⏳ `npm run test:unit -- --test-name-pattern "gsd-inspect"` — T03 (not yet created)
- ✅ `npm run test:unit` — full suite passes
- ✅ `npx tsc --noEmit` — clean

## Diagnostics

- Tool errors surface as `isError: true` in the LLM conversation with descriptive messages
- stderr logs with `gsd-db: gsd_save_decision tool failed:` / `gsd_update_requirement tool failed:` / `gsd_save_summary tool failed:` prefix
- Every tool result includes `details.operation` for programmatic identification
- Invalid artifact types produce immediate validation error (no DB write attempted)

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/resources/extensions/gsd/index.ts` — added `Type` import and 3 tool registrations (~175 LOC)
- `src/resources/extensions/gsd/tests/gsd-tools.test.ts` — new test file with 35 assertions covering all three tools
- `.gsd/milestones/M001/slices/S06/tasks/T02-PLAN.md` — added Observability Impact section per pre-flight requirement
