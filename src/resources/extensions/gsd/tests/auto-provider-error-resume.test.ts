import test from "node:test";
import assert from "node:assert/strict";

import { resumeAutoAfterDelay } from "../auto.ts";

function makeMockPi() {
  return {
    sendMessage: () => {
      throw new Error("resumeAutoAfterDelay must not use plain sendMessage recovery");
    },
  } as any;
}

test("resumeAutoAfterDelay resumes paused auto-mode through startAuto and preserves step mode", async () => {
  const pi = makeMockPi();
  const cmdCtx = {
    ui: { notify: () => {} },
  } as any;

  const calls: Array<{
    ctx: unknown;
    base: string;
    verbose: boolean;
    options: { step?: boolean } | undefined;
  }> = [];

  const resumed = await resumeAutoAfterDelay(pi, {
    isPaused: () => true,
    getCommandContext: () => cmdCtx,
    getBasePath: () => "/tmp/project",
    getVerbose: () => true,
    getStepMode: () => true,
    startAutoFn: async (ctx, _pi, base, verbose, options) => {
      calls.push({ ctx, base, verbose, options });
    },
  });

  assert.equal(resumed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    ctx: cmdCtx,
    base: "/tmp/project",
    verbose: true,
    options: { step: true },
  });
});

test("resumeAutoAfterDelay returns false when auto-mode is not paused", async () => {
  const pi = makeMockPi();
  let startCalled = false;

  const resumed = await resumeAutoAfterDelay(pi, {
    isPaused: () => false,
    startAutoFn: async () => {
      startCalled = true;
    },
  });

  assert.equal(resumed, false);
  assert.equal(startCalled, false);
});

test("resumeAutoAfterDelay returns false when paused state lacks command context", async () => {
  const pi = makeMockPi();
  let startCalled = false;

  const resumed = await resumeAutoAfterDelay(pi, {
    isPaused: () => true,
    getCommandContext: () => null,
    getBasePath: () => "/tmp/project",
    startAutoFn: async () => {
      startCalled = true;
    },
  });

  assert.equal(resumed, false);
  assert.equal(startCalled, false);
});

test("agent-end-recovery uses resumeAutoAfterDelay for delayed provider-error recovery", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(__dirname, "..", "bootstrap", "agent-end-recovery.ts"), "utf-8");

  assert.ok(
    source.includes("resumeAutoAfterDelay(pi)"),
    "provider-error auto-resume must go through resumeAutoAfterDelay(pi)",
  );
  assert.ok(
    !source.includes('customType: "gsd-auto-timeout-recovery", content: "Continue execution — provider error recovery delay elapsed."'),
    "delayed provider-error recovery must not rely on a plain triggerTurn custom message",
  );
});
