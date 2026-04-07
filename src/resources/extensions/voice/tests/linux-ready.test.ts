/**
 * linux-ready.test.ts — Tests for Linux voice readiness logic (#2403).
 *
 * Covers:
 *   - diagnoseSounddeviceError branch ordering (ModuleNotFoundError must NOT
 *     match the portaudio branch, even though it contains "sounddevice")
 *   - ensureVoiceVenv auto-creation
 *   - linuxPython venv detection
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseSounddeviceError, ensureVoiceVenv } from "../linux-ready.ts";

describe("diagnoseSounddeviceError", () => {
  test("ModuleNotFoundError for sounddevice returns missing-module", () => {
    const stderr = "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nModuleNotFoundError: No module named 'sounddevice'";
    assert.deepStrictEqual(diagnoseSounddeviceError(stderr), "missing-module");
  });

  test("'No module named sounddevice' variant returns missing-module", () => {
    const stderr = "ImportError: No module named sounddevice";
    assert.deepStrictEqual(diagnoseSounddeviceError(stderr), "missing-module");
  });

  test("actual portaudio error returns missing-portaudio", () => {
    const stderr = "OSError: PortAudio library not found";
    assert.deepStrictEqual(diagnoseSounddeviceError(stderr), "missing-portaudio");
  });

  test("lowercase portaudio error returns missing-portaudio", () => {
    const stderr = "OSError: libportaudio.so.2: cannot open shared object file: No such file or directory";
    assert.deepStrictEqual(diagnoseSounddeviceError(stderr), "missing-portaudio");
  });

  test("unrelated error returns unknown", () => {
    assert.deepStrictEqual(diagnoseSounddeviceError("SyntaxError: invalid syntax"), "unknown");
  });

  test("empty stderr returns unknown", () => {
    assert.deepStrictEqual(diagnoseSounddeviceError(""), "unknown");
  });
});

describe("ensureVoiceVenv", () => {
  test("returns true when venv already exists", () => {
    const notifications: string[] = [];
    const result = ensureVoiceVenv({
      notify: (msg) => notifications.push(msg),
      exists: () => true,
      execFile: (() => Buffer.from("")) as any,
    });
    assert.ok(result);
    assert.deepStrictEqual(notifications.length, 0);
  });

  test("creates venv when missing", () => {
    const notifications: string[] = [];
    const commands: string[][] = [];
    let existsCalled = false;

    const result = ensureVoiceVenv({
      notify: (msg) => notifications.push(msg),
      exists: () => { existsCalled = true; return false; },
      execFile: ((cmd: string, args: string[]) => {
        commands.push([cmd, ...args]);
        return Buffer.from("");
      }) as any,
    });

    assert.ok(result);
    assert.ok(existsCalled);
    assert.deepStrictEqual(commands.length, 2);
    assert.ok(commands[0][0] === "python3");
    assert.ok(commands[0].includes("-m") && commands[0].includes("venv"));
    assert.ok(commands[1][0].endsWith("bin/pip"));
    assert.ok(commands[1].includes("sounddevice"));
    assert.ok(commands[1].includes("requests"));
    assert.ok(notifications[0].includes("one-time setup"));
  });

  test("returns false and notifies on failure", () => {
    const notifications: Array<{ msg: string; level: string }> = [];

    const result = ensureVoiceVenv({
      notify: (msg, level) => notifications.push({ msg, level }),
      exists: () => false,
      execFile: (() => { throw new Error("externally-managed-environment"); }) as any,
    });

    assert.ok(!result);
    const errorNotif = notifications.find(n => n.level === "error");
    assert.ok(errorNotif !== undefined);
    assert.ok(errorNotif!.msg.includes("python3 -m venv"));
  });
});
