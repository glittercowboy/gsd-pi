/**
 * Regression tests for PR #4288 — auto-retry bug, .mcp.json churn, and MCP
 * worktree routing fixes.
 *
 * Covers four source-file changes:
 *   1. src/resources/extensions/gsd/safety/evidence-collector.ts (functional)
 *   2. src/resources/extensions/gsd/bootstrap/register-hooks.ts (source shape)
 *   3. src/resources/extensions/gsd/auto-recovery.ts (source shape)
 *   4. packages/mcp-server/src/workflow-tools.ts (source shape)
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  resetEvidence,
  getEvidence,
  recordToolCall,
  recordToolResult,
  type BashEvidence,
} from "../safety/evidence-collector.js";

// ─── 1. evidence-collector: functional ─────────────────────────────────────

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
    // Simulate two parallel bash calls dispatched in order tc-1, tc-2.
    recordToolCall("tc-1", "bash", { command: "slow-thing" });
    recordToolCall("tc-2", "bash", { command: "fast-thing" });

    // Results arrive out of order: tc-2 first (fast), then tc-1 (slow).
    // With the old empty-string-matching strategy, tc-2's result would be
    // stapled to tc-1's entry because findLastUnresolved scanned backwards
    // for empty ids. Now we match by id directly.
    recordToolResult("tc-2", "bash", "Command exited with code 0\nfast-output", false);
    recordToolResult("tc-1", "bash", "Command exited with code 1\nslow-failure", true);

    const entries = getEvidence() as readonly BashEvidence[];
    const tc1 = entries.find(e => e.toolCallId === "tc-1") as BashEvidence | undefined;
    const tc2 = entries.find(e => e.toolCallId === "tc-2") as BashEvidence | undefined;

    assert.ok(tc1, "tc-1 entry must exist");
    assert.ok(tc2, "tc-2 entry must exist");

    // The original command stays attached to the entry it was recorded with,
    // and the result matches the id it was reported for.
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
    // tc-1 must be untouched — no result was reported for it.
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

// ─── 2. register-hooks: MCP auto-prep gated inside auto-worktrees (A-1) ────

describe("register-hooks: skip prepareWorkflowMcpForProject inside auto-worktrees (A-1)", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src", "resources", "extensions", "gsd", "bootstrap", "register-hooks.ts"),
    "utf-8",
  );

  it("session_start hook is gated on isInAutoWorktree", () => {
    const idx = src.indexOf('pi.on("session_start"');
    assert.ok(idx !== -1, "session_start handler must exist");
    const block = src.slice(idx, idx + 2500);
    assert.ok(
      block.includes("isInAutoWorktree"),
      "session_start must consult isInAutoWorktree before preparing MCP",
    );
    assert.ok(
      block.includes("prepareWorkflowMcpForProject"),
      "session_start still prepares MCP for non-worktree paths",
    );
  });

  it("session_switch hook is gated on isInAutoWorktree", () => {
    const idx = src.indexOf('pi.on("session_switch"');
    assert.ok(idx !== -1, "session_switch handler must exist");
    const block = src.slice(idx, idx + 2500);
    assert.ok(
      block.includes("isInAutoWorktree"),
      "session_switch must consult isInAutoWorktree before preparing MCP",
    );
  });

  it("tool_call hook forwards event.toolCallId into safetyRecordToolCall (A-3)", () => {
    // Find the call site (skip the import line by looking for the opening paren).
    const idx = src.indexOf("safetyRecordToolCall(");
    assert.ok(idx !== -1, "safetyRecordToolCall call must exist");
    const line = src.slice(idx, src.indexOf("\n", idx));
    assert.ok(
      line.includes("event.toolCallId"),
      "safetyRecordToolCall must receive event.toolCallId as the first argument",
    );
  });
});

// ─── 3. auto-recovery: verify-fail instrumentation ─────────────────────────

describe("verifyExpectedArtifact: verify-fail exit-point logging (Phase B diag)", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src", "resources", "extensions", "gsd", "auto-recovery.ts"),
    "utf-8",
  );

  it("logs a verify-fail warning on the null-absPath exit", () => {
    assert.ok(
      src.includes('verify-fail ${unitType} ${unitId}: resolveExpectedArtifactPath returned null'),
      "null-absPath branch must emit a diagnostic line",
    );
  });

  it("logs a verify-fail warning on the existsSync-false exit", () => {
    assert.ok(
      src.includes("verify-fail ${unitType} ${unitId}: existsSync false"),
      "existsSync-false branch must emit a diagnostic line",
    );
  });

  it("logs a verify-fail warning on the plan-slice no-task-entry exit", () => {
    assert.ok(
      src.includes("verify-fail ${unitType} ${unitId}: plan has no task checkbox/heading"),
      "plan-slice no-task branch must emit a diagnostic line",
    );
  });

  it("plan-slice task-plan-files check fails fast on missing tasks dir (hardening)", () => {
    // The original check silently passed when resolveTasksDir returned null.
    // The new check returns false with a diagnostic, which is correct — if
    // the tool successfully planned tasks, the tasks/ dir must exist.
    const idx = src.indexOf('verify-fail ${unitType} ${unitId}: resolveTasksDir returned null');
    assert.ok(
      idx !== -1,
      "resolveTasksDir-null branch must emit a diagnostic and return false",
    );
  });
});

// ─── 4. workflow-tools (mcp-server): guard + optional projectDir + routing ─

describe("mcp-server workflow-tools: projectDir routing (Phase B root cause)", () => {
  const src = readFileSync(
    resolve(process.cwd(), "packages", "mcp-server", "src", "workflow-tools.ts"),
    "utf-8",
  );

  it("projectDirParam is optional and documents the default", () => {
    const idx = src.indexOf("const projectDirParam");
    assert.ok(idx !== -1, "projectDirParam definition must exist");
    const block = src.slice(idx, idx + 600);
    assert.ok(
      block.includes(".optional()"),
      "projectDirParam must be optional so the agent stops deliberating",
    );
    assert.ok(
      /Omit this field/i.test(block),
      "description must tell the agent to omit the field",
    );
  });

  it("parseWorkflowArgs defaults projectDir to process.cwd() when omitted", () => {
    const idx = src.indexOf("function parseWorkflowArgs");
    assert.ok(idx !== -1, "parseWorkflowArgs must exist");
    const block = src.slice(idx, idx + 1500);
    assert.ok(
      block.includes("parsed.projectDir ?? process.cwd()"),
      "parseWorkflowArgs must fall back to process.cwd() when projectDir is omitted",
    );
  });

  it("validateProjectDir accepts external-state worktree paths via .gsd symlink target", () => {
    const idx = src.indexOf("function validateProjectDir");
    assert.ok(idx !== -1, "validateProjectDir must exist");
    const block = src.slice(idx, idx + 2500);
    assert.ok(
      block.includes("resolveExternalStateRoot"),
      "validateProjectDir must consult resolveExternalStateRoot for external-state layouts",
    );

    const helperIdx = src.indexOf("function resolveExternalStateRoot");
    assert.ok(helperIdx !== -1, "resolveExternalStateRoot helper must exist");
    const helperBlock = src.slice(helperIdx, helperIdx + 600);
    assert.ok(
      helperBlock.includes("realpathSync"),
      "resolveExternalStateRoot must use realpathSync to follow the symlink",
    );
    assert.ok(
      /join\([^)]*\.gsd/.test(helperBlock),
      "resolveExternalStateRoot must resolve <allowedRoot>/.gsd",
    );
  });

  it("parseWorkflowArgs routes tool writes to the active worktree when one exists", () => {
    // This is the Phase B root-cause fix: when the tool call is scoped to a
    // milestone that has an auto-worktree at <projectRoot>/.gsd/worktrees/<MID>/,
    // tool writes must go to the worktree .gsd rather than the shared project .gsd.
    const parseIdx = src.indexOf("function parseWorkflowArgs");
    const parseBlock = src.slice(parseIdx, parseIdx + 2500);
    assert.ok(
      parseBlock.includes("resolveActiveWorktreeBasePath"),
      "parseWorkflowArgs must consult resolveActiveWorktreeBasePath",
    );
    assert.ok(
      parseBlock.includes("extractMilestoneId"),
      "parseWorkflowArgs must extract the milestoneId to locate the worktree",
    );
  });

  it("resolveActiveWorktreeBasePath checks .git presence to avoid hijacking stray directories", () => {
    const idx = src.indexOf("function resolveActiveWorktreeBasePath");
    assert.ok(idx !== -1, "resolveActiveWorktreeBasePath helper must exist");
    const block = src.slice(idx, idx + 1200);
    assert.ok(
      block.includes('existsSync(join(wtPath, ".git"))'),
      "resolveActiveWorktreeBasePath must verify a .git file exists in the worktree",
    );
  });

  it("extractMilestoneId handles camelCase, snake_case, and short aliases", () => {
    const idx = src.indexOf("function extractMilestoneId");
    assert.ok(idx !== -1, "extractMilestoneId helper must exist");
    const block = src.slice(idx, idx + 600);
    assert.ok(block.includes("milestoneId"), "must check milestoneId");
    assert.ok(block.includes("milestone_id"), "must check milestone_id");
    assert.ok(block.includes("mid"), "must check mid");
  });
});
