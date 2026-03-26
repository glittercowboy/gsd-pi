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

test("buildDesktopNotificationCommand falls back to osascript on macOS when terminal-notifier is absent", () => {
  // When terminal-notifier is not on PATH, falls back to osascript.
  // This test runs in CI where terminal-notifier is typically not installed.
  // If terminal-notifier IS installed, we verify it returns that instead.
  const command = buildDesktopNotificationCommand(
    "darwin",
    `Bob's "Milestone"`,
    `Budget!\nPath: C:\\temp`,
    "error",
  );

  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    // terminal-notifier path — verify args structure
    assert.ok(command.args.includes("-title"));
    assert.ok(command.args.includes("-message"));
    assert.ok(command.args.includes("-sound"));
    assert.ok(command.args.includes("Basso")); // error level
  } else {
    // osascript fallback path
    assert.equal(command.file, "osascript");
    assert.deepEqual(command.args.slice(0, 1), ["-e"]);
    assert.match(command.args[1], /Bob's \\"Milestone\\"/);
    assert.match(command.args[1], /Budget! Path: C:\\\\temp/);
    assert.doesNotMatch(command.args[1], /\n/);
  }
});

test("buildDesktopNotificationCommand uses Glass sound for non-error on macOS", () => {
  const command = buildDesktopNotificationCommand("darwin", "Title", "Message", "info");
  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    assert.ok(command.args.includes("Glass"));
  } else {
    assert.match(command.args[1], /sound name "Glass"/);
  }
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
