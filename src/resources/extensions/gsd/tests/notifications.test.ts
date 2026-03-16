import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDesktopNotificationCommand,
  shouldSendDesktopNotification,
} from "../notifications.js";
import type { NotificationPreferences } from "../types.js";

test("shouldSendDesktopNotification honors granular preferences", () => {
  const prefs: NotificationPreferences = {
    enabled: true,
    on_complete: false,
    on_error: true,
    on_budget: false,
    on_milestone: true,
    on_attention: false,
  };

  assert.equal(shouldSendDesktopNotification("complete", prefs), false);
  assert.equal(shouldSendDesktopNotification("error", prefs), true);
  assert.equal(shouldSendDesktopNotification("budget", prefs), false);
  assert.equal(shouldSendDesktopNotification("milestone", prefs), true);
  assert.equal(shouldSendDesktopNotification("attention", prefs), false);
});

test("shouldSendDesktopNotification disables all categories when notifications are disabled", () => {
  const prefs: NotificationPreferences = { enabled: false, on_error: true, on_milestone: true };

  assert.equal(shouldSendDesktopNotification("error", prefs), false);
  assert.equal(shouldSendDesktopNotification("milestone", prefs), false);
});

test("buildDesktopNotificationCommand uses argument arrays for macOS notifications", () => {
  const command = buildDesktopNotificationCommand(
    "darwin",
    `Bob's "Milestone"`,
    `Budget!\nPath: C:\\temp`,
    "error",
  );

  assert.ok(command);
  assert.equal(command.file, "osascript");
  assert.deepEqual(command.args.slice(0, 1), ["-e"]);
  assert.match(command.args[1], /Bob's \\"Milestone\\"/);
  assert.match(command.args[1], /Budget! Path: C:\\\\temp/);
  assert.doesNotMatch(command.args[1], /\n/);
});

test("buildDesktopNotificationCommand preserves literal shell characters on linux", () => {
  const command = buildDesktopNotificationCommand(
    "linux",
    `Bob's $PATH !`,
    "line 1\nline 2",
    "warning",
  );

  assert.ok(command);
  assert.deepEqual(command, {
    file: "notify-send",
    args: ["-u", "normal", `Bob's $PATH !`, "line 1 line 2"],
  });
});

test("buildDesktopNotificationCommand skips unsupported platforms", () => {
  assert.equal(buildDesktopNotificationCommand("win32", "Title", "Message"), null);
});
