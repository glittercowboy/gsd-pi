---
estimated_steps: 5
estimated_files: 3
skills_used:
  - test
---

# T02: Create gsd_journal_query tool and wire into extension

**Slice:** S03 — Journal Query Tool
**Milestone:** M001-xij4rf

## Description

Create the `gsd_journal_query` LLM-callable tool that exposes `queryJournal()` as a registered GSD tool. This is the core deliverable of S03 and satisfies R011. Follow the exact `db-tools.ts` pattern for registration shape.

## Steps

1. Create `src/resources/extensions/gsd/bootstrap/journal-tools.ts`:
   - Import `Type` from `@sinclair/typebox` and `ExtensionAPI` from `@gsd/pi-coding-agent`
   - Import `queryJournal` from `../journal.js`
   - Export function `registerJournalTools(pi: ExtensionAPI): void`
   - Register one tool with `pi.registerTool({...})`:
     - `name`: `"gsd_journal_query"`
     - `label`: `"Query Journal"`
     - `description`: A sentence explaining the tool queries the structured event journal
     - `promptSnippet`: Short one-liner for prompt injection
     - `promptGuidelines`: Array of 2-3 usage hints (filter by flowId to trace an iteration, filter by unitId for causal chain, use limit to control context size)
     - `parameters`: TypeBox Object with:
       - `flowId`: `Type.Optional(Type.String({ description: "Filter by flow ID (UUID grouping one iteration)" }))`
       - `unitId`: `Type.Optional(Type.String({ description: "Filter by unit ID (e.g. M001/S01/T01) from event data" }))`
       - `rule`: `Type.Optional(Type.String({ description: "Filter by rule name from the unified registry" }))`
       - `eventType`: `Type.Optional(Type.String({ description: "Filter by event type (e.g. dispatch-match, unit-start)" }))`
       - `after`: `Type.Optional(Type.String({ description: "ISO-8601 lower bound (inclusive)" }))`
       - `before`: `Type.Optional(Type.String({ description: "ISO-8601 upper bound (inclusive)" }))`
       - `limit`: `Type.Optional(Type.Number({ description: "Maximum entries to return (default: 100)", default: 100 }))`
     - `execute` function:
       - Build filters object from params (only include non-undefined fields)
       - Call `queryJournal(process.cwd(), filters)`
       - Apply limit: `entries.slice(0, params.limit ?? 100)`
       - If empty: return `{ content: [{ type: "text", text: "No matching journal entries found." }] }`
       - If non-empty: return `{ content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] }`
       - Wrap in try/catch, return error text on failure (same pattern as db-tools.ts)

2. Open `src/resources/extensions/gsd/bootstrap/register-extension.ts`:
   - Add import: `import { registerJournalTools } from "./journal-tools.js";`
   - Add call `registerJournalTools(pi);` after the `registerDbTools(pi);` line in `registerGsdExtension()`

3. Create `src/resources/extensions/gsd/tests/journal-query-tool.test.ts`:
   - Import `test` from `node:test`, `assert` from `node:assert/strict`
   - Import `mkdirSync`, `rmSync`, `writeFileSync` from `node:fs`, `join` from `node:path`, `tmpdir` from `node:os`, `randomUUID` from `node:crypto`
   - Import `registerJournalTools` from `../bootstrap/journal-tools.ts`
   - Import `emitJournalEvent`, `type JournalEntry` from `../journal.ts`
   - Create a mock `ExtensionAPI` that captures `registerTool` calls:
     ```
     function makeMockPi() {
       const tools: any[] = [];
       return {
         registerTool: (tool: any) => tools.push(tool),
         tools,
       } as any;
     }
     ```
   - Test: "registerJournalTools registers gsd_journal_query tool" — call registerJournalTools(pi), assert tools.length === 1, assert tools[0].name === "gsd_journal_query"
   - Test: "gsd_journal_query returns filtered entries" — emit entries to a temp dir, mock `process.cwd()` to return that temp dir (or use a spy), call the tool's execute function, parse the JSON result, assert correct filtering. Note: since `execute` uses `process.cwd()`, temporarily override it with `process.chdir()` or test the queryJournal integration directly.
   - Test: "gsd_journal_query returns 'no entries' message for empty results" — call execute with a filter that matches nothing, assert the text contains "No matching journal entries found"
   - Test: "gsd_journal_query respects limit parameter" — emit 5 entries, call with limit=2, assert only 2 returned
   - Test: "gsd_journal_query handles errors gracefully" — call with a basePath that triggers an error (the tool should catch and return error text)

4. Run the full test suite for both files to verify everything passes.

5. Run the full existing test suite (`node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal.test.ts`) to confirm no regressions.

## Must-Haves

- [ ] `journal-tools.ts` exists and exports `registerJournalTools`
- [ ] Tool name is exactly `gsd_journal_query`
- [ ] Tool parameters include all 7 filter fields (flowId, unitId, rule, eventType, after, before, limit)
- [ ] `limit` defaults to 100 and caps result count
- [ ] Empty results return "No matching journal entries found." (not an empty JSON array)
- [ ] Tool is wired into `register-extension.ts` via `registerJournalTools(pi)`
- [ ] `journal-query-tool.test.ts` passes with all tests green
- [ ] No regressions in existing test suite

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal-query-tool.test.ts` — all tests pass
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal.test.ts` — all existing + new tests pass
- `grep -q "registerJournalTools" src/resources/extensions/gsd/bootstrap/register-extension.ts` — wiring confirmed

## Inputs

- `src/resources/extensions/gsd/journal.ts` — `queryJournal()`, `JournalQueryFilters`, `JournalEntry` (modified by T01 with `rule` filter)
- `src/resources/extensions/gsd/bootstrap/db-tools.ts` — pattern to follow for tool registration shape
- `src/resources/extensions/gsd/bootstrap/register-extension.ts` — wiring point to modify
- `src/resources/extensions/gsd/tests/journal.test.ts` — test patterns to follow (modified by T01)

## Expected Output

- `src/resources/extensions/gsd/bootstrap/journal-tools.ts` — new file with `registerJournalTools` export
- `src/resources/extensions/gsd/bootstrap/register-extension.ts` — modified with journal tools import and call
- `src/resources/extensions/gsd/tests/journal-query-tool.test.ts` — new test file for tool registration

## Observability Impact

- **New inspection surface:** The `gsd_journal_query` tool returns JSON-serialized `JournalEntry[]` or `"No matching journal entries found."`, giving the LLM agent direct visibility into journal contents for any filter combination.
- **Error path:** Tool catches all exceptions and returns `"Error querying journal: <msg>"` text. Errors are also written to stderr via `process.stderr.write()`.
- **Silent empty results:** When `queryJournal()` returns `[]` (missing directory, corrupt files, or no matches), the tool converts this to the user-visible "no entries found" message rather than an empty JSON array.
- **Limit cap:** The `limit` parameter (default 100) prevents the tool from flooding the LLM context window with unbounded journal data.
