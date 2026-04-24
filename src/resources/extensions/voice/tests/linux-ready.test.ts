/**
 * linux-ready.test.ts — Tests for Linux voice readiness logic (#2403).
 *
 * Covers:
 *   - diagnoseSounddeviceError branch ordering (ModuleNotFoundError must NOT
 *     match the portaudio branch, even though it contains "sounddevice")
 *   - ensureVoiceVenv auto-creation
 *
 * Previous version used `createTestContext()` + a top-level `main()` call —
 * those don't register with `node --test`, so the file ran at import time
 * but the test runner saw zero tests. CI reporter showed no output for
 * this file. Rewrite uses `node:test` so results are collected properly.
 * See #4809 / #4784.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { diagnoseSounddeviceError, ensureVoiceVenv } from "../linux-ready.ts";

describe("diagnoseSounddeviceError (#2403 branch ordering)", () => {
  test("ModuleNotFoundError with 'sounddevice' in message → missing-module", () => {
    // The critical regression: the stderr string contains "sounddevice",
    // so a naive branch-order check would match the portaudio branch
    // first. Correct classification is missing-module.
    const stderr =
      "Traceback (most recent call last):\n" +
      '  File "<string>", line 1, in <module>\n' +
      "ModuleNotFoundError: No module named 'sounddevice'";
    assert.equal(diagnoseSounddeviceError(stderr), "missing-module");
  });

  test("ImportError: No module named sounddevice → missing-module", () => {
    assert.equal(
      diagnoseSounddeviceError("ImportError: No module named sounddevice"),
      "missing-module",
    );
  });

  test("PortAudio library not found → missing-portaudio", () => {
    assert.equal(
      diagnoseSounddeviceError("OSError: PortAudio library not found"),
      "missing-portaudio",
    );
  });

  test("libportaudio.so.2 cannot open → missing-portaudio (lowercase variant)", () => {
    assert.equal(
      diagnoseSounddeviceError(
        "OSError: libportaudio.so.2: cannot open shared object file: No such file or directory",
      ),
      "missing-portaudio",
    );
  });

  test("unrelated SyntaxError → unknown", () => {
    assert.equal(
      diagnoseSounddeviceError("SyntaxError: invalid syntax"),
      "unknown",
    );
  });

  test("empty stderr → unknown", () => {
    assert.equal(diagnoseSounddeviceError(""), "unknown");
  });
});

describe("ensureVoiceVenv", () => {
  test("returns true without notifying when venv already exists", () => {
    const notifications: string[] = [];
    const result = ensureVoiceVenv({
      notify: (msg) => notifications.push(msg),
      exists: () => true,
      execFile: (() => Buffer.from("")) as never,
    });
    assert.equal(result, true);
    assert.equal(
      notifications.length,
      0,
      "should not notify when venv already exists",
    );
  });

  test("creates venv and installs sounddevice+requests when venv missing", () => {
    const notifications: string[] = [];
    const commands: string[][] = [];
    let existsCalled = false;

    const result = ensureVoiceVenv({
      notify: (msg) => notifications.push(msg),
      exists: () => {
        existsCalled = true;
        return false;
      },
      execFile: ((cmd: string, args: string[]) => {
        commands.push([cmd, ...args]);
        return Buffer.from("");
      }) as never,
    });

    assert.equal(result, true);
    assert.ok(existsCalled, "should check if venv exists first");
    assert.equal(commands.length, 2, "should run 2 commands (venv + pip)");
    assert.equal(commands[0]![0], "python3", "first command is python3");
    assert.ok(
      commands[0]!.includes("-m") && commands[0]!.includes("venv"),
      "first command creates the venv",
    );
    assert.ok(
      commands[1]![0]!.endsWith("bin/pip"),
      "second command is pip from the new venv",
    );
    assert.ok(commands[1]!.includes("sounddevice"), "pip installs sounddevice");
    assert.ok(commands[1]!.includes("requests"), "pip installs requests");
    assert.ok(
      notifications[0]!.includes("one-time setup"),
      "notifies user this is one-time setup",
    );
  });

  test("returns false and emits an error notification when venv creation fails", () => {
    const notifications: Array<{ msg: string; level?: string }> = [];

    const result = ensureVoiceVenv({
      notify: (msg, level) => notifications.push({ msg, level }),
      exists: () => false,
      execFile: (() => {
        throw new Error("externally-managed-environment");
      }) as never,
    });

    assert.equal(result, false);
    const errorNotif = notifications.find((n) => n.level === "error");
    assert.ok(errorNotif, "must emit an error notification on failure");
    assert.ok(
      errorNotif!.msg.includes("python3 -m venv"),
      "error notification suggests manual venv creation",
    );
  });
});
