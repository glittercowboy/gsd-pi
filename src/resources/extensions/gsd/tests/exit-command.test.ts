import test from "node:test";
import assert from "node:assert/strict";

import { registerExitCommand } from "../exit-command.ts";

test("/exit requests graceful shutdown instead of process.exit", async (t) => {
  const commands = new Map<
    string,
    {
      description?: string;
      handler: (args: string, ctx: { shutdown: () => Promise<void> }) => Promise<void>;
    }
  >();

  const pi = {
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  };

  let stopAutoCalls = 0;
  registerExitCommand(pi as any, {
    async stopAuto() {
      stopAutoCalls += 1;
    },
  });

  const exit = commands.get("exit");
  assert.ok(exit, "registerExitCommand should register /exit");
  assert.equal(exit.description, "Exit GSD gracefully");

  let shutdownCalls = 0;
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit should not be called: ${code ?? "undefined"}`);
  }) as typeof process.exit;

  t.after(() => { process.exit = originalExit; });

  await exit.handler("", {
    async shutdown() {
      shutdownCalls += 1;
    },
  });

  assert.equal(stopAutoCalls, 1, "handler should stop auto-mode exactly once before shutdown");
  assert.equal(shutdownCalls, 1, "handler should request graceful shutdown exactly once");
});

// ─── #1839 regression: ESM cache mismatch must not crash exit ────────────────

test("/exit still shuts down gracefully when stopAuto throws (ESM module cache mismatch)", async (t) => {
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();

  const pi = {
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
  };

  // Simulate the ESM cache mismatch: stopAuto throws because a static import
  // in the dependency chain references an export absent from the cached module.
  registerExitCommand(pi as any, {
    async stopAuto() {
      throw new Error(
        "The requested module './native-git-bridge.js' does not provide an export named 'nativeAddAllWithExclusions'",
      );
    },
  });

  const exit = commands.get("exit")!;

  let shutdownCalls = 0;
  const notifications: Array<{ msg: string; level: string }> = [];

  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit should not be called: ${code ?? "undefined"}`);
  }) as typeof process.exit;

  t.after(() => { process.exit = originalExit; });

  await exit.handler("", {
    async shutdown() {
      shutdownCalls += 1;
    },
    ui: {
      notify(msg: string, level: string) {
        notifications.push({ msg, level });
      },
    },
  });

  assert.equal(shutdownCalls, 1, "shutdown must still be called even when stopAuto throws");
  assert.equal(notifications.length, 1, "should emit exactly one warning notification");
  assert.equal(notifications[0].level, "warning", "notification level should be warning");
  assert.ok(
    notifications[0].msg.includes("module version mismatch"),
    "notification should mention module version mismatch",
  );
});
