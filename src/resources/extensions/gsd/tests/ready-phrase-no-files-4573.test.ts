/**
 * GSD-2 / guided-flow — regression tests for #4573
 *
 * Covers two recovery paths:
 *   - maybeHandleReadyPhraseWithoutFiles: nudge when LLM emits
 *     "Milestone M001 ready." without writing CONTEXT.md / ROADMAP.md
 *   - maybeHandleEmptyIntentTurn: nudge when LLM narrates intent but
 *     emits no tool-use blocks
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  setPendingAutoStart,
  clearPendingAutoStart,
  maybeHandleReadyPhraseWithoutFiles,
  maybeHandleEmptyIntentTurn,
  resetEmptyTurnCounter,
} from "../guided-flow.ts";

// ─── Test harness ──────────────────────────────────────────────────────────

interface MockCapture {
  notifies: Array<{ msg: string; level: string }>;
  messages: Array<{ payload: any; options: any }>;
}

function mkCapture(): MockCapture {
  return { notifies: [], messages: [] };
}

function mkCtx(cap: MockCapture): any {
  return {
    ui: {
      notify: (msg: string, level: string) => {
        cap.notifies.push({ msg, level });
      },
    },
  };
}

function mkPi(cap: MockCapture, opts: { sendThrows?: boolean } = {}): any {
  return {
    sendMessage: (payload: any, options: any) => {
      if (opts.sendThrows) throw new Error("send failed");
      cap.messages.push({ payload, options });
    },
    setActiveTools: () => undefined,
    getActiveTools: () => [],
  };
}

function mkBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-4573-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}

function assistantMsg(text: string, opts: { toolUse?: boolean } = {}): any {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (opts.toolUse) content.push({ type: "tool_use", name: "whatever", input: {} });
  return { role: "assistant", content };
}

// ─── ready-phrase recovery (Layer 2) ───────────────────────────────────────

describe("#4573 maybeHandleReadyPhraseWithoutFiles", () => {
  beforeEach(() => {
    clearPendingAutoStart();
    resetEmptyTurnCounter();
  });

  test("no pending entry → no-op", () => {
    const cap = mkCapture();
    const event = { messages: [assistantMsg("Milestone M001 ready.")] };
    const handled = maybeHandleReadyPhraseWithoutFiles(event);
    assert.equal(handled, false);
    assert.equal(cap.messages.length, 0);
  });

  test("pending entry, ready phrase, no files → notify + sendMessage", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")],
      });
      assert.equal(handled, true);
      assert.equal(cap.messages.length, 1);
      assert.equal(cap.messages[0].payload.customType, "gsd-ready-no-files");
      assert.equal(cap.messages[0].options.triggerTurn, true);
      assert.ok(
        cap.notifies.some((n) => /rejected/.test(n.msg)),
        "user notified about rejection",
      );
    } finally {
      clearPendingAutoStart();
    }
  });

  test("retry cap — after MAX_READY_REJECTS the nudge stops and entry clears", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const event = { messages: [assistantMsg("Milestone M001 ready.")] };

      const first = maybeHandleReadyPhraseWithoutFiles(event);
      const second = maybeHandleReadyPhraseWithoutFiles(event);
      const third = maybeHandleReadyPhraseWithoutFiles(event); // > MAX

      assert.equal(first, true);
      assert.equal(second, true);
      assert.equal(third, true); // still returns true (handled via give-up)
      assert.equal(cap.messages.length, 2, "only 2 nudges sent (MAX_READY_REJECTS=2)");
      assert.ok(
        cap.notifies.some((n) => /Stopping auto-nudge/.test(n.msg)),
        "gives up with error notify",
      );

      // After giving up, a fresh re-entry starts clean
      const fourth = maybeHandleReadyPhraseWithoutFiles(event);
      assert.equal(fourth, false, "pending entry was cleared — nothing to handle");
    } finally {
      clearPendingAutoStart();
    }
  });

  test("files present → no nudge (happy path already fired)", () => {
    const base = mkBase();
    try {
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# ctx");
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")],
      });
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("last message lacks ready phrase → no-op", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Let me think about the slices first.")],
      });
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("fresh entry after give-up resets counter", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      // First cycle: exhaust cap
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const event = { messages: [assistantMsg("Milestone M001 ready.")] };
      maybeHandleReadyPhraseWithoutFiles(event);
      maybeHandleReadyPhraseWithoutFiles(event);
      maybeHandleReadyPhraseWithoutFiles(event); // clears entry

      // New /gsd run — re-seeds entry; counter must be 0 again
      cap.messages.length = 0;
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleReadyPhraseWithoutFiles(event);
      assert.equal(handled, true);
      assert.equal(cap.messages.length, 1, "fresh entry fires nudge again");
    } finally {
      clearPendingAutoStart();
    }
  });
});

// ─── empty-turn recovery (Layer 3) ────────────────────────────────────────

describe("#4573 maybeHandleEmptyIntentTurn", () => {
  beforeEach(() => {
    clearPendingAutoStart();
    resetEmptyTurnCounter();
  });

  test("no pending entry + isAuto false → no-op (interactive discuss is user-driven)", () => {
    const event = { messages: [assistantMsg("I'll write the CONTEXT.md now.")] };
    const handled = maybeHandleEmptyIntentTurn(event, false);
    assert.equal(handled, false);
  });

  test("text-only turn WITHOUT commit phrase → not flagged (legitimate text)", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Here is the roadmap preview — three slices.")] },
        false,
      );
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("text-only turn ending in question → treated as user-handoff, not flagged", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Ready to write, or want to adjust?")] },
        false,
      );
      assert.equal(handled, false);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("commit-intent phrase WITHOUT tool call → nudge fires", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("I'll now write the CONTEXT.md file.")] },
        false,
      );
      assert.equal(handled, true);
      assert.equal(cap.messages.length, 1);
      assert.equal(cap.messages[0].payload.customType, "gsd-empty-turn-recovery");
    } finally {
      clearPendingAutoStart();
    }
  });

  test("commit-intent WITH tool-use block → not flagged", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("I'll write the file now.", { toolUse: true })] },
        false,
      );
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("ready phrase is NOT treated as empty-turn (handled by other recovery path)", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Milestone M001 ready.")] },
        false,
      );
      assert.equal(handled, false);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("empty-turn retry cap — stops after MAX_EMPTY_TURN_RETRIES", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const event = { messages: [assistantMsg("I'll write the CONTEXT.md file.")] };

      maybeHandleEmptyIntentTurn(event, false); // 1
      maybeHandleEmptyIntentTurn(event, false); // 2
      const third = maybeHandleEmptyIntentTurn(event, false); // > cap

      assert.equal(cap.messages.length, 2, "only 2 nudges sent");
      assert.equal(third, false, "after cap, no further injection");
      assert.ok(
        cap.notifies.some((n) => /Stopping auto-nudge/.test(n.msg)),
        "user notified of give-up",
      );
    } finally {
      clearPendingAutoStart();
    }
  });

  test("resetEmptyTurnCounter clears state after a successful tool-use turn", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const event = { messages: [assistantMsg("I'll write the CONTEXT.md file.")] };

      maybeHandleEmptyIntentTurn(event, false); // 1
      maybeHandleEmptyIntentTurn(event, false); // 2 — at cap
      resetEmptyTurnCounter(); // simulate a successful tool-use turn in between

      cap.messages.length = 0;
      const after = maybeHandleEmptyIntentTurn(event, false);
      assert.equal(after, true, "counter reset — nudge fires again");
      assert.equal(cap.messages.length, 1);
    } finally {
      clearPendingAutoStart();
    }
  });
});
