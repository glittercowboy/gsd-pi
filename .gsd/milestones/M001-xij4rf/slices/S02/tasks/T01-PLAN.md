---
estimated_steps: 4
estimated_files: 2
skills_used:
  - test
---

# T01: Build journal core module and unit tests

**Slice:** S02 — Event Journal
**Milestone:** M001-xij4rf

## Description

Create the standalone `journal.ts` module with `JournalEntry` interface, `emitJournalEvent()`, and `queryJournal()` functions. This module has zero imports from `auto/` — it depends only on `node:fs`, `node:path`, and `paths.ts` (`gsdRoot`). Build comprehensive unit tests proving JSONL write, directory creation, daily rotation, silent failure, and query filtering.

## Steps

1. Create `src/resources/extensions/gsd/journal.ts` with:
   - `JournalEntry` interface: `{ ts: string; flowId: string; seq: number; eventType: string; rule?: string; causedBy?: { flowId: string; seq: number }; data?: Record<string, unknown> }`. Export the eventType as a union type for type safety: `"iteration-start" | "dispatch-match" | "dispatch-stop" | "pre-dispatch-hook" | "unit-start" | "unit-end" | "post-unit-hook" | "terminal" | "guard-block" | "milestone-transition" | "stuck-detected" | "sidecar-dequeue"`.
   - `emitJournalEvent(basePath: string, entry: JournalEntry): void` — derives file path from `gsdRoot(basePath)` + `journal/` + `entry.ts.slice(0, 10)` + `.jsonl`. Uses `mkdirSync({ recursive: true })` then `appendFileSync(path, JSON.stringify(entry) + "\n")`. Entire body wrapped in try/catch with silent failure (empty catch block). Journal must never throw.
   - `queryJournal(basePath: string, filters?: { flowId?: string; eventType?: string; unitId?: string; after?: string; before?: string }): JournalEntry[]` — reads all `.jsonl` files from the journal directory, parses each line, filters by provided criteria. `unitId` matches against `entry.data?.unitId`. Time range filters compare `entry.ts` against `after`/`before` ISO strings. Returns empty array on any error (missing dir, bad files).

2. Create `src/resources/extensions/gsd/tests/journal.test.ts` with tests:
   - `emitJournalEvent` creates `.gsd/journal/YYYY-MM-DD.jsonl` and appends valid JSON lines
   - Each line parses as `JournalEntry` with required fields (`ts`, `flowId`, `seq`, `eventType`)
   - Multiple events produce multiple lines in the same file
   - Write to nonexistent parent dir auto-creates it via `mkdirSync`
   - Write error (e.g., read-only dir or path that can't be created) is silently caught — no throw
   - `queryJournal` with `flowId` filter returns only matching entries
   - `queryJournal` with `eventType` filter returns only matching entries
   - `queryJournal` with time range (`after`/`before`) filters works
   - `queryJournal` with `unitId` filter matches against `entry.data.unitId`
   - Daily rotation: events with different date strings go to different files
   - `queryJournal` on nonexistent directory returns empty array

3. Use `tmpdir()` + `randomUUID()` for test isolation (consistent with codebase patterns in `auto-recovery.test.ts`).

4. Ensure all imports use `.ts` extension in test files (project convention per existing tests).

## Must-Haves

- [ ] `JournalEntry` interface exported with all fields from the research spec
- [ ] `emitJournalEvent` writes valid JSONL to `.gsd/journal/YYYY-MM-DD.jsonl`
- [ ] `emitJournalEvent` never throws — all errors silently caught
- [ ] `queryJournal` filters by flowId, eventType, unitId, time range
- [ ] `queryJournal` returns empty array on missing directory or parse errors
- [ ] All unit tests pass

## Verification

- `node --test src/resources/extensions/gsd/tests/journal.test.ts` — all tests pass
- `grep -q "export.*JournalEntry" src/resources/extensions/gsd/journal.ts` — interface exported
- `grep -q "export.*emitJournalEvent" src/resources/extensions/gsd/journal.ts` — function exported
- `grep -q "export.*queryJournal" src/resources/extensions/gsd/journal.ts` — function exported

## Inputs

- `src/resources/extensions/gsd/paths.ts` — `gsdRoot()` function for resolving `.gsd/` directory
- `src/resources/extensions/gsd/debug-logger.ts` — reference pattern for `appendFileSync` + `mkdirSync` + silent catch
- `src/resources/extensions/gsd/jsonl-utils.ts` — reference for JSONL parsing pattern (but journal.ts should have its own simpler parser since `jsonl-utils.ts` is tuned for large activity logs)

## Observability Impact

- **New signal:** `emitJournalEvent()` writes structured JSONL lines to `.gsd/journal/YYYY-MM-DD.jsonl` — each line is a self-contained `JournalEntry` with `flowId`, `seq`, `eventType`, `rule`, `causedBy`, and `data` fields.
- **Inspection:** `queryJournal(basePath, { flowId })` returns all events for a given iteration; raw JSONL files are human-readable via `cat` or `jq '.flowId'`.
- **Failure visibility:** Write errors are silently caught (never break auto-mode). Absence of expected events is detectable by querying for a flowId and finding zero results. `queryJournal` on a missing directory returns `[]` rather than throwing.
- **No regressions:** This module has zero dependencies on `auto/` — it cannot affect existing auto-mode behavior until wired in T02/T03.

## Expected Output

- `src/resources/extensions/gsd/journal.ts` — new module with `JournalEntry`, `emitJournalEvent`, `queryJournal`
- `src/resources/extensions/gsd/tests/journal.test.ts` — comprehensive unit tests
