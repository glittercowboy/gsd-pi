import test from "node:test";
import assert from "node:assert/strict";

import { registerGSDCommand } from "../commands.ts";

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

test("/gsd update appears in subcommand completions", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  assert.ok(gsd, "registerGSDCommand should register /gsd");

  const completions = gsd.getArgumentCompletions("update");
  const updateEntry = completions.find((c: any) => c.value === "update");
  assert.ok(updateEntry, "update should appear in completions");
  assert.equal(updateEntry.label, "update");
});

test("/gsd update appears in help description", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  assert.ok(gsd?.description?.includes("update"), "description should mention update");
});

test("/gsd update is listed in completions with correct description", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("");
  const updateEntry = completions.find((c: any) => c.value === "update");
  assert.ok(updateEntry, "update should appear in full completion list");
  assert.ok(
    updateEntry.description.toLowerCase().includes("update"),
    "completion description should mention updating",
  );
});

test("/gsd codebase appears in top-level completions", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  const completions = gsd.getArgumentCompletions("code");
  const codebaseEntry = completions.find((c: any) => c.value === "codebase");
  assert.ok(codebaseEntry, "codebase should appear in completions");
  assert.match(codebaseEntry.description, /codebase map cache/i);
});

test("/gsd codebase appears in help description", () => {
  const pi = createMockPi();
  registerGSDCommand(pi as any);

  const gsd = pi.commands.get("gsd");
  assert.ok(gsd?.description?.includes("codebase"), "description should mention codebase");
});
