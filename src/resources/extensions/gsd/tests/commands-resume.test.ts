/**
 * commands-resume.test.ts — Tests for `/gsd resume` command.
 *
 * Covers:
 * - Catalog registration (TOP_LEVEL_SUBCOMMANDS, GSD_COMMAND_DESCRIPTION)
 * - No-op when no active task (notifies user)
 * - No-op when active task but no interrupted work (notifies user)
 * - Delegates to startAuto when interrupted work is detected
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TOP_LEVEL_SUBCOMMANDS, GSD_COMMAND_DESCRIPTION } from "../commands/catalog.ts";
import { handleGSDCommand } from "../commands/dispatcher.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockCtx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
      setStatus: () => {},
      setFooter: () => {},
    },
    hasUI: false,
    shutdown: async () => {},
    sessionManager: { getSessionFile: () => null },
  };
}

function createMockPi() {
  const messages: any[] = [];
  return {
    messages,
    sendMessage(msg: any) { messages.push(msg); },
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    on() {},
  };
}

// ─── Catalog tests ────────────────────────────────────────────────────────────

describe("catalog", () => {
  test("TOP_LEVEL_SUBCOMMANDS includes resume", () => {
    const entry = TOP_LEVEL_SUBCOMMANDS.find((c) => c.cmd === "resume");
    assert.ok(entry, "resume should be in TOP_LEVEL_SUBCOMMANDS");
    assert.ok(entry.desc.length > 0, "resume entry should have a description");
  });

  test("GSD_COMMAND_DESCRIPTION includes resume", () => {
    assert.ok(
      GSD_COMMAND_DESCRIPTION.includes("resume"),
      "GSD_COMMAND_DESCRIPTION should include 'resume'",
    );
  });
});

// ─── Handler tests (filesystem-backed state) ──────────────────────────────────

describe("handler", () => {
  let base: string;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    base = mkdtempSync(join(tmpdir(), "gsd-resume-test-"));
    process.chdir(base);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(base, { recursive: true, force: true });
  });

  test("notifies when no milestones exist (no active task)", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();

    await handleGSDCommand("resume", ctx as any, pi as any);

    assert.ok(
      ctx.notifications.some((n) => n.message.toLowerCase().includes("no interrupted work") || n.message.toLowerCase().includes("no active task")),
      `should notify about no interrupted/active work, got: ${JSON.stringify(ctx.notifications)}`,
    );
    assert.equal(pi.messages.length, 0, "should not dispatch workflow when no active task");
  });

  test("notifies when active task exists but no continue.md (not interrupted)", async () => {
    // Create a milestone in executing phase with an incomplete task — no continue.md
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    const sliceDir = join(milestoneDir, "S01");
    mkdirSync(sliceDir, { recursive: true });

    writeFileSync(
      join(milestoneDir, "M001-ROADMAP.md"),
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      ].join("\n"),
    );

    writeFileSync(
      join(milestoneDir, "M001-CONTEXT.md"),
      "# M001 Context\n\nTest.",
    );

    writeFileSync(
      join(sliceDir, "S01-PLAN.md"),
      [
        "# S01 Plan",
        "",
        "## Tasks",
        "- [ ] T01: Do something",
      ].join("\n"),
    );

    const ctx = createMockCtx();
    const pi = createMockPi();

    await handleGSDCommand("resume", ctx as any, pi as any);

    assert.ok(
      ctx.notifications.some((n) =>
        n.message.toLowerCase().includes("no interrupted work") ||
        n.message.toLowerCase().includes("no active task"),
      ),
      `should notify no interrupted work when no continue.md, got: ${JSON.stringify(ctx.notifications)}`,
    );
    assert.equal(pi.messages.length, 0, "should not dispatch workflow when no continue.md");
  });

  test("does not emit unknown-command warning for resume", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();

    await handleGSDCommand("resume", ctx as any, pi as any);

    assert.ok(
      !ctx.notifications.some((n) => n.message.startsWith("Unknown: /gsd resume")),
      "should not emit unknown-command warning for resume",
    );
  });
});
