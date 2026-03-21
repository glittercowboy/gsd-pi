# S02: Event Journal

**Goal:** After an auto-mode run, `.gsd/journal/YYYY-MM-DD.jsonl` contains structured events with flowIds, rule names from the unified registry, and causedBy chains for every dispatch and hook firing.
**Demo:** Run `node --test src/resources/extensions/gsd/tests/journal.test.ts` — all tests pass. A mocked loop iteration produces a sequence of journal events with correct flowId threading, rule name provenance, and causedBy references.

## Must-Haves

- `journal.ts` module with `emitJournalEvent()` and `queryJournal()` functions
- `JournalEntry` interface with `ts`, `flowId`, `seq`, `eventType`, `rule`, `causedBy`, `data` fields
- Journal writes use `appendFileSync` to `.gsd/journal/YYYY-MM-DD.jsonl` with silent failure on errors
- `DispatchAction` type gains optional `matchedRule?: string` field on the `dispatch` and `stop` variants
- `RuleRegistry.evaluateDispatch()` attaches the matched rule's `name` to the returned action
- `IterationContext` gains a `flowId: string` field, generated once per iteration via `randomUUID()`
- `LoopDeps` gains `emitJournalEvent` — loop/phases call through deps, never import journal.ts directly
- Emission points: iteration-start, dispatch-match/dispatch-stop, pre-dispatch-hook, unit-start, unit-end, post-unit-hook, terminal, sidecar-dequeue
- `queryJournal()` supports filtering by flowId, eventType, unitId, time range
- All existing dispatch and hook tests pass with zero regression

## Proof Level

- This slice proves: contract + integration
- Real runtime required: no (mocked loop iteration is sufficient)
- Human/UAT required: no

## Verification

- `node --test src/resources/extensions/gsd/tests/journal.test.ts` — all journal unit tests pass (emit, query, daily rotation, silent failure, filtering)
- `node --test src/resources/extensions/gsd/tests/journal-integration.test.ts` — integration test proves mocked loop iteration produces correct journal event sequence
- `node --test src/resources/extensions/gsd/tests/rule-registry.test.ts` — existing tests pass, new test confirms `matchedRule` field
- `node --test src/resources/extensions/gsd/tests/triage-dispatch.test.ts` — no regression
- `node --test src/resources/extensions/gsd/tests/dispatch-guard.test.ts` — no regression

## Observability / Diagnostics

- Runtime signals: Journal events written to `.gsd/journal/YYYY-MM-DD.jsonl` — each line is a structured `JournalEntry` with flowId, eventType, rule name, causedBy
- Inspection surfaces: `queryJournal(basePath, { flowId })` returns all events for an iteration; raw JSONL files are human-readable via `cat` or `jq`
- Failure visibility: Journal write errors are silently caught (never break auto-mode); absence of expected events is detectable by querying for a flowId and checking event count
- Redaction constraints: none — journal contains orchestration metadata only, no user secrets

## Integration Closure

- Upstream surfaces consumed: `rule-registry.ts` (`RuleRegistry`, `evaluateDispatch()`), `rule-types.ts` (`UnifiedRule`), `auto-dispatch.ts` (`DispatchAction`), `auto/types.ts` (`IterationContext`), `auto/loop-deps.ts` (`LoopDeps`), `paths.ts` (`gsdRoot()`)
- New wiring introduced in this slice: `emitJournalEvent` added to `LoopDeps` and wired in `auto.ts` `buildLoopDeps()`; emission calls inserted into `loop.ts` and `phases.ts`
- What remains before the milestone is truly usable end-to-end: S03 (journal query tool for LLM agents), S04 (tool naming convention)

## Tasks

- [x] **T01: Build journal core module and unit tests** `est:45m`
  - Why: Standalone foundation — `journal.ts` has zero dependencies on `auto/` and unblocks all downstream wiring. Covers R007 (structured events), R008 (flowId grouping), R009 (causedBy chains), R012 (daily rotation).
  - Files: `src/resources/extensions/gsd/journal.ts`, `src/resources/extensions/gsd/tests/journal.test.ts`
  - Do: Create `JournalEntry` interface, `emitJournalEvent(basePath, entry)` using `appendFileSync` to `.gsd/journal/YYYY-MM-DD.jsonl` with `mkdirSync({recursive:true})` and silent catch. Create `queryJournal(basePath, filters)` reading JSONL files with filtering by flowId, eventType, unitId (from `data.unitId`), time range. Write comprehensive tests covering: JSONL write, directory auto-creation, daily rotation, silent failure on bad path, query by flowId, query by eventType, query by time range, empty results.
  - Verify: `node --test src/resources/extensions/gsd/tests/journal.test.ts`
  - Done when: All journal.test.ts tests pass, `emitJournalEvent` and `queryJournal` are exported and tested.

