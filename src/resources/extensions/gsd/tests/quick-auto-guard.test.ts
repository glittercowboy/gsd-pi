/**
 * Tests that /gsd quick is blocked when auto-mode is active.
 *
 * Relates to #2417: /gsd quick freezes terminal when auto-mode is active.
 * The fix adds an isAutoActive() guard in handleWorkflowCommand before
 * delegating to handleQuick.
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Structural test: verify the guard exists in source ──────────────────────

describe("/gsd quick auto-mode guard (#2417)", () => {
  it("handleWorkflowCommand checks isAutoActive() before calling handleQuick", () => {
    // Read the source file and verify the guard is structurally present
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "commands",
        "handlers",
        "workflow.ts",
      ),
      "utf-8",
    );

    // Find the quick command block
    const quickBlockMatch = src.match(
      /if\s*\(\s*trimmed\s*===\s*"quick"\s*\|\|\s*trimmed\.startsWith\("quick "\)\s*\)\s*\{([\s\S]*?)\n  \}/,
    );
    assert.ok(quickBlockMatch, "quick command block exists in handleWorkflowCommand");

    const quickBlock = quickBlockMatch[1];

    // Verify the shared auto-mode guard comes BEFORE handleQuick call.
    // Accepts either the inline isAutoActive() check (legacy) or the shared
    // requireNotAutoActive() helper (#4712).
    const guardIndex = Math.max(
      quickBlock.indexOf("isAutoActive()"),
      quickBlock.indexOf("requireNotAutoActive("),
    );
    const handleQuickIndex = quickBlock.indexOf("handleQuick(");

    assert.ok(guardIndex !== -1, "auto-mode guard exists in quick command block");
    assert.ok(handleQuickIndex !== -1, "handleQuick() call exists in quick command block");
    assert.ok(
      guardIndex < handleQuickIndex,
      "auto-mode guard appears before handleQuick() call",
    );
  });

  it("guard shows error message mentioning /gsd stop", () => {
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "commands",
        "handlers",
        "workflow.ts",
      ),
      "utf-8",
    );

    // The shared helper assembles the message dynamically from the command name,
    // so assert on the message fragment and the /gsd stop instruction.
    assert.ok(
      src.includes("cannot run while auto-mode is active"),
      "error message explains that the command cannot run during auto-mode",
    );
    assert.ok(
      src.includes("/gsd stop"),
      "error message mentions /gsd stop as the resolution",
    );
  });

  it("guard returns true (handled) to prevent falling through", () => {
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "commands",
        "handlers",
        "workflow.ts",
      ),
      "utf-8",
    );

    // After the isAutoActive() check and notify, there should be a `return true`
    // before the handleQuick call
    const quickBlockMatch = src.match(
      /if\s*\(\s*trimmed\s*===\s*"quick"\s*\|\|\s*trimmed\.startsWith\("quick "\)\s*\)\s*\{([\s\S]*?)\n  \}/,
    );
    assert.ok(quickBlockMatch);
    const quickBlock = quickBlockMatch[1];

    // The guard block should have its own return true before handleQuick
    const guardBlock = quickBlock.slice(0, quickBlock.indexOf("handleQuick("));
    assert.ok(
      guardBlock.includes("return true"),
      "guard block returns true before handleQuick is reached",
    );
  });
});
