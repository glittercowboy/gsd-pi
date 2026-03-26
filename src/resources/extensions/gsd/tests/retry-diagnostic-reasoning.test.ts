/**
 * Regression tests for #2195: formatTraceSummary (used by getDeepDiagnostic →
 * retry prompts) must NOT include lastReasoning from prior assistant text.
 *
 * Including prior assistant free-text in retry diagnostics causes hallucination
 * loops when the previous turn was truncated or malformed.
 *
 * The crash recovery path (formatCrashRecoveryBriefing) has its own safe handling
 * of lastReasoning and is NOT affected by this change.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractTrace, getDeepDiagnostic } from "../session-forensics.ts";

/** Build a minimal assistant text reasoning entry. */
function makeAssistantText(text: string): unknown {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

/** Build a minimal assistant tool call + tool result pair. */
function makeToolPair(
  toolName: string,
  input: Record<string, unknown>,
  resultText: string,
  isError: boolean,
): unknown[] {
  const toolCallId = `toolu_${Math.random().toString(36).slice(2, 10)}`;
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: toolName,
            arguments: input,
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        isError,
        content: [{ type: "text", text: resultText }],
      },
    },
  ];
}

describe("retry diagnostic excludes lastReasoning (#2195)", () => {
  test("extractTrace still captures lastReasoning in the trace object", () => {
    const entries = [
      makeAssistantText("I am going to write the summary file now"),
      ...makeToolPair("write", { path: "/tmp/SUMMARY.md" }, "ok", false),
      makeAssistantText("The task is complete — all files written."),
    ];

    const trace = extractTrace(entries);
    // extractTrace should still collect lastReasoning for crash recovery
    assert.ok(trace.lastReasoning.length > 0,
      "extractTrace should still populate lastReasoning");
    assert.ok(trace.lastReasoning.includes("all files written"),
      "lastReasoning should contain the last assistant text");
  });

  test("getDeepDiagnostic output does NOT contain lastReasoning", () => {
    // Create a temporary activity directory with a JSONL file
    const tempBase = mkdtempSync(join(tmpdir(), "gsd-diag-test-"));
    const gsdDir = join(tempBase, ".gsd");
    const activityDir = join(gsdDir, "activity");
    mkdirSync(activityDir, { recursive: true });

    try {
      // Build entries with both tool calls and assistant reasoning
      const entries = [
        makeAssistantText("Let me analyze the codebase structure first"),
        ...makeToolPair("bash", { command: "ls src/" }, "index.ts\nutils.ts", false),
        makeAssistantText("I see the milestone/M001 branch has a significantly different ... 3. "),
      ];

      // Write JSONL activity file
      const jsonl = entries.map(e => JSON.stringify(e)).join("\n");
      writeFileSync(join(activityDir, "2025-01-01T00-00-00.jsonl"), jsonl);

      const diagnostic = getDeepDiagnostic(tempBase);

      // Diagnostic should exist (we have tool calls)
      assert.ok(diagnostic !== null, "diagnostic should not be null");

      // Diagnostic should contain structured execution evidence
      assert.ok(diagnostic!.includes("Tool calls completed:"),
        "should include tool call count");
      assert.ok(diagnostic!.includes("ls src/"),
        "should include commands run");

      // Diagnostic must NOT contain the assistant's free-text reasoning
      assert.ok(!diagnostic!.includes("Last reasoning"),
        "diagnostic must not include 'Last reasoning' label");
      assert.ok(!diagnostic!.includes("analyze the codebase"),
        "diagnostic must not include prior assistant text");
      assert.ok(!diagnostic!.includes("significantly different"),
        "diagnostic must not include truncated assistant reasoning");
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  test("getDeepDiagnostic still includes errors and file operations", () => {
    const tempBase = mkdtempSync(join(tmpdir(), "gsd-diag-test-"));
    const gsdDir = join(tempBase, ".gsd");
    const activityDir = join(gsdDir, "activity");
    mkdirSync(activityDir, { recursive: true });

    try {
      const entries = [
        makeAssistantText("Writing the plan file"),
        ...makeToolPair("write", { path: "M001/S01/S01-PLAN.md" }, "ok", false),
        ...makeToolPair("bash", { command: "npm run build" }, "Error: type mismatch", true),
        makeAssistantText("The build failed, let me investigate"),
      ];

      const jsonl = entries.map(e => JSON.stringify(e)).join("\n");
      writeFileSync(join(activityDir, "2025-01-01T00-00-00.jsonl"), jsonl);

      const diagnostic = getDeepDiagnostic(tempBase);
      assert.ok(diagnostic !== null);

      // Structured evidence should be present
      assert.ok(diagnostic!.includes("S01-PLAN.md"),
        "should include files written");
      assert.ok(diagnostic!.includes("npm run build"),
        "should include commands run");
      assert.ok(diagnostic!.includes("type mismatch"),
        "should include errors");

      // But NOT the assistant's free-text
      assert.ok(!diagnostic!.includes("Writing the plan"),
        "must not include assistant reasoning");
      assert.ok(!diagnostic!.includes("build failed"),
        "must not include assistant reasoning about failures");
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });
});
