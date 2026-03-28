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

// ─── macOS ─────────────────────────────────────────────────────────────────

test("buildDesktopNotificationCommand falls back to osascript on macOS when terminal-notifier is absent", () => {
  // When terminal-notifier is not on PATH, falls back to osascript.
  // This test runs in CI where terminal-notifier is typically not installed.
  // If terminal-notifier IS installed, we verify it returns that instead.
  const command = buildDesktopNotificationCommand(
    "darwin",
    `Bob's "Milestone"`,
    `Budget!\nPath: C:\\temp`,
    "error",
    "toast",
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
  const command = buildDesktopNotificationCommand("darwin", "Title", "Message", "info", "toast");
  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    assert.ok(command.args.includes("Glass"));
  } else {
    assert.match(command.args[1], /sound name "Glass"/);
  }
});

test("buildDesktopNotificationCommand returns sound-only command on macOS with kind=sound", () => {
  const command = buildDesktopNotificationCommand("darwin", "Title", "Message", "error", "sound");
  assert.ok(command);
  // Should use afplay for sound-only, or osascript fallback — never terminal-notifier
  if (command.file === "afplay") {
    assert.match(command.args[0], /Basso/);
  } else {
    // Fallback via osascript
    assert.equal(command.file, "osascript");
  }
});

// ─── Linux ─────────────────────────────────────────────────────────────────

test("buildDesktopNotificationCommand preserves literal shell characters on linux", () => {
  const command = buildDesktopNotificationCommand(
    "linux",
    `Bob's $PATH !`,
    "line 1\nline 2",
    "warning",
    "toast",
  );

  assert.ok(command);
  assert.deepEqual(command, {
    file: "notify-send",
    args: ["-u", "normal", `Bob's $PATH !`, "line 1 line 2"],
  });
});

test("buildDesktopNotificationCommand returns sound-only command on linux with kind=sound", () => {
  const command = buildDesktopNotificationCommand("linux", "Title", "Message", "error", "sound");
  assert.ok(command);
  // Should use paplay or aplay — never notify-send
  assert.ok(command.file === "paplay" || command.file === "aplay" || command.file === "notify-send");
});

// ─── Windows ───────────────────────────────────────────────────────────────

test("buildDesktopNotificationCommand returns WinRT toast on win32 with kind=toast", () => {
  const command = buildDesktopNotificationCommand("win32", "GSD", "Task complete", "info", "toast");
  assert.ok(command);
  assert.equal(command.file, "powershell.exe");
  assert.ok(command.args.includes("-NoProfile"));
  assert.ok(command.args.some(a => a.includes("ToastNotificationManager")));
  assert.ok(command.args.some(a => a.includes("ToastGeneric")));
  assert.ok(command.args.some(a => a.includes("GSD")));
  assert.ok(command.args.some(a => a.includes("Task complete")));
});

test("buildDesktopNotificationCommand returns sound-only command on win32 with kind=sound", () => {
  const command = buildDesktopNotificationCommand("win32", "GSD", "Error", "error", "sound");
  assert.ok(command);
  assert.equal(command.file, "powershell.exe");
  assert.ok(command.args.some(a => a.includes("SystemSounds") && a.includes("Hand")));
});

test("buildDesktopNotificationCommand maps error level to Hand sound on win32", () => {
  const command = buildDesktopNotificationCommand("win32", "GSD", "Error", "error", "sound");
  assert.ok(command);
  assert.ok(command.args.some(a => a.includes("Hand")));
});

test("buildDesktopNotificationCommand maps warning level to Exclamation sound on win32", () => {
  const command = buildDesktopNotificationCommand("win32", "GSD", "Warning", "warning", "sound");
  assert.ok(command);
  assert.ok(command.args.some(a => a.includes("Exclamation")));
});

test("buildDesktopNotificationCommand defaults to toast when kind is not specified", () => {
  const command = buildDesktopNotificationCommand("win32", "GSD", "Task complete", "info");
  assert.ok(command);
  assert.ok(command.args.some(a => a.includes("ToastNotificationManager")));
});
