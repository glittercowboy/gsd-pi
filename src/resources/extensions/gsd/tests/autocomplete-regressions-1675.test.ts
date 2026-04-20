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

test("/gsd description includes debug", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  assert.ok(gsd.description.includes("debug"), "description should include debug");
});

test("/gsd next completions include --debug", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("next ");
  const debug = completions.find((c: any) => c.value === "next --debug");
  assert.ok(debug, "next --debug should appear in completions");
});

test("/gsd debug completions include list|status|continue|--diagnose", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("debug ");
  const values = completions.map((c: any) => c.value);
  for (const expected of ["debug list", "debug status", "debug continue", "debug --diagnose"]) {
    assert.ok(values.includes(expected), `missing completion: ${expected}`);
  }
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

test("/gsd logs completions still include debug after adding /gsd debug", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("logs ");
  const values = completions.map((c: any) => c.value);
  assert.ok(values.includes("logs debug"), "logs debug completion should remain available");
});

test("/gsd help full includes /gsd debug command", async () => {
  const ctx = createMockCtx();

  await handleGSDCommand("help full", ctx as any, {} as any);

  const helpText = ctx.notifications.map((n) => n.message).join("\n");
  assert.match(helpText, /\/gsd debug\s+Create\/list\/continue persistent debug sessions/);
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

