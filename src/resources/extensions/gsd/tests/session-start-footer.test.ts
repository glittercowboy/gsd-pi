/**
 * session-start-footer.test.ts
 *
 * Verifies that register-hooks.ts suppresses the built-in footer by calling
 * ctx.ui.setFooter(hideFooter) in both session_start and session_switch when
 * isAutoActive() is true.
 *
 * Testing strategy:
 *   Two layers:
 *   1. Source-code regression guard: ensures the guard and setFooter call are
 *      structurally present in register-hooks.ts for both event handlers.
 *      (node:test does not support mock.module without --experimental-test-module-mocks,
 *       so structural analysis is the correct approach here.)
 *   2. Behavioral integration test: fires the live session_start handler with a
 *      fake ctx when isAutoActive() is false (its default at test time) and
 *      confirms setFooter is NOT called — verifying the guard is conditional.
 *
 * Relates to #4314.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { registerHooks } from "../bootstrap/register-hooks.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_SOURCE = readFileSync(
  join(__dirname, "..", "bootstrap", "register-hooks.ts"),
  "utf-8",
);

// ─── Source-code regression guards ──────────────────────────────────────────

test("register-hooks.ts imports hideFooter from auto-dashboard", () => {
  assert.ok(
    HOOKS_SOURCE.includes('import { hideFooter } from "../auto-dashboard.js"') ||
    HOOKS_SOURCE.includes("import { hideFooter } from '../auto-dashboard.js'"),
    "register-hooks.ts must import hideFooter from auto-dashboard.js",
  );
});

test("session_start handler calls ctx.ui.setFooter(hideFooter) when isAutoActive()", () => {
  // Locate the session_start handler body (up to the next pi.on call)
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
    sessionStartBody.includes("ctx.ui.setFooter(hideFooter)"),
    "session_start handler must call ctx.ui.setFooter(hideFooter)",
  );

  // Guard must wrap the setFooter call
  const guardIdx = sessionStartBody.indexOf("isAutoActive()");
  const setFooterIdx = sessionStartBody.indexOf("ctx.ui.setFooter(hideFooter)");
  assert.ok(
    guardIdx < setFooterIdx,
    "isAutoActive() guard must appear before ctx.ui.setFooter(hideFooter) in session_start",
  );
});

test("session_switch handler calls ctx.ui.setFooter(hideFooter) when isAutoActive()", () => {
  const sessionSwitchIdx = HOOKS_SOURCE.indexOf('"session_switch"');
  assert.ok(sessionSwitchIdx > -1, "session_switch handler must exist");

  const beforeAgentStartIdx = HOOKS_SOURCE.indexOf('"before_agent_start"');
  assert.ok(beforeAgentStartIdx > sessionSwitchIdx, "before_agent_start handler must follow session_switch");

  const sessionSwitchBody = HOOKS_SOURCE.slice(sessionSwitchIdx, beforeAgentStartIdx);

  assert.ok(
    sessionSwitchBody.includes("isAutoActive()"),
    "session_switch handler must call isAutoActive()",
  );
  assert.ok(
    sessionSwitchBody.includes("ctx.ui.setFooter(hideFooter)"),
    "session_switch handler must call ctx.ui.setFooter(hideFooter)",
  );

  const guardIdx = sessionSwitchBody.indexOf("isAutoActive()");
  const setFooterIdx = sessionSwitchBody.indexOf("ctx.ui.setFooter(hideFooter)");
  assert.ok(
    guardIdx < setFooterIdx,
    "isAutoActive() guard must appear before ctx.ui.setFooter(hideFooter) in session_switch",
  );
});

// ─── Behavioral test: setFooter NOT called when auto-mode is inactive ────────

test("session_start does NOT call setFooter when isAutoActive() is false (default)", async (t) => {
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
      setWidget: () => {},
    },
    sessionManager: { getSessionId: () => null },
    model: null,
  } as any);

  // isAutoActive() is false at test time (no auto session started),
  // so setFooter must not be called.
  assert.equal(
    setFooterCallCount,
    0,
    "setFooter must NOT be called when isAutoActive() returns false",
  );
});
