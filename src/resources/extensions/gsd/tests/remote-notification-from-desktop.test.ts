/**
 * remote-notification-from-desktop.test.ts
 *
 * Regression guard: sendDesktopNotification must fire sendRemoteNotification
 * as a fire-and-forget side-effect so that Telegram/Slack/Discord channels
 * receive the same events as native desktop notifications.
 *
 * Testing strategy (structural analysis):
 *   node:test does not support mock.module without --experimental-test-module-mocks,
 *   so we use the same source-code structural approach established in this codebase
 *   (see session-start-footer.test.ts). We read notifications.ts and assert that:
 *     1. It imports sendRemoteNotification from the remote-questions/notify module.
 *     2. The sendDesktopNotification function body calls sendRemoteNotification
 *        with title and message as arguments.
 *     3. The call uses the void fire-and-forget pattern with a .catch(() => {})
 *        suppressor so that async failures never break the synchronous caller.
 *
 * Relates to #4341.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(__dirname, "..", "notifications.ts"), "utf-8");

test("notifications.ts imports sendRemoteNotification from remote-questions/notify", () => {
  const hasImport =
    SOURCE.includes('from "../remote-questions/notify.js"') ||
    SOURCE.includes("from '../remote-questions/notify.js'");
  assert.ok(
    hasImport,
    "notifications.ts must import from '../remote-questions/notify.js'",
  );

  const importLine = SOURCE.split("\n").find(
    (line) =>
      line.includes("sendRemoteNotification") &&
      (line.includes("remote-questions/notify") || line.includes("remote-questions/notify.js")),
  );
  assert.ok(
    importLine,
    "The import statement must include sendRemoteNotification from the remote-questions/notify module",
  );
});

test("sendDesktopNotification calls sendRemoteNotification(title, message)", () => {
  // Extract the body of sendDesktopNotification — from its opening brace to the
  // closing brace at the same indentation level.
  const fnStart = SOURCE.indexOf("export function sendDesktopNotification(");
  assert.ok(fnStart > -1, "sendDesktopNotification must be present in notifications.ts");

  // Find the next exported function/const after sendDesktopNotification to bound the search.
  const nextExportIdx = SOURCE.indexOf("\nexport ", fnStart + 1);
  const fnBody = nextExportIdx > -1 ? SOURCE.slice(fnStart, nextExportIdx) : SOURCE.slice(fnStart);

  assert.ok(
    fnBody.includes("sendRemoteNotification"),
    "sendDesktopNotification must call sendRemoteNotification",
  );

  assert.ok(
    fnBody.includes("sendRemoteNotification(title") || fnBody.includes("sendRemoteNotification(title,"),
    "sendRemoteNotification must be called with title as first argument",
  );
});

test("sendRemoteNotification is invoked as void fire-and-forget with .catch(() => {})", () => {
  const fnStart = SOURCE.indexOf("export function sendDesktopNotification(");
  const nextExportIdx = SOURCE.indexOf("\nexport ", fnStart + 1);
  const fnBody = nextExportIdx > -1 ? SOURCE.slice(fnStart, nextExportIdx) : SOURCE.slice(fnStart);

  assert.ok(
    fnBody.includes("void sendRemoteNotification("),
    "sendRemoteNotification must be called with void (fire-and-forget)",
  );

  assert.ok(
    fnBody.includes(".catch("),
    "sendRemoteNotification call must be followed by .catch() to suppress unhandled-rejection warnings",
  );
});

test("sendRemoteNotification call appears before shouldSendDesktopNotification guard", () => {
  // Regression guard for the HIGH-severity bug where remote notifications were
  // gated behind the desktop-notification preference check. Users who disable
  // desktop notifications must still receive Telegram/Slack/Discord messages.
  const fnStart = SOURCE.indexOf("export function sendDesktopNotification(");
  assert.ok(fnStart > -1, "sendDesktopNotification must be present in notifications.ts");

  const nextExportIdx = SOURCE.indexOf("\nexport ", fnStart + 1);
  const fnBody = nextExportIdx > -1 ? SOURCE.slice(fnStart, nextExportIdx) : SOURCE.slice(fnStart);

  const remoteCallIdx = fnBody.indexOf("sendRemoteNotification(");
  const guardIdx = fnBody.indexOf("shouldSendDesktopNotification(");

  assert.ok(remoteCallIdx > -1, "sendRemoteNotification must be called inside sendDesktopNotification");
  assert.ok(guardIdx > -1, "shouldSendDesktopNotification guard must be present inside sendDesktopNotification");

  assert.ok(
    remoteCallIdx < guardIdx,
    `sendRemoteNotification (pos ${remoteCallIdx}) must appear BEFORE the shouldSendDesktopNotification guard (pos ${guardIdx}) so that remote channels fire even when desktop notifications are disabled`,
  );
});
