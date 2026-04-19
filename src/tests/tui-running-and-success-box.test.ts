/**
 * Regression tests for two TUI bugs:
 *
 *   1. Tool execution cards stuck in "Running" state after compaction.
 *      When the session is rebuilt from history (post-compaction or session
 *      switch), tool result messages may have been squashed out of context.
 *      ToolExecutionComponent instances created from history without a result
 *      stay in `isPartial = true` forever, rendering the "Running" badge long
 *      after the tool completed. Fix: markHistoricalNoResult() flips them to
 *      a finished, no-result state and renderSessionContext calls it on any
 *      leftover pendingTools before clearing the map.
 *
 *   2. Completion notifications rendered as plain dim text.
 *      `ctx.ui.notify("…", "info")` routed through showStatus which produced
 *      a single-line dim Text component — indistinguishable from chatter.
 *      Completion messages (notify type = "success") now render inside a
 *      green DynamicBorder frame via showSuccess, matching the design of
 *      showNewVersionNotification but in success color.
 *
 * These tests are source-shape assertions (not runtime exercises) to keep
 * the test cheap — the actual components depend on the TUI runtime stack
 * which isn't easily instantiable in unit tests.
 *
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const toolExecSrc = readFileSync(
  resolve(
    process.cwd(),
    "packages",
    "pi-coding-agent",
    "src",
    "modes",
    "interactive",
    "components",
    "tool-execution.ts",
  ),
  "utf-8",
);

const interactiveSrc = readFileSync(
  resolve(
    process.cwd(),
    "packages",
    "pi-coding-agent",
    "src",
    "modes",
    "interactive",
    "interactive-mode.ts",
  ),
  "utf-8",
);

const guidedFlowSrc = readFileSync(
  resolve(process.cwd(), "src", "resources", "extensions", "gsd", "guided-flow.ts"),
  "utf-8",
);

// ─── Bug 1: tools stuck in "Running" after compaction ────────────────────

describe("ToolExecutionComponent.markHistoricalNoResult (post-compaction fix)", () => {
  it("defines markHistoricalNoResult on ToolExecutionComponent", () => {
    assert.ok(
      /markHistoricalNoResult\s*\(\s*\)\s*:\s*void/.test(toolExecSrc),
      "ToolExecutionComponent must expose markHistoricalNoResult(): void",
    );
  });

  it("markHistoricalNoResult clears isPartial and sets an empty result", () => {
    const idx = toolExecSrc.indexOf("markHistoricalNoResult");
    assert.ok(idx !== -1);
    // Find the method body window
    const body = toolExecSrc.slice(idx, idx + 600);
    assert.ok(
      body.includes("this.isPartial = false"),
      "markHistoricalNoResult must set isPartial = false so the frame flips out of Running",
    );
    assert.ok(
      body.includes("this.result"),
      "markHistoricalNoResult must populate this.result so !this.result is false",
    );
    assert.ok(
      body.includes("updateDisplay"),
      "markHistoricalNoResult must trigger a re-render",
    );
  });

  it("markHistoricalNoResult is idempotent when a real result already exists", () => {
    // The method returns early if this.result is already set so a late-
    // arriving stream update doesn't clobber legitimate result content.
    const idx = toolExecSrc.indexOf("markHistoricalNoResult");
    const body = toolExecSrc.slice(idx, idx + 600);
    assert.ok(
      /if\s*\(\s*this\.result\s*\)\s*return/.test(body),
      "markHistoricalNoResult must early-return when a result is already present",
    );
  });

  it("frameStatus still reads isPartial + result to derive Running/Done", () => {
    // Guard against accidental regression: the status label depends on both
    // fields being in the correct state after markHistoricalNoResult runs.
    assert.ok(
      /frameStatus\s*=\s*this\.isPartial\s*\|\|\s*!this\.result\s*\?\s*"Running"/.test(toolExecSrc),
      "frameStatus derivation must remain: Running when isPartial || !result, otherwise Done/Error",
    );
  });

  it("renderSessionContext marks leftover pendingTools as historical before clearing", () => {
    // After replay, any pendingTools without matching toolResult messages are
    // compaction survivors. Without this call they'd remain "Running" forever.
    const renderIdx = interactiveSrc.indexOf("private renderSessionContext");
    assert.ok(renderIdx !== -1, "renderSessionContext must exist");
    // The method defines-its-scope with the next `private ` member that
    // follows. Grab the full body so we can assert the end-of-method sweep.
    const nextMemberIdx = interactiveSrc.indexOf("\n\trenderInitialMessages", renderIdx);
    assert.ok(nextMemberIdx !== -1, "could not locate end of renderSessionContext body");
    const block = interactiveSrc.slice(renderIdx, nextMemberIdx);
    assert.ok(
      block.includes("markHistoricalNoResult"),
      "renderSessionContext must call markHistoricalNoResult on leftover pendingTools before clearing",
    );
    assert.ok(
      /for\s*\(\s*const\s+\w+\s+of\s+this\.pendingTools\.values\(\)\s*\)/.test(block),
      "the sweep must iterate this.pendingTools.values()",
    );
  });
});

// ─── Bug 2: completion messages should be a green bordered box ───────────

describe("showSuccess bordered notification (completion message styling)", () => {
  it("defines showSuccess(message: string): void on interactive-mode", () => {
    assert.ok(
      /showSuccess\s*\(\s*\w+\s*:\s*string\s*\)\s*:\s*void/.test(interactiveSrc),
      "interactive-mode must expose showSuccess(message: string): void",
    );
  });

  it("showSuccess uses DynamicBorder with the success theme color", () => {
    // Locate the METHOD DEFINITION (not a call site). The definition has a
    // typed parameter signature like `showSuccess(successMessage: string)`.
    const methodMatch = interactiveSrc.match(/showSuccess\s*\(\s*\w+\s*:\s*string\s*\)\s*:\s*void\s*\{/);
    assert.ok(methodMatch && methodMatch.index !== undefined, "showSuccess method definition must exist");
    const body = interactiveSrc.slice(methodMatch.index, methodMatch.index + 900);
    assert.ok(
      body.includes("DynamicBorder"),
      "showSuccess must wrap the message in a DynamicBorder (matches showNewVersionNotification style)",
    );
    assert.ok(
      /theme\.fg\(\s*["']success["']/.test(body),
      'showSuccess must color the border/text via theme.fg("success", …)',
    );
    // Two borders — top and bottom — for the boxed look.
    const borderMatches = body.match(/new\s+DynamicBorder\b/g) ?? [];
    assert.ok(
      borderMatches.length >= 2,
      "showSuccess must add both a top and bottom DynamicBorder for the boxed frame",
    );
  });

  it("showExtensionNotify routes type='success' to showSuccess", () => {
    const idx = interactiveSrc.indexOf("showExtensionNotify");
    assert.ok(idx !== -1);
    const body = interactiveSrc.slice(idx, idx + 1200);
    assert.ok(
      /type\s*===\s*["']success["']/.test(body),
      "showExtensionNotify must branch on type === 'success'",
    );
    // The success branch must reach showSuccess, not fall through to showStatus.
    const successIdx = body.indexOf('type === "success"');
    const successBranch = body.slice(successIdx, successIdx + 300);
    assert.ok(
      successBranch.includes("showSuccess"),
      "type === 'success' must be routed to this.showSuccess",
    );
  });

  it('guided-flow emits "Milestone ready" as a success notification', () => {
    assert.ok(
      guidedFlowSrc.includes('ctx.ui.notify(`Milestone ${milestoneId} ready.`, "success")'),
      "guided-flow must emit the milestone-ready notification with type 'success' so it renders in the green box",
    );
  });
});
