/**
 * Regression tests for PR #4288 — auto-retry bug, .mcp.json churn, and MCP
 * worktree routing fixes (behaviour subset).
 *
 * The remaining 13 structural assertions (source-grep against register-hooks,
 * auto-recovery, workflow-tools) were removed in favour of follow-up issues
 * tracking a pure-helper extraction per the #4832/PR #4859 precedent. This
 * file retains only the real behaviour tests against the public API of
 * evidence-collector.
 *
 * Follow-ups filed for the removed coverage — see PR body.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  resetEvidence,
  getEvidence,
  recordToolCall,
  recordToolResult,
  type BashEvidence,
} from "../safety/evidence-collector.js";

describe("evidence-collector: toolCallId-based matching (A-3)", () => {
  beforeEach(() => {
    resetEvidence();
  });

  it("records bash calls with their toolCallId at dispatch time", () => {
    recordToolCall("tc-1", "bash", { command: "ls -la" });
    recordToolCall("tc-2", "bash", { command: "git status" });

    const entries = getEvidence();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].toolCallId, "tc-1");
    assert.equal(entries[1].toolCallId, "tc-2");
  });

  it("matches results to the correct entry by toolCallId, not insertion order", () => {
    recordToolCall("tc-1", "bash", { command: "slow-thing" });
    recordToolCall("tc-2", "bash", { command: "fast-thing" });

    recordToolResult("tc-2", "bash", "Command exited with code 0\nfast-output", false);
    recordToolResult("tc-1", "bash", "Command exited with code 1\nslow-failure", true);

    const entries = getEvidence() as readonly BashEvidence[];
    const tc1 = entries.find(e => e.toolCallId === "tc-1") as BashEvidence | undefined;
    const tc2 = entries.find(e => e.toolCallId === "tc-2") as BashEvidence | undefined;

    assert.ok(tc1, "tc-1 entry must exist");
    assert.ok(tc2, "tc-2 entry must exist");
    assert.equal(tc1.command, "slow-thing");
    assert.equal(tc1.exitCode, 1);
    assert.ok(tc1.outputSnippet.includes("slow-failure"));

    assert.equal(tc2.command, "fast-thing");
    assert.equal(tc2.exitCode, 0);
    assert.ok(tc2.outputSnippet.includes("fast-output"));
  });

  it("ignores results with unknown toolCallIds rather than corrupting nearby entries", () => {
    recordToolCall("tc-1", "bash", { command: "real" });
    recordToolResult("tc-UNKNOWN", "bash", "Command exited with code 0\n", false);

    const entries = getEvidence() as readonly BashEvidence[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].toolCallId, "tc-1");
    assert.equal(entries[0].exitCode, -1);
    assert.equal(entries[0].outputSnippet, "");
  });

  it("records write/edit entries with their toolCallId", () => {
    recordToolCall("tc-write", "write", { file_path: "/tmp/a.md" });
    recordToolCall("tc-edit", "edit", { file_path: "/tmp/b.md" });

    const entries = getEvidence();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, "write");
    assert.equal(entries[0].toolCallId, "tc-write");
    assert.equal(entries[1].kind, "edit");
    assert.equal(entries[1].toolCallId, "tc-edit");
  });
});
