---
estimated_steps: 5
estimated_files: 3
skills_used:
  - test
---

# T03: Insert journal emission points in loop and phases, write integration test

**Slice:** S02 — Event Journal
**Milestone:** M001-xij4rf

## Description

Wire `deps.emitJournalEvent()` calls into the auto-loop pipeline at every key orchestration boundary. Then write an integration test that proves a mocked loop iteration produces the correct journal event sequence with flowId threading, rule name provenance, and causedBy references. This is the slice's integration closure — without this task, journal.ts exists but nothing emits to it.

## Steps

1. **Modify `src/resources/extensions/gsd/auto/loop.ts`**:
   - Import `randomUUID` from `node:crypto`.
   - At loop-top (after `iteration++`), generate `const flowId = randomUUID()`. Create a seq counter: `let seqCounter = 0; const nextSeq = () => ++seqCounter;`.
   - When constructing `IterationContext`, pass `flowId` and `nextSeq`.
   - After constructing `ic`, emit `iteration-start`: `deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-start", data: { iteration } })`.
   - For the sidecar path (when `sidecarItem` is set), emit `sidecar-dequeue`: `deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "sidecar-dequeue", data: { kind: sidecarItem.kind, unitType: sidecarItem.unitType, unitId: sidecarItem.unitId } })`.
   - After successful iteration completion (after `consecutiveErrors = 0`), emit `iteration-end`: `deps.emitJournalEvent({ ts: new Date().toISOString(), flowId, seq: nextSeq(), eventType: "iteration-end" as any, data: { iteration } })`. Note: add `"iteration-end"` to the JournalEventType union in journal.ts if not already present.

2. **Modify `src/resources/extensions/gsd/auto/phases.ts`**:
   - In `runDispatch()`, after `deps.resolveDispatch()` returns `dispatchResult`:
     - If `dispatchResult.action === "stop"`: emit `{ ts, flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-stop", rule: dispatchResult.matchedRule, data: { reason: dispatchResult.reason } }`.
     - If `dispatchResult.action === "dispatch"`: emit `{ ts, flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-match", rule: dispatchResult.matchedRule, data: { unitType: dispatchResult.unitType, unitId: dispatchResult.unitId } }`.
   - After pre-dispatch hooks fire (when `preDispatchResult.firedHooks.length > 0`): emit `{ ts, flowId: ic.flowId, seq: ic.nextSeq(), eventType: "pre-dispatch-hook", data: { firedHooks: preDispatchResult.firedHooks, action: preDispatchResult.action } }`.
   - In `runUnitPhase()`, at the point where `s.currentUnit` is set (after `s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() }`): emit `{ ts, flowId: ic.flowId, seq: ic.nextSeq(), eventType: "unit-start", data: { unitType, unitId } }`.
   - In `runUnitPhase()`, after closeout and artifact verification (just before the `return` at the end): emit `{ ts, flowId: ic.flowId, seq: ic.nextSeq(), eventType: "unit-end", data: { unitType, unitId, status: unitResult.status, artifactVerified } }`. The `causedBy` for `unit-end` should reference the `unit-start` event — to do this cleanly, capture the `unit-start` seq number: `const unitStartSeq = ic.nextSeq(); deps.emitJournalEvent({...eventType:"unit-start", seq: unitStartSeq...}); ... deps.emitJournalEvent({...eventType:"unit-end", seq: ic.nextSeq(), causedBy: { flowId: ic.flowId, seq: unitStartSeq }...})`.
   - In `runPreDispatch()`, when milestone transition is detected (`mid !== s.currentMilestoneId`): emit `{ ts, flowId: ic.flowId, seq: ic.nextSeq(), eventType: "milestone-transition", data: { from: s.currentMilestoneId, to: mid } }`.
   - In `runPreDispatch()`, for terminal conditions (complete, blocked): emit `{ ts, flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "milestone-complete" | "blocked" | ... } }`.
   - CONSTRAINT: All emit calls go through `deps.emitJournalEvent(entry)`. Never import `journal.ts` in phases.ts.

3. **Update `src/resources/extensions/gsd/journal.ts`**: Add `"iteration-end"` to the `JournalEventType` union if the initial T01 implementation didn't include it.

