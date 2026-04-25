/**
 * session-start-footer.test.ts
 *
 * Verifies that register-hooks.ts suppresses the gsd-health widget (not the
 * built-in footer) when isAutoActive() is true, and that setFooter is never
 * called by the extension in either session_start or session_switch.
 *
 * Testing strategy:
 *   1. Source-code regression guards: structural checks on register-hooks.ts.
 *   2. Behavioral integration test: fires the live session_start handler with a
 *      fake ctx when isAutoActive() is false (default) and confirms neither
 *      setFooter nor setWidget("gsd-health") is called.
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

test("session_switch handler suppresses gsd-health when isAutoActive()", () => {
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
    sessionSwitchBody.includes('setWidget("gsd-health", undefined)'),
    "session_switch handler must call setWidget(\"gsd-health\", undefined) when auto is active",
  );
  assert.ok(
    !sessionSwitchBody.includes("setFooter"),
    "session_switch handler must NOT call setFooter",
  );
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
