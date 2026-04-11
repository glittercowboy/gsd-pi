import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerShortcuts } from "../bootstrap/register-shortcuts.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-register-shortcuts-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

test("dashboard shortcut resolves the project root instead of the current worktree path", async (t) => {
  const projectRoot = makeTempDir("project");
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(worktreeRoot);
  t.after(() => {
    process.chdir(originalCwd);
    cleanup(projectRoot);
  });

  let capturedHandler: ((ctx: any) => Promise<void>) | null = null;
  const shortcuts: Array<{ description: string; handler: (ctx: any) => Promise<void> }> = [];
  const pi = {
    registerShortcut: (_key: unknown, shortcut: { description: string; handler: (ctx: any) => Promise<void> }) => {
      shortcuts.push(shortcut);
      if (!capturedHandler) {
        capturedHandler = shortcut.handler;
      }
    },
  } as any;

  registerShortcuts(pi);
  assert.ok(capturedHandler, "dashboard shortcut is registered");
  const dashboardShortcut = shortcuts[0];
  assert.ok(dashboardShortcut, "dashboard shortcut is captured");

  let customCalls = 0;
  const notices: Array<{ message: string; type?: string }> = [];
  await dashboardShortcut.handler({
    hasUI: true,
    ui: {
      custom: async () => {
        customCalls++;
        return true;
      },
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
    },
  });

  assert.ok(customCalls > 0, "shortcut opens the dashboard overlay when project root is resolved");
  assert.equal(notices.length, 0, "shortcut does not fall back to the missing-.gsd warning");
  assert.equal(shortcuts.length, 3, "all GSD shortcuts are still registered");
});
