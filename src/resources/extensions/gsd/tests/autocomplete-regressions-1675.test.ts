import test from "node:test";
import assert from "node:assert/strict";

import { registerGSDCommand } from "../commands.ts";
import { handleGSDCommand } from "../commands/dispatcher.ts";

function createMockPi() {
  const commands = new Map<string, any>();
  return {
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerTool() {},
    registerShortcut() {},
    on() {},
    sendMessage() {},
    commands,
  };
}

function createMockCtx() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
    shutdown: async () => {},
  };
}

test("/gsd description includes discuss", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  assert.ok(gsd, "registerGSDCommand should register /gsd");
  assert.ok(
    gsd.description.includes("discuss"),
    "description should include discuss",
  );
});

test("/gsd next completions include --debug", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("next ");
  const debug = completions.find((c: any) => c.value === "next --debug");
  assert.ok(debug, "next --debug should appear in completions");
});

test("/gsd widget completions include full|small|min|off", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("widget ");
  const values = completions.map((c: any) => c.value);
  for (const expected of ["widget full", "widget small", "widget min", "widget off"]) {
    assert.ok(values.includes(expected), `missing completion: ${expected}`);
  }
});

test("bare /gsd skip shows usage and does not fall through to unknown-command warning", async () => {
  const ctx = createMockCtx();

  await handleGSDCommand("skip", ctx as any, {} as any);

  assert.ok(
    ctx.notifications.some((n) => n.message.includes("Usage: /gsd skip <unit-id>")),
    "should show skip usage guidance",
  );
  assert.ok(
    !ctx.notifications.some((n) => n.message.startsWith("Unknown: /gsd skip")),
    "should not emit unknown-command warning for bare skip",
  );
});