- [x] **T02: Add matchedRule to DispatchAction and flowId to IterationContext, wire LoopDeps** `est:40m`
  - Why: Type-level plumbing that enables journal emission with rule provenance (R010) and flow grouping (R008). The `matchedRule` field connects journal events to the rule registry; `flowId` groups events per iteration.
  - Files: `src/resources/extensions/gsd/auto-dispatch.ts`, `src/resources/extensions/gsd/rule-registry.ts`, `src/resources/extensions/gsd/auto/types.ts`, `src/resources/extensions/gsd/auto/loop-deps.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/tests/rule-registry.test.ts`
  - Do: (1) Add `matchedRule?: string` to `DispatchAction` `dispatch` variant and `stop` variant. (2) In `RuleRegistry.evaluateDispatch()`, set `result.matchedRule = rule.name` when a rule matches; set `matchedRule: "<no-match>"` on the fallback stop action. (3) Add `flowId: string` to `IterationContext`. (4) Add `emitJournalEvent: (entry: JournalEntry) => void` to `LoopDeps` (takes just entry; basePath comes from the wiring closure in auto.ts). (5) In `auto.ts` `buildLoopDeps()`, import `emitJournalEvent` from `journal.ts` and wire it as a closure over `s.basePath`. (6) Add a test to `rule-registry.test.ts` confirming `matchedRule` is present on dispatch results. (7) Run existing dispatch tests to confirm zero regression. IMPORTANT: Check `token-profile.test.ts` structural assertion on `auto-dispatch.ts` before modifying — the test reads the file as a string.
  - Verify: `node --test src/resources/extensions/gsd/tests/rule-registry.test.ts && node --test src/resources/extensions/gsd/tests/triage-dispatch.test.ts && node --test src/resources/extensions/gsd/tests/dispatch-guard.test.ts`
  - Done when: `evaluateDispatch()` returns `matchedRule` on dispatch results, `flowId` exists on `IterationContext`, `emitJournalEvent` is on `LoopDeps` and wired in `buildLoopDeps()`, all existing tests pass.

- [x] **T03: Insert journal emission points in loop and phases, write integration test** `est:50m`
  - Why: This is the slice's integration closure — wires `emitJournalEvent` calls into the actual auto-loop pipeline, proving the slice goal: an auto-mode iteration produces a traceable journal. Covers R007 (all event types emitted), R009 (causedBy chains), R010 (rule name in events).
  - Files: `src/resources/extensions/gsd/auto/loop.ts`, `src/resources/extensions/gsd/auto/phases.ts`, `src/resources/extensions/gsd/tests/journal-integration.test.ts`
  - Do: (1) In `loop.ts`: generate `flowId = randomUUID()` at loop-top, add to `IterationContext`, create a `seq` counter (closure, reset each iteration). Emit `iteration-start` at loop-top and `iteration-end` at loop-bottom (after try/catch success path). For sidecar path, emit `sidecar-dequeue`. (2) In `phases.ts` `runDispatch()`: after `resolveDispatch()` returns, emit `dispatch-match` (action=dispatch) or `dispatch-stop` (action=stop) with `matchedRule` from the result. After pre-dispatch hooks fire, emit `pre-dispatch-hook` with `firedHooks` array. (3) In `phases.ts` `runUnitPhase()`: emit `unit-start` at the point where `s.currentUnit` is set, emit `unit-end` after closeout. (4) In `phases.ts` `runFinalize()`: terminal conditions (milestone-complete, blocked) emit `terminal` events. (5) In `phases.ts` `runPreDispatch()`: emit `milestone-transition` when mid changes. (6) Write `journal-integration.test.ts` that builds a mock `LoopDeps` with a capturing `emitJournalEvent`, runs through the phase functions with mock data, and asserts: correct event sequence, all events share the same flowId, `dispatch-match` has `matchedRule`, `unit-end` has status, causedBy references are valid. (7) The `seq` counter should be threaded through `IterationContext` or as a closure accessible to both loop.ts and phases.ts — simplest approach is to put a mutable `nextSeq` function on `IterationContext` or pass it through `IterationData`. CONSTRAINT: phases.ts must call `deps.emitJournalEvent(entry)`, never import journal.ts directly.
  - Verify: `node --test src/resources/extensions/gsd/tests/journal-integration.test.ts && node --test src/resources/extensions/gsd/tests/journal.test.ts`
  - Done when: Integration test passes proving a mocked iteration produces the full event sequence (iteration-start → dispatch-match → unit-start → unit-end → iteration-end) with correct flowId threading and causedBy chains. All journal unit tests still pass.

## Files Likely Touched

- `src/resources/extensions/gsd/journal.ts` (NEW)
- `src/resources/extensions/gsd/auto-dispatch.ts`
- `src/resources/extensions/gsd/rule-registry.ts`
- `src/resources/extensions/gsd/auto/types.ts`
- `src/resources/extensions/gsd/auto/loop-deps.ts`
- `src/resources/extensions/gsd/auto/loop.ts`
- `src/resources/extensions/gsd/auto/phases.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/tests/journal.test.ts` (NEW)
- `src/resources/extensions/gsd/tests/journal-integration.test.ts` (NEW)
- `src/resources/extensions/gsd/tests/rule-registry.test.ts`
