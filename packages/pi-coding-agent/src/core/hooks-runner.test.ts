import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR_NAME } from "../config.js";
import { ExtensionRunner } from "./extensions/runner.js";
import { createHooksRunner, isProjectHooksTrusted } from "./hooks-runner.js";
import type { ExtensionRuntime } from "./extensions/types.js";
import type { Settings } from "./settings-manager.js";

function makeTempProject() {
  const base = mkdtempSync(join(tmpdir(), "hooks-runner-test-"));
  mkdirSync(join(base, CONFIG_DIR_NAME), { recursive: true });
  return base;
}

function trust(cwd: string) {
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "hooks.trusted"), "");
}

function stubRuntime(): ExtensionRuntime {
  return {
    flagValues: new Map(),
    pendingProviderRegistrations: [],
    registerProvider: () => {},
    unregisterProvider: () => {},
    emitBeforeModelSelect: async () => undefined,
    emitAdjustToolSet: async () => undefined,
    emitExtensionEvent: async () => undefined,
    sendMessage: () => {},
    sendUserMessage: () => {},
    retryLastTurn: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    refreshTools: () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  };
}

function makeRunner(cwd: string): ExtensionRunner {
  return new ExtensionRunner(
    [],
    stubRuntime(),
    cwd,
    {} as never,
    {} as never,
  );
}

describe("isProjectHooksTrusted", () => {
  let tmpCwd: string | undefined;
  afterEach(() => {
    if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true });
    tmpCwd = undefined;
  });

  it("returns false when the marker is missing", () => {
    tmpCwd = makeTempProject();
    assert.equal(isProjectHooksTrusted(tmpCwd), false);
  });

  it("returns true after the marker is written", () => {
    tmpCwd = makeTempProject();
    trust(tmpCwd);
    assert.equal(isProjectHooksTrusted(tmpCwd), true);
  });
});

describe("createHooksRunner — trust gate", () => {
  let tmpCwd: string | undefined;
  afterEach(() => {
    if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true });
    tmpCwd = undefined;
  });

  it("ignores project hooks when the trust marker is absent", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    const invocations: string[] = [];

    const hooks = createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: (): Settings => ({}),
      getProjectSettings: (): Settings => ({
        hooks: {
          SessionStart: [
            { command: `node -e "process.stdout.write('{}')"` },
          ],
        },
      }),
      cwd: tmpCwd,
      onInvocation: (i) => invocations.push(i.command),
    });

    await hooks.fireSessionStart();
    assert.deepEqual(invocations, []);
    hooks.dispose();
  });

  it("runs project hooks when the trust marker is present", async () => {
    tmpCwd = makeTempProject();
    trust(tmpCwd);
    const runner = makeRunner(tmpCwd);
    const invocations: string[] = [];

    const hooks = createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: (): Settings => ({}),
      getProjectSettings: (): Settings => ({
        hooks: {
          SessionStart: [{ command: `node -e "process.exit(0)"` }],
        },
      }),
      cwd: tmpCwd,
      onInvocation: (i) => invocations.push(i.command),
    });

    await hooks.fireSessionStart();
    assert.deepEqual(invocations, [`node -e "process.exit(0)"`]);
    hooks.dispose();
  });

  it("runs global hooks unconditionally", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);
    const invocations: string[] = [];

    const hooks = createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: (): Settings => ({
        hooks: { SessionStart: [{ command: `node -e "process.exit(0)"` }] },
      }),
      getProjectSettings: (): Settings => ({}),
      cwd: tmpCwd,
      onInvocation: (i) => invocations.push(i.command),
    });

    await hooks.fireSessionStart();
    assert.deepEqual(invocations, [`node -e "process.exit(0)"`]);
    hooks.dispose();
  });
});

describe("createHooksRunner — PreToolUse bridges to tool_call", () => {
  let tmpCwd: string | undefined;
  afterEach(() => {
    if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true });
    tmpCwd = undefined;
  });

  it("blocks a tool call when the PreToolUse hook returns { block: true }", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);

    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: (): Settings => ({
        hooks: {
          PreToolUse: [
            {
              command: `node -e "process.stdout.write(JSON.stringify({block:true,reason:'nope'}))"`,
            },
          ],
        },
      }),
      getProjectSettings: (): Settings => ({}),
      cwd: tmpCwd,
    });

    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "ls" },
    });
    assert.equal(result?.block, true);
    assert.equal(result?.reason, "nope");
  });

  it("applies filter.tool to scope the hook", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);

    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: (): Settings => ({
        hooks: {
          PreToolUse: [
            {
              match: { tool: "bash" },
              command: `node -e "process.stdout.write(JSON.stringify({block:true,reason:'bash-only'}))"`,
            },
          ],
        },
      }),
      getProjectSettings: (): Settings => ({}),
      cwd: tmpCwd,
    });

    const readResult = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t2",
      toolName: "read",
      input: { path: "/tmp/x" },
    });
    assert.equal(readResult?.block, undefined);

    const bashResult = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t3",
      toolName: "bash",
      input: { command: "rm -rf /" },
    });
    assert.equal(bashResult?.block, true);
  });

  it("treats a non-zero exit as a block when blocking is not disabled", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);

    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: (): Settings => ({
        hooks: { PreToolUse: [{ command: `node -e "process.exit(1)"` }] },
      }),
      getProjectSettings: (): Settings => ({}),
      cwd: tmpCwd,
    });

    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t4",
      toolName: "bash",
      input: { command: "ls" },
    });
    assert.equal(result?.block, true);
  });

  it("does not block when blocking: false and exit is non-zero", async () => {
    tmpCwd = makeTempProject();
    const runner = makeRunner(tmpCwd);

    createHooksRunner({
      extensionRunner: runner,
      getGlobalSettings: (): Settings => ({
        hooks: { PreToolUse: [{ command: `node -e "process.exit(1)"`, blocking: false }] },
      }),
      getProjectSettings: (): Settings => ({}),
      cwd: tmpCwd,
    });

    const result = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "t5",
      toolName: "bash",
      input: { command: "ls" },
    });
    assert.equal(result?.block, undefined);
  });
});
