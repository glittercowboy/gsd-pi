// GSD-2 — Tests for google-search deprecation stub (STUB-01, STUB-02)
import test from "node:test";
import assert from "node:assert/strict";

// ─── Tests ────────────────────────────────────────────────────────────────────

test("google-search stub: default export is a function", async (_t) => {
  // STUB-01: stub has a default export function accepting ExtensionAPI
  const mod = await import("../../google-search/index.ts");
  const stubFn = mod.default;
  assert.equal(typeof stubFn, "function");
});

test("google-search stub: registers session_start handler", async (_t) => {
  // STUB-01: stub calls pi.on("session_start", ...)
  const mod = await import("../../google-search/index.ts");
  const stubFn = mod.default;

  let capturedEvent: string | undefined;
  let capturedHandler: unknown;

  const mockPi = {
    on(event: string, handler: unknown) {
      capturedEvent = event;
      capturedHandler = handler;
    },
    registerTool: () => {},
  };

  stubFn(mockPi as never);

  assert.equal(capturedEvent, "session_start");
  assert.equal(typeof capturedHandler, "function");
});

test("google-search stub: does NOT call registerTool", async (_t) => {
  // STUB-02: stub is a no-op for tools
  const mod = await import("../../google-search/index.ts");
  const stubFn = mod.default;

  let registerToolCalled = false;

  const mockPi = {
    on: (_event: string, _handler: unknown) => {},
    registerTool: () => { registerToolCalled = true; },
  };

  stubFn(mockPi as never);

  assert.equal(registerToolCalled, false);
});

test("google-search stub: session_start warning contains package name", async (_t) => {
  // STUB-01: warning includes @gsd-extensions/google-search
  const mod = await import("../../google-search/index.ts");
  const stubFn = mod.default;

  let capturedHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;

  const mockPi = {
    on(_event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      capturedHandler = handler;
    },
    registerTool: () => {},
  };

  stubFn(mockPi as never);

  assert.ok(capturedHandler, "session_start handler should have been registered");

  let capturedMessage: string | undefined;
  const mockCtx = {
    ui: {
      notify(message: string, _level: string) {
        capturedMessage = message;
      },
    },
  };

  await capturedHandler!({}, mockCtx);

  assert.ok(
    capturedMessage?.includes("@gsd-extensions/google-search"),
    `Expected message to include "@gsd-extensions/google-search", got: "${capturedMessage}"`,
  );
});

test("google-search stub: session_start warning contains install command", async (_t) => {
  // STUB-01: warning includes "gsd extensions install"
  const mod = await import("../../google-search/index.ts");
  const stubFn = mod.default;

  let capturedHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;

  const mockPi = {
    on(_event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      capturedHandler = handler;
    },
    registerTool: () => {},
  };

  stubFn(mockPi as never);

  assert.ok(capturedHandler, "session_start handler should have been registered");

  let capturedMessage: string | undefined;
  const mockCtx = {
    ui: {
      notify(message: string, _level: string) {
        capturedMessage = message;
      },
    },
  };

  await capturedHandler!({}, mockCtx);

  assert.ok(
    capturedMessage?.includes("gsd extensions install"),
    `Expected message to include "gsd extensions install", got: "${capturedMessage}"`,
  );
});
