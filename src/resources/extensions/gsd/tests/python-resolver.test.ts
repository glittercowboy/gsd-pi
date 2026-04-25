import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Regression tests for #4416: python invocation normalization for Windows.
// These tests import from python-resolver.ts which is created as part of the fix.
import { normalizePythonCommand, detectPythonExecutable } from "../python-resolver.ts";

describe("normalizePythonCommand", () => {
  test("passes through command that does not start with python", () => {
    assert.equal(normalizePythonCommand("npm run test"), "npm run test");
  });

  test("passes through empty string", () => {
    assert.equal(normalizePythonCommand(""), "");
  });

  test("passes through non-python shell commands unchanged", () => {
    assert.equal(normalizePythonCommand("node index.js"), "node index.js");
    assert.equal(normalizePythonCommand("npx tsc --noEmit"), "npx tsc --noEmit");
  });

  test("passes through command unchanged when no python is detected", () => {
    // We cannot fully mock detectPythonExecutable here without a mock framework,
    // but we can verify that a command without python tokens is always preserved.
    const cmd = "cargo test";
    assert.equal(normalizePythonCommand(cmd), cmd);
  });

  test("rewrites leading python3 token when interpreter is detected", () => {
    const input = "python3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.startsWith(`${detected} `),
      `Expected rewritten prefix '${detected} ' in: ${result}`,
    );
    assert.ok(result.includes("-m pytest"), `Expected arguments preserved in: ${result}`);
  });

  test("rewrites leading python token when interpreter is detected", () => {
    const input = "python manage.py migrate";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.startsWith(`${detected} `),
      `Expected rewritten prefix '${detected} ' in: ${result}`,
    );
    assert.ok(result.includes("manage.py migrate"), `Expected arguments preserved in: ${result}`);
  });

  test("rewrites python token after && compound separator", () => {
    const input = "echo ok && python3 -m pytest --tb=short";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.ok(
      result.includes(`&& ${detected} `),
      `Expected '&& ${detected} ' segment in: ${result}`,
    );
    assert.ok(
      result.includes("-m pytest --tb=short"),
      `Expected arguments preserved in: ${result}`,
    );
  });

  test("rewrites leading python token when command has leading whitespace", () => {
    const input = "  python3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.equal(
      result,
      `  ${detected} -m pytest`,
      `Expected leading whitespace preserved and python3 rewritten in: ${result}`,
    );
  });

  test("does not duplicate '-3' when rewriting existing 'py -3' token", () => {
    const input = "py -3 -m pytest";
    const result = normalizePythonCommand(input);
    const detected = detectPythonExecutable();
    if (detected === null) {
      assert.equal(result, input, "expected passthrough when no interpreter is detected");
      return;
    }
    assert.equal(
      result,
      `${detected} -m pytest`,
      `Expected clean rewrite without duplicated '-3' in: ${result}`,
    );
  });
});

describe("detectPythonExecutable", () => {
  test("returns a string or null — never throws", () => {
    let result: string | null | undefined;
    assert.doesNotThrow(() => {
      result = detectPythonExecutable();
    });
    assert.ok(result === null || typeof result === "string");
  });

  test("return value is a known python invocation form or null", () => {
    const result = detectPythonExecutable();
    const valid = [null, "python3", "python", "py -3"];
    assert.ok(
      valid.includes(result as string | null),
      `Expected one of ${valid.join(", ")}, got: ${String(result)}`,
    );
  });

  test("returns the same value on repeated calls (cached)", () => {
    const first = detectPythonExecutable();
    const second = detectPythonExecutable();
    assert.equal(first, second, "detectPythonExecutable must return consistent cached result");
  });
});
