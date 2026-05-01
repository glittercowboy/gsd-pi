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
import { drainLogs } from "../workflow-logger.ts";

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

function assistantMsg(
  text: string,
  opts: { toolUse?: boolean | "toolCall" | "serverToolUse" } = {},
): any {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (opts.toolUse) {
    // The canonical pi-ai AssistantMessage uses "toolCall" / "serverToolUse"
    // (see packages/pi-ai/src/types.ts). Every provider — anthropic-direct,
    // claude-code-cli, openai — normalizes incoming tool blocks into these
    // shapes before they reach guided-flow. The Anthropic-wire literal
    // "tool_use" never appears here.
    if (opts.toolUse === "serverToolUse") {
      content.push({ type: "serverToolUse", id: "test-id", name: "web_search", input: {} });
    } else {
      content.push({ type: "toolCall", id: "test-id", name: "whatever", arguments: {} });
    }
  }
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

  test("legacy unprefixed files present → no nudge", () => {
    const base = mkBase();
    try {
      writeFileSync(join(base, ".gsd", "milestones", "M001", "CONTEXT.md"), "# ctx");
      writeFileSync(join(base, ".gsd", "milestones", "M001", "ROADMAP.md"), "# roadmap");
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

  test("nudge fires → diagnostic warning logged with basePath, mDir, canonical-path existsSync results", () => {
    // Diagnostic logging added so we can tell, in real failures, whether
    // resolveMilestoneFile is reporting files missing that actually exist on
    // disk (basePath/symlink mismatch, stale cache despite the
    // agent-end-recovery flush, legacy descriptor dir, etc.).
    const base = mkBase();
    try {
      drainLogs(); // discard prior test noise
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

      const logs = drainLogs();
      const diag = logs.find(
        (e) => e.component === "guided" && /ready-phrase-reject diagnostic/.test(e.message),
      );
      assert.ok(diag, "expected diagnostic warning to be logged when nudge fires");
      assert.match(diag!.message, /mid=M001/);
      assert.match(diag!.message, new RegExp(`basePath=${base.replace(/[/\\]/g, "[/\\\\]")}`));
      assert.match(diag!.message, /mDir=/);
      assert.match(diag!.message, /ctx-exists=false/);
      assert.match(diag!.message, /roadmap-exists=false/);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("diagnostic logs ctx-exists=true when file is on disk but cached resolver missed it", () => {
    // Simulates the test123 #5xxx scenario: file exists on disk, cached
    // resolver claims it doesn't. We drop a file with a non-canonical path
    // (forces the legacy-descriptor pattern miss) so resolveMilestoneFile
    // returns null but existsSync on the canonical path returns true.
    //
    // Note: the canonical path probe in the diagnostic uses the literal
    // `${milestoneId}-CONTEXT.md` filename. If a file is at that path,
    // existsSync will see it regardless of resolver behavior.
    const base = mkBase();
    try {
      drainLogs();
      // Write the canonical file directly — both resolver AND existsSync
      // would normally see it. To prove the diagnostic captures the
      // existsSync result independently, we cover the basic case here.
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      // No files written — both probes should report false.
      maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")],
      });
      const logs = drainLogs();
      const diag = logs.find(
        (e) => e.component === "guided" && /ready-phrase-reject diagnostic/.test(e.message),
      );
      assert.ok(diag, "diagnostic logged");
      // mDir resolves because mkBase creates the directory
      assert.match(diag!.message, /mDir=.+M001/);
      assert.match(diag!.message, /canonical-ctx=.+M001-CONTEXT\.md/);
      assert.match(diag!.message, /canonical-roadmap=.+M001-ROADMAP\.md/);
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

  test("multi-line message with mid-message question → treated as user-handoff (regression: discuss flow)", () => {
    // Regression for the deep-mode discuss-project case where the LLM asked
    // a clarifying question mid-message and ended on a closing remark. The
    // previous heuristic only checked the LAST line for `?` and missed the
    // earlier question, causing the empty-turn nudge to auto-reply on
    // behalf of the user.
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      const text = [
        "Let me make sure I understand what you're testing here.",
        "",
        "We need something to plan. A few lightweight options:",
        "- A simple CLI tool",
        "- A static API",
        "",
        "What should the fictional project be?",
        "",
        "If you have a preference, say the word and I'll pick one.",
      ].join("\n");
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg(text)] },
        false,
      );
      assert.equal(handled, false, "any line ending in ? must defer to the user");
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("single-line approval prompt with mid-line `?` and conditional intent → treated as user-handoff (regression: #5187 follow-up)", () => {
    // Regression for the discuss-milestone case where the LLM presented a
    // depth summary and ended with: "Did I capture that correctly? If so,
    // say yes and I'll write requirements and the roadmap preview."
    // The previous heuristic only checked for lines *ending* in `?`, so
    // this single-line paragraph (terminating in `.`) bypassed the
    // user-handoff guard, then COMMIT_INTENT_RE matched "I'll write" and
    // the nudge auto-replied while the user was meant to approve.
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
        {
          messages: [
            assistantMsg(
              "Did I capture that correctly? If so, say yes and I'll write requirements and the roadmap preview.",
            ),
          ],
        },
        false,
      );
      assert.equal(handled, false, "any sentence-terminating ? must defer to the user");
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });

  test('"Let me make sure" meta phrase → not flagged as commit intent (regression)', () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap),
      });
      // No question mark anywhere — so the only thing keeping this from
      // firing the nudge should be the refined commit-intent regex
      // (dropping "make" from the verb list).
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Let me make sure I have this right.")] },
        false,
      );
      assert.equal(handled, false, "meta acknowledgments are not action announcements");
      assert.equal(cap.messages.length, 0);
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

  // Regression for #4658 — under claude-code-cli, MCP tool calls (e.g.
  // ask_user_questions) reach guided-flow as canonical "toolCall" / "serverToolUse"
  // blocks. Pre-fix, hasToolUse only matched the Anthropic-wire literal "tool_use",
  // so the empty-turn nudge fired during pre-question narration and pre-empted the
  // user's chance to answer.
  test("cc-cli MCP tool call surfaced as canonical toolCall → not flagged", () => {
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
        {
          messages: [
            assistantMsg("Let me call ask_user_questions to gather your preferences.", {
              toolUse: "toolCall",
            }),
          ],
        },
        false,
      );
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });

  test("serverToolUse block (cc-cli web search etc.) → not flagged", () => {
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
        {
          messages: [
            assistantMsg("Let me invoke the search tool now.", {
              toolUse: "serverToolUse",
            }),
          ],
        },
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
