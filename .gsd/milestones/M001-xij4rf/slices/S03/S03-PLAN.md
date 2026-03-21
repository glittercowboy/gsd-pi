# S03: Journal Query Tool

**Goal:** An LLM agent can call `gsd_journal_query` with filters and get back matching journal entries, including causal chain reconstruction.
**Demo:** After registration, calling `gsd_journal_query` with `{ unitId: "M001/S01/T01" }` returns the filtered journal entries for that unit. Calling with `{ rule: "some-rule-name" }` returns entries matched by that rule.

## Must-Haves

- `gsd_journal_query` tool registered with correct name matching `^[a-zA-Z0-9_-]{1,128}$`
- Tool accepts filters: `flowId`, `unitId`, `rule`, `eventType`, `after`, `before`, `limit`
- `rule` filter added to `JournalQueryFilters` interface and `queryJournal()` filter chain
- `limit` parameter caps result count (default 100) to protect LLM context windows
- Tool returns JSON-serialized `JournalEntry[]` or a clear "no entries found" message
- Tool has no DB dependency — reads JSONL files directly via `queryJournal()`
- All existing journal tests pass (no regressions)

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal.test.ts` — all existing tests pass + new `rule` filter test passes
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal-query-tool.test.ts` — tool registration test passes
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal.test.ts src/resources/extensions/gsd/tests/journal-query-tool.test.ts` — both test files pass together with zero failures

## Integration Closure

- Upstream surfaces consumed: `src/resources/extensions/gsd/journal.ts` (`queryJournal()`, `JournalQueryFilters`, `JournalEntry`), `src/resources/extensions/gsd/bootstrap/register-extension.ts` (wiring point)
- New wiring introduced in this slice: `registerJournalTools(pi)` call in `register-extension.ts`
- What remains before the milestone is truly usable end-to-end: S04 (tool naming convention) is independent and parallel

## Tasks

- [x] **T01: Add rule filter to queryJournal and test it** `est:15m`
  - Why: R011 requires a `rule` filter, but `JournalQueryFilters` doesn't have one yet. This closes the gap so the tool in T02 can expose all required filters.
  - Files: `src/resources/extensions/gsd/journal.ts`, `src/resources/extensions/gsd/tests/journal.test.ts`
  - Do: Add `rule?: string` to `JournalQueryFilters`. Add `if (filters.rule && e.rule !== filters.rule) return false;` to the filter chain in `queryJournal()`. Add a unit test for the rule filter in `journal.test.ts`.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal.test.ts` — all 17+ tests pass
  - Done when: `queryJournal(base, { rule: "my-rule" })` returns only entries with matching `rule` field, and all existing tests still pass

- [x] **T02: Create gsd_journal_query tool and wire into extension** `est:30m`
  - Why: This is the slice's core deliverable — the LLM-callable tool that satisfies R011. It wires `queryJournal()` into the GSD extension as a registered tool.
  - Files: `src/resources/extensions/gsd/bootstrap/journal-tools.ts`, `src/resources/extensions/gsd/bootstrap/register-extension.ts`, `src/resources/extensions/gsd/tests/journal-query-tool.test.ts`
  - Do: Create `journal-tools.ts` exporting `registerJournalTools(pi)` following the `db-tools.ts` pattern. Register one tool `gsd_journal_query` with TypeBox params (flowId, unitId, rule, eventType, after, before as Optional Strings; limit as Optional Number defaulting to 100). Execute calls `queryJournal(process.cwd(), filters)`, slices to limit, returns `JSON.stringify(entries, null, 2)` or "No matching journal entries found" for empty results. Import and call `registerJournalTools(pi)` from `register-extension.ts`. Write `journal-query-tool.test.ts` that creates a mock ExtensionAPI, calls registerJournalTools, and verifies tool name, parameters, and correct output.
  - Verify: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/journal-query-tool.test.ts` — all tests pass
  - Done when: The tool is registered, produces correct filtered output, handles empty results gracefully, and respects the limit parameter

## Files Likely Touched

- `src/resources/extensions/gsd/journal.ts`
- `src/resources/extensions/gsd/bootstrap/journal-tools.ts` (new)
- `src/resources/extensions/gsd/bootstrap/register-extension.ts`
- `src/resources/extensions/gsd/tests/journal.test.ts`
- `src/resources/extensions/gsd/tests/journal-query-tool.test.ts` (new)

## Observability / Diagnostics

- **Runtime signals:** `queryJournal()` returns an empty array on any error (missing directory, corrupt files). The absence of results — rather than thrown errors — is the failure signal. The `rule` filter is a pure equality check on `JournalEntry.rule`, so a mismatch silently yields no results (consistent with all other filters).
- **Inspection surfaces:** The `gsd_journal_query` tool (T02) will return JSON-serialized entries or a "No matching journal entries found" message, giving the LLM agent direct visibility into what the journal contains for a given filter combination.
- **Failure visibility:** If journal JSONL files are missing, empty, or corrupt, `queryJournal()` returns `[]` without throwing. The tool layer (T02) converts this to a user-visible "no entries found" message. Malformed lines are silently skipped per existing behavior.
- **Redaction constraints:** Journal entries may contain unitId paths and rule names but no secrets. No redaction is needed for the query path.