4. **Create `src/resources/extensions/gsd/tests/journal-integration.test.ts`**:
   - Build a mock `LoopDeps` that captures `emitJournalEvent` calls into an array.
   - Build a mock `IterationContext` with a real `flowId` (from `randomUUID()`), real `nextSeq` counter, and minimal mock deps.
   - Test 1: Call `runDispatch()` with a mock registry that returns a dispatch action with `matchedRule`. Assert the captured events include a `dispatch-match` event with the correct `rule` field and the `flowId` from the context.
   - Test 2: Call `runUnitPhase()` with mock data. Assert `unit-start` and `unit-end` events are emitted, `unit-end` has `causedBy` referencing `unit-start`'s seq, both share the same `flowId`.
   - Test 3: Verify that all captured events from a full mock iteration have monotonically increasing `seq` numbers and the same `flowId`.
   - Test 4: Verify that `dispatch-match` events include `matchedRule` field matching the rule name.
   - Use the same test helpers pattern as other auto-loop tests (check `tests/auto-loop.test.ts` for mock LoopDeps patterns).

5. **Run all verification commands**:
   - `node --test src/resources/extensions/gsd/tests/journal-integration.test.ts`
   - `node --test src/resources/extensions/gsd/tests/journal.test.ts`
   - `node --test src/resources/extensions/gsd/tests/auto-loop.test.ts` (regression check — loop.ts was modified)

## Must-Haves

- [ ] `loop.ts` generates flowId + seqCounter per iteration and passes to IterationContext
- [ ] `loop.ts` emits iteration-start and iteration-end events
- [ ] `phases.ts` emits dispatch-match, dispatch-stop, pre-dispatch-hook, unit-start, unit-end, terminal events
- [ ] All emissions go through `deps.emitJournalEvent()`, never importing journal.ts directly
- [ ] `unit-end` event has `causedBy` referencing `unit-start` event's `{ flowId, seq }`
- [ ] Integration test proves correct event sequence from mocked iteration
- [ ] All existing auto-loop tests pass

## Verification

- `node --test src/resources/extensions/gsd/tests/journal-integration.test.ts` — integration test passes
- `node --test src/resources/extensions/gsd/tests/journal.test.ts` — unit tests still pass
- `node --test src/resources/extensions/gsd/tests/auto-loop.test.ts` — no regression on loop tests

## Inputs

- `src/resources/extensions/gsd/journal.ts` — `JournalEntry` type and `emitJournalEvent` (from T01)
- `src/resources/extensions/gsd/auto/types.ts` — `IterationContext` with `flowId` and `nextSeq` (from T02)
- `src/resources/extensions/gsd/auto/loop-deps.ts` — `LoopDeps` with `emitJournalEvent` (from T02)
- `src/resources/extensions/gsd/auto-dispatch.ts` — `DispatchAction` with `matchedRule` (from T02)
- `src/resources/extensions/gsd/auto/loop.ts` — main loop to modify
- `src/resources/extensions/gsd/auto/phases.ts` — phase functions to modify

## Expected Output

- `src/resources/extensions/gsd/auto/loop.ts` — flowId generation, iteration-start/end emission, sidecar-dequeue emission
- `src/resources/extensions/gsd/auto/phases.ts` — dispatch-match, dispatch-stop, pre-dispatch-hook, unit-start, unit-end, terminal, milestone-transition emission
- `src/resources/extensions/gsd/tests/journal-integration.test.ts` — integration test proving event sequence
- `src/resources/extensions/gsd/journal.ts` — possibly updated event type union

## Observability Impact

- **New signals:** Every auto-mode iteration now emits structured journal events at key boundaries: `iteration-start`, `dispatch-match`/`dispatch-stop`, `pre-dispatch-hook`, `unit-start`, `unit-end` (with `causedBy` reference), `terminal`, `milestone-transition`, `sidecar-dequeue`, `iteration-end`.
- **Inspection:** `queryJournal(basePath, { flowId })` reconstructs the full event sequence for any iteration. `cat .gsd/journal/YYYY-MM-DD.jsonl | jq .` gives raw access. Events with `rule` field trace provenance to the unified registry.
- **Failure visibility:** Missing events for a given flowId indicates silent write failure (check disk/permissions). A `unit-end` without matching `unit-start` causedBy indicates a sequencing bug. Terminal events document why auto-mode stopped.
- **What a future agent inspects:** Query for a flowId and check event count matches expected phases; verify `causedBy` chains are intact; check `rule` field on dispatch events for provenance.
