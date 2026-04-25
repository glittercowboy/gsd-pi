/**
 * Tests that /gsd queue is blocked when auto-mode is active.
 *
 * Relates to #4704: /gsd queue writes .gsd/PROJECT.md + QUEUE-ORDER.json
 * directly into the project-root worktree, racing with auto-mode's
 * pre-merge dirty-tree check and causing __dirty_working_tree__ failures.
 *
 * The fix adds an isAutoActive() guard in handleWorkflowCommand before
 * delegating to showQueue, mirroring the existing /gsd quick guard (#2417).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Structural test: verify the guard exists in source ──────────────────────

describe("/gsd queue auto-mode guard (#4704)", () => {
  it("handleWorkflowCommand checks isAutoActive() before calling showQueue", () => {
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

    // Find the queue command block
    const queueBlockMatch = src.match(
      /if\s*\(\s*trimmed\s*===\s*"queue"\s*\)\s*\{([\s\S]*?)\n  \}/,
    );
    assert.ok(queueBlockMatch, "queue command block exists in handleWorkflowCommand");

    const queueBlock = queueBlockMatch[1];

    // Verify auto-mode guard comes BEFORE showQueue call. Accepts either the
    // inline isAutoActive() check (Tier 1) or the shared requireNotAutoActive()
    // helper (Tier 2 / #4712).
    const guardIndex = Math.max(
      queueBlock.indexOf("isAutoActive()"),
      queueBlock.indexOf("requireNotAutoActive("),
    );
    const showQueueIndex = queueBlock.indexOf("showQueue(");

    assert.ok(guardIndex !== -1, "auto-mode guard exists in queue command block");
    assert.ok(showQueueIndex !== -1, "showQueue() call exists in queue command block");
    assert.ok(
      guardIndex < showQueueIndex,
      "auto-mode guard appears before showQueue() call",
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

    const queueBlockMatch = src.match(
      /if\s*\(\s*trimmed\s*===\s*"queue"\s*\)\s*\{([\s\S]*?)\n  \}/,
    );
    assert.ok(queueBlockMatch);
    const queueBlock = queueBlockMatch[1];

    // The guard block should have its own return true before showQueue
    const guardBlock = queueBlock.slice(0, queueBlock.indexOf("showQueue("));
    assert.ok(
      guardBlock.includes("return true"),
      "guard block returns true before showQueue is reached",
    );
  });
});

// ─── .gsd/audit/ runtime classification regression ──────────────────────────

describe(".gsd/audit/ runtime classification (#4704)", () => {
  it("GSD_RUNTIME_PATTERNS in gitignore.ts includes .gsd/audit/", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "gitignore.ts"),
      "utf-8",
    );
    assert.ok(
      src.includes('".gsd/audit/"'),
      ".gsd/audit/ listed in GSD_RUNTIME_PATTERNS",
    );
  });

  it("RUNTIME_EXCLUSION_PATHS in git-service.ts includes .gsd/audit/", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "git-service.ts"),
      "utf-8",
    );
    assert.ok(
      src.includes('".gsd/audit/"'),
      ".gsd/audit/ listed in RUNTIME_EXCLUSION_PATHS",
    );
  });

  it("SKIP_PATHS in worktree-manager.ts includes .gsd/audit/", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "worktree-manager.ts"),
      "utf-8",
    );
    assert.ok(
      src.includes('".gsd/audit/"'),
      ".gsd/audit/ listed in SKIP_PATHS",
    );
  });
});

// ─── Windows gsd.db close+reopen around pre-merge stash ─────────────────────

describe("Windows pre-merge DB release (#4704)", () => {
  it("mergeMilestoneToMain closes gsd.db on win32 before git stash", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "auto-worktree.ts"),
      "utf-8",
    );

    // Locate the stash push line and ensure a win32-gated closeDatabase()
    // call precedes it in the same function scope.
    const stashIndex = src.indexOf('"stash", "push", "--include-untracked"');
    assert.ok(stashIndex !== -1, "pre-merge stash push exists");

    const beforeStash = src.slice(0, stashIndex);
    const win32Index = beforeStash.lastIndexOf('process.platform === "win32"');
    const closeIndex = beforeStash.lastIndexOf("closeDatabase()");

    assert.ok(win32Index !== -1, "win32 platform guard appears before stash");
    assert.ok(closeIndex !== -1, "closeDatabase() invoked before stash");
    assert.ok(
      win32Index < closeIndex && closeIndex < stashIndex,
      "platform guard wraps the closeDatabase() call before the stash",
    );
  });

  it("openDatabase is called after the stash to reopen the connection", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "auto-worktree.ts"),
      "utf-8",
    );
    const stashIndex = src.indexOf('"stash", "push", "--include-untracked"');
    const afterStash = src.slice(stashIndex);
    assert.ok(
      afterStash.includes("openDatabase("),
      "openDatabase() called after the pre-merge stash",
    );
  });
});
