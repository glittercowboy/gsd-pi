import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
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
  const shortcuts: Array<{ key: string; description: string; handler: (ctx: any) => Promise<void> }> = [];
  const pi = {
    registerShortcut: (key: unknown, shortcut: { description: string; handler: (ctx: any) => Promise<void> }) => {
      shortcuts.push({ key: String(key), ...shortcut });
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
  assert.equal(shortcuts.length, 5, "all GSD shortcuts are still registered");
  const keys = shortcuts.map((shortcut) => shortcut.key);
  assert.ok(keys.includes("ctrl+alt+g"), "primary dashboard shortcut is registered");
  assert.ok(keys.includes("ctrl+shift+g"), "fallback dashboard shortcut is registered");
  assert.ok(keys.includes("ctrl+alt+n"), "primary notifications shortcut is registered");
  assert.ok(keys.includes("ctrl+shift+n"), "fallback notifications shortcut is registered");
  assert.ok(keys.includes("ctrl+alt+p"), "primary parallel shortcut is registered");
  // No Ctrl+Shift+P fallback — conflicts with cycleModelBackward (shift+ctrl+p)
  assert.ok(!keys.includes("ctrl+shift+p"), "parallel fallback must not be registered (conflicts with cycleModelBackward)");
});

test("parallel shortcut passes resolved project root into overlay", async (t) => {
  const base = makeTempDir("parallel-root");
  const worktreeRoot = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(join(base, ".gsd", "parallel"), { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(worktreeRoot);
  t.after(() => {
    process.chdir(originalCwd);
    cleanup(base);
  });

  const shortcuts: Array<{ key: string; description: string; handler: (ctx: any) => Promise<void> }> = [];
  registerShortcuts({
    registerShortcut: (key: unknown, shortcut: { description: string; handler: (ctx: any) => Promise<void> }) => {
      shortcuts.push({ key: String(key), ...shortcut });
    },
  } as any);

  const parallelShortcut = shortcuts.find((shortcut) => shortcut.key === "ctrl+alt+p");
  assert.ok(parallelShortcut, "parallel shortcut is registered");

  let capturedBasePath: string | undefined;
  await parallelShortcut!.handler({
    hasUI: true,
    ui: {
      custom: async (factory: any) => {
        const overlay = factory(
          { requestRender() {} },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          null,
          () => {},
        );
        capturedBasePath = (overlay as any).basePath;
        overlay.dispose?.();
        return true;
      },
      notify: () => {},
    },
  });

  assert.ok(capturedBasePath, "parallel shortcut should construct overlay with a basePath");
  assert.equal(
    realpathSync(capturedBasePath),
    realpathSync(base),
    "parallel overlay should use the resolved project root, not the worktree cwd",
  );
});
