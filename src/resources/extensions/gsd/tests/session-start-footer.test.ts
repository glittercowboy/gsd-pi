/**
 * session-start-footer.test.ts
 *
 * Verifies that register-hooks.ts suppresses the gsd-health widget (not the
 * built-in footer) when isAutoActive() is true, and that setFooter is never
 * called by the extension in either session_start or session_switch.
 *
 * Testing strategy:
 *   1. Source-code regression guards: structural checks on register-hooks.ts.
 *   2. Behavioral integration tests: fire the live session handlers with fake
 *      contexts and confirm footer/widget behavior from runtime effects.
 *
 * Relates to #4314.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { autoSession } from "../auto-runtime-state.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_SOURCE = readFileSync(
  join(__dirname, "..", "bootstrap", "register-hooks.ts"),
  "utf-8",
);

// ─── Source-code regression guards ──────────────────────────────────────────

test("register-hooks.ts does NOT import hideFooter", () => {
  assert.ok(
    !HOOKS_SOURCE.includes("hideFooter"),
    "register-hooks.ts must not reference hideFooter — footer is no longer swapped in auto mode",
  );
});

test("session_start handler guards initHealthWidget with !isAutoActive()", () => {
  const sessionStartIdx = HOOKS_SOURCE.indexOf('"session_start"');
  assert.ok(sessionStartIdx > -1, "session_start handler must exist");

  const sessionSwitchIdx = HOOKS_SOURCE.indexOf('"session_switch"');
  assert.ok(sessionSwitchIdx > sessionStartIdx, "session_switch handler must follow session_start");

  const sessionStartBody = HOOKS_SOURCE.slice(sessionStartIdx, sessionSwitchIdx);

  assert.ok(
    sessionStartBody.includes("isAutoActive()"),
    "session_start handler must call isAutoActive()",
  );
  assert.ok(
    sessionStartBody.includes("initHealthWidget"),
    "session_start handler must reference initHealthWidget",
  );
  assert.ok(
    !sessionStartBody.includes("setFooter"),
    "session_start handler must NOT call setFooter",
  );

  const guardIdx = sessionStartBody.indexOf("isAutoActive()");
  const healthIdx = sessionStartBody.indexOf("initHealthWidget");
  assert.ok(
    guardIdx < healthIdx,
    "isAutoActive() guard must appear before initHealthWidget in session_start",
  );
});

test("session_switch toggles gsd-health from runtime auto state without touching the footer", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-session-switch-widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const tempGsdHome = join(dir, "home");
  mkdirSync(tempGsdHome, { recursive: true });

  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(dir);
  autoSession.reset();
  t.after(() => {
    autoSession.reset();
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as any;

  registerHooks(pi, []);

  const sessionSwitch = handlers.get("session_switch");
  assert.ok(sessionSwitch, "session_switch handler must be registered");

  let setFooterCallCount = 0;
  const widgetCalls: Array<{ key: string; value: unknown }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setFooter: (_footer: unknown) => {
        setFooterCallCount++;
      },
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: (key: string, value: unknown) => {
        widgetCalls.push({ key, value });
      },
    },
    sessionManager: { getSessionId: () => null },
    model: null,
    modelRegistry: {
      setDisabledModelProviders: () => {},
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => false,
    },
  };

  autoSession.active = true;
  await sessionSwitch!({ reason: "resume" }, ctx);
  assert.deepEqual(
    widgetCalls.filter((call) => call.key === "gsd-health").map((call) => call.value),
    [undefined],
    "session_switch should hide gsd-health when auto is active",
  );
  assert.equal(setFooterCallCount, 0, "session_switch must not call setFooter when auto is active");

  widgetCalls.length = 0;
  autoSession.active = false;
  await sessionSwitch!({ reason: "resume" }, ctx);
  const healthWidgetValues = widgetCalls
    .filter((call) => call.key === "gsd-health")
    .map((call) => call.value);

  assert.ok(healthWidgetValues.length >= 2, "session_switch should initialize gsd-health when auto is inactive");
  assert.ok(
    healthWidgetValues.every((value) => value !== undefined),
    "session_switch must not hide gsd-health when auto is inactive",
  );
  assert.ok(Array.isArray(healthWidgetValues[0]), "initHealthWidget should publish initial health lines");
  assert.equal(typeof healthWidgetValues.at(-1), "function", "initHealthWidget should register the live widget factory");
  assert.equal(setFooterCallCount, 0, "session_switch must not call setFooter when auto is inactive");
});

// ─── Behavioral test: neither setFooter nor health suppression when auto inactive ─

test("session_start does NOT call setFooter or suppress gsd-health when isAutoActive() is false", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-footer-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  let setFooterCallCount = 0;
  let healthWidgetHideCount = 0;

  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as any;

  registerHooks(pi, []);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "session_start handler must be registered");

  await sessionStart!({}, {
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setFooter: (_footer: unknown) => {
        setFooterCallCount++;
      },
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: (key: string, value: unknown) => {
        if (key === "gsd-health" && value === undefined) healthWidgetHideCount++;
      },
    },
    sessionManager: { getSessionId: () => null },
    model: null,
  } as any);

  assert.equal(setFooterCallCount, 0, "setFooter must NOT be called when isAutoActive() is false");
  assert.equal(healthWidgetHideCount, 0, "gsd-health must NOT be hidden when isAutoActive() is false");
});

test("session_start and session_switch apply disabled model provider policy from current preferences", async (t) => {
  const dir = join(
    tmpdir(),
    `gsd-disabled-provider-policy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  const tempGsdHome = join(dir, "home");
  mkdirSync(tempGsdHome, { recursive: true });

  const originalCwd = process.cwd();
  const originalGsdHome = process.env.GSD_HOME;
  process.env.GSD_HOME = tempGsdHome;
  process.chdir(dir);
  t.after(() => {
    process.chdir(originalCwd);
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const writePrefs = (providers: string[]) => {
    writeFileSync(
      join(dir, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "version: 1",
        "disabled_model_providers:",
        ...providers.map((provider) => `  - ${provider}`),
        "---",
        "",
      ].join("\n"),
      "utf-8",
    );
  };

  const appliedPolicies: string[][] = [];
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as any;
  const ctx = {
    hasUI: true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setFooter: () => {},
      setWorkingMessage: () => {},
      onTerminalInput: () => () => {},
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => null },
    model: null,
    modelRegistry: {
      setDisabledModelProviders: (providers: string[]) => {
        appliedPolicies.push([...providers]);
      },
      getProviderAuthMode: () => undefined,
      isProviderRequestReady: () => false,
    },
  };

  registerHooks(pi, []);

  const sessionStart = handlers.get("session_start");
  const sessionSwitch = handlers.get("session_switch");
  assert.ok(sessionStart, "session_start handler must be registered");
  assert.ok(sessionSwitch, "session_switch handler must be registered");

  writePrefs(["google-gemini-cli", " google-gemini-cli ", "openai-codex"]);
  await sessionStart!({}, ctx);
  assert.deepEqual(
    appliedPolicies.at(-1),
    ["google-gemini-cli", "openai-codex"],
    "session_start should apply normalized disabled providers before the first agent turn",
  );

  writePrefs(["anthropic"]);
  await sessionSwitch!({ reason: "resume" }, ctx);
  assert.deepEqual(
    appliedPolicies.at(-1),
    ["anthropic"],
    "session_switch should re-read preferences for the switched project/session context",
  );
});
