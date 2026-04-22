/**
 * Behavioral tests for GSD-owned TUI integration.
 *
 * The original source-shape assertions against pi vendor internals
 * (ToolExecutionComponent.markHistoricalNoResult and
 * InteractiveMode.showSuccess) were removed per D-12 — pi has its own
 * test suite. This file retains the one assertion that validates
 * GSD-owned behavior: guided-flow emitting the milestone-ready notification
 * with the correct type so it renders in the success-styled box.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const guidedFlowSrc = readFileSync(
  resolve(process.cwd(), "src", "resources", "extensions", "gsd", "guided-flow.ts"),
  "utf-8",
);

describe("guided-flow milestone notification (GSD-owned behavior)", () => {
  it('emits "Milestone ready" as an info notification', () => {
    // pi 0.67.2 removed "success" from the notify type union; changed to "info"
    assert.ok(
      guidedFlowSrc.includes('ctx.ui.notify(`Milestone ${milestoneId} ready.`, "info")'),
      "guided-flow must emit the milestone-ready notification with type 'info'",
    );
  });
});
