import test from "node:test";
import assert from "node:assert/strict";

import { registerExitCommand } from "../exit-command.ts";

test("/exit requests graceful shutdown instead of process.exit", async () => {
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

  registerExitCommand(pi as any);

  const exit = commands.get("exit");
  assert.ok(exit, "registerExitCommand should register /exit");
  assert.equal(exit.description, "Exit GSD gracefully");

  let shutdownCalls = 0;
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit should not be called: ${code ?? "undefined"}`);
  }) as typeof process.exit;

  try {
    await exit.handler("", {
      async shutdown() {
        shutdownCalls += 1;
      },
    });
  } finally {
    process.exit = originalExit;
  }

  assert.equal(shutdownCalls, 1, "handler should request graceful shutdown exactly once");
});
