/**
 * auto-start-bootstrap-await-3420.test.ts — Regression test for #3420.
 *
 * Bug: In bootstrapAutoSession, when state.phase === "pre-planning" and no
 * context file exists, showSmartEntry is called to dispatch a discuss workflow.
 * showSmartEntry calls dispatchWorkflow which calls pi.sendMessage() — a
 * fire-and-forget call that returns immediately. The LLM discussion runs
 * asynchronously in a separate turn.
 *
 * The bug: after showSmartEntry returns (before the LLM has run), the code
 * immediately calls invalidateAllCaches() + deriveState() + checks postState.
 * Since the discussion hasn't run yet, postState.phase is still "pre-planning"
 * and the context check fails, producing the warning:
 *   "Discussion completed but milestone context is still missing. Run /gsd to try again."
 *
 * The discussion never ran — the warning fires immediately.
 *
 * Fix: bootstrapAutoSession must return false (release lock) after showSmartEntry
 * dispatches the workflow. The checkAutoStartAfterDiscuss callback in guided-flow.ts
 * already handles re-entering auto-mode when the discussion completes.
 *
 * This test verifies the fix by asserting that the pre-planning !hasContext block
 * does NOT contain a postState phase check after showSmartEntry — it must
 * return false immediately to let the async dispatch complete.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourcePath = join(import.meta.dirname, "..", "auto-start.ts");
const source = readFileSync(sourcePath, "utf-8");

test("bootstrapAutoSession: pre-planning no-context path does NOT check postState immediately after showSmartEntry (#3420)", () => {
  // Find the pre-planning block that handles the case where context is missing.
  // This block dispatches showSmartEntry which is async (fire-and-forget via pi.sendMessage).
  // After the dispatch, checking postState.phase immediately is premature — the
  // LLM discussion hasn't run yet. The block should return false instead.
  const prePlanningNoContextBlock = source.match(
    /\/\/ Active milestone exists but has no roadmap\s*\n\s*if\s*\(\s*state\.phase\s*===\s*"pre-planning"\s*\)([\s\S]*?)\/\/ Active milestone has CONTEXT-DRAFT/,
  );
  assert.ok(
    !!prePlanningNoContextBlock,
    "auto-start.ts must have the pre-planning handler block before needs-discussion",
  );

  const block = prePlanningNoContextBlock![1];

  // The block must call showSmartEntry when !hasContext
  assert.ok(
    block.includes("showSmartEntry"),
    "pre-planning !hasContext block must call showSmartEntry to dispatch the discuss workflow",
  );

  // FAILING ASSERTION (before fix): after showSmartEntry, the block must NOT
  // immediately check postState.phase — that check fires before the LLM runs.
  // Instead, it must return false (release lock) so the async dispatch can complete.
  // The warning "Discussion completed but milestone context is still missing"
  // fires prematurely when this postState check exists.
  assert.ok(
    !block.includes("Discussion completed but milestone context is still missing"),
    "pre-planning !hasContext block must NOT check postState.phase immediately after showSmartEntry — " +
    "the dispatch is async (pi.sendMessage is fire-and-forget) and the discussion hasn't run yet; " +
    "return false instead so checkAutoStartAfterDiscuss can re-enter auto-mode after discussion completes (#3420)",
  );
});

test("bootstrapAutoSession: complete/no-milestone path does NOT check postState immediately after showSmartEntry (#3420)", () => {
  // Find the complete/no-milestone block
  const completeBlock = source.match(
    /\/\/ No active work — start a new milestone via discuss flow\s*\n\s*if\s*\(!state\.activeMilestone\s*\|\|\s*state\.phase\s*===\s*"complete"\s*\)([\s\S]*?)\/\/ Active milestone exists but has no roadmap/,
  );
  assert.ok(
    !!completeBlock,
    "auto-start.ts must have the complete/no-milestone handler block",
  );

  const block = completeBlock![1];

  // The block must call showSmartEntry
  assert.ok(
    block.includes("showSmartEntry"),
    "complete/no-milestone block must call showSmartEntry",
  );

  // After showSmartEntry dispatches, checking postState.phase is premature —
  // the LLM hasn't had a turn yet. The block should return false.
  // Specifically, the "no milestone context was written" warning fires too early.
  assert.ok(
    !block.includes("Discussion completed but no milestone context was written"),
    "complete/no-milestone block must NOT check postState.phase immediately after showSmartEntry dispatch — " +
    "return false instead so the async LLM turn can complete (#3420)",
  );
});

test("bootstrapAutoSession: showSmartEntry in pre-planning path is followed by releaseLockAndReturn, not postState check (#3420)", () => {
  // After the fix, the pre-planning !hasContext branch should call showSmartEntry
  // and then immediately return releaseLockAndReturn() — not check postState.
  const prePlanningNoContextBlock = source.match(
    /\/\/ Active milestone exists but has no roadmap\s*\n\s*if\s*\(\s*state\.phase\s*===\s*"pre-planning"\s*\)([\s\S]*?)\/\/ Active milestone has CONTEXT-DRAFT/,
  );
  assert.ok(!!prePlanningNoContextBlock, "pre-planning handler block found");

  const block = prePlanningNoContextBlock![1];

  // After the fix, the !hasContext branch ends with releaseLockAndReturn
  assert.ok(
    block.includes("releaseLockAndReturn"),
    "pre-planning !hasContext block must call releaseLockAndReturn() after showSmartEntry dispatch (#3420)",
  );

  // The showSmartEntry call must appear before releaseLockAndReturn
  const showSmartEntryIdx = block.indexOf("showSmartEntry");
  const releaseLockIdx = block.indexOf("releaseLockAndReturn");
  assert.ok(
    showSmartEntryIdx > -1 && releaseLockIdx > -1,
    "both showSmartEntry and releaseLockAndReturn must appear in the block",
  );
  assert.ok(
    showSmartEntryIdx < releaseLockIdx,
    "showSmartEntry must appear before releaseLockAndReturn in pre-planning !hasContext block",
  );

  // There must be NO invalidateAllCaches between showSmartEntry and releaseLockAndReturn
  // (invalidateAllCaches + deriveState after showSmartEntry is the buggy premature check)
  const afterShowSmartEntry = block.substring(showSmartEntryIdx);
  const cacheInvalidateIdx = afterShowSmartEntry.indexOf("invalidateAllCaches");
  const releaseFromShowIdx = afterShowSmartEntry.indexOf("releaseLockAndReturn");

  // If invalidateAllCaches appears, it must appear AFTER releaseLockAndReturn
  // (which is impossible since releaseLockAndReturn returns) — so invalidateAllCaches
  // must not appear at all between showSmartEntry and the end of the !hasContext block.
  if (cacheInvalidateIdx !== -1) {
    assert.ok(
      cacheInvalidateIdx > releaseFromShowIdx,
      "invalidateAllCaches must NOT appear between showSmartEntry and releaseLockAndReturn — " +
      "this is the premature postState check that causes #3420",
    );
  }
});
