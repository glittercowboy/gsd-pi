// @gsd-build/mcp-server — Behaviour tests for secure_env_collect MCP tool
//
// Drives `secureEnvCollectHandler` directly with a fake `elicitInput`
// function. No mock McpServer, no DI seam on `createMcpServer` — the
// handler is an exported top-level function that takes the elicitation
// callback as a parameter. Production `createMcpServer` wraps it with
// `server.server.elicitInput`.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secureEnvCollectHandler, type ElicitInputFn } from "./server.js";

// ─── Helpers ───────────────────────────────────────────────────────────

type ElicitResponse = {
  action: "accept" | "cancel" | "decline";
  content?: Record<string, unknown>;
};

interface ToolContentShape {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function textOf(result: unknown): string {
  const r = result as ToolContentShape;
  return (r.content ?? []).map((c) => c.text).join("\n");
}

/** Build a fake elicitInput that returns a pre-programmed response and records calls. */
function fakeElicit(response: ElicitResponse): {
  fn: ElicitInputFn;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const fn: ElicitInputFn = async (params) => {
    calls.push(params);
    return response;
  };
  return { fn, calls };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("secure_env_collect — handler behaviour", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir("sec-collect");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("short-circuits with 'already set' when every key exists", async () => {
    const envPath = join(tmp, ".env");
    writeFileSync(envPath, "FIRST=1\nSECOND=2\n");

    const { fn, calls } = fakeElicit({ action: "accept", content: {} });

    const result = await secureEnvCollectHandler(
      {
        projectDir: tmp,
        keys: [{ key: "FIRST" }, { key: "SECOND" }],
        destination: "dotenv",
        // envFilePath omitted — handler defaults to '.env' inside projectDir.
        // Passing an absolute envFilePath trips the realpath-vs-symlink
        // containment check on macOS tmpdirs (/var vs /private/var).
      },
      fn,
    );

    const text = textOf(result);
    assert.match(text, /already set/);
    assert.match(text, /FIRST/);
    assert.match(text, /SECOND/);
    // Elicit was NOT called — short-circuit path.
    assert.equal(calls.length, 0);
  });

  it("writes provided values to .env and never returns the secret in output", async () => {
    const envPath = join(tmp, ".env");

    const { fn } = fakeElicit({
      action: "accept",
      content: { SEC_KEY_WRITE: "sk-definitely-not-in-output-xyz" },
    });

    const result = await secureEnvCollectHandler(
      {
        projectDir: tmp,
        keys: [{ key: "SEC_KEY_WRITE" }],
        destination: "dotenv",
      },
      fn,
    );

    const text = textOf(result);
    // .env must contain the value.
    assert.match(
      readFileSync(envPath, "utf-8"),
      /SEC_KEY_WRITE=sk-definitely-not-in-output-xyz/,
    );
    // But the tool output must NOT — this is the contract the tool name promises.
    assert.ok(
      !text.includes("sk-definitely-not-in-output-xyz"),
      `tool output must not contain secret. got: ${text}`,
    );
    assert.match(text, /SEC_KEY_WRITE.*applied/);

    // Cleanup the process.env hydration applySecrets does.
    delete process.env.SEC_KEY_WRITE;
  });

  it("separates empty form fields into 'skipped' without writing them", async () => {
    const envPath = join(tmp, ".env");

    const { fn } = fakeElicit({
      action: "accept",
      content: {
        FILLED_KEY: "real-value",
        // Empty string — the handler MUST classify this as skipped.
        EMPTY_KEY: "",
        // Whitespace-only — must also classify as skipped (trim).
        WS_KEY: "   ",
      },
    });

    const result = await secureEnvCollectHandler(
      {
        projectDir: tmp,
        keys: [
          { key: "FILLED_KEY" },
          { key: "EMPTY_KEY" },
          { key: "WS_KEY" },
        ],
        destination: "dotenv",
      },
      fn,
    );

    const text = textOf(result);
    assert.match(text, /FILLED_KEY.*applied/, "FILLED_KEY should be applied");
    assert.match(text, /EMPTY_KEY.*skipped/, "EMPTY_KEY should be skipped");
    assert.match(text, /WS_KEY.*skipped/, "WS_KEY should be skipped");

    // The .env must only contain the filled key.
    const envContent = readFileSync(envPath, "utf-8");
    assert.match(envContent, /FILLED_KEY=real-value/);
    assert.ok(
      !envContent.includes("EMPTY_KEY="),
      "empty form field must not be written to .env",
    );
    assert.ok(
      !envContent.includes("WS_KEY="),
      "whitespace-only form field must not be written to .env",
    );

    delete process.env.FILLED_KEY;
  });

  it("handles a mix of existing, new, and skipped keys in one call", async () => {
    const envPath = join(tmp, ".env");
    writeFileSync(envPath, "EXISTING_MIX=already-here\n");

    const { fn, calls } = fakeElicit({
      action: "accept",
      content: { NEW_MIX: "new-value", SKIP_MIX: "" },
    });

    const result = await secureEnvCollectHandler(
      {
        projectDir: tmp,
        keys: [
          { key: "EXISTING_MIX" },
          { key: "NEW_MIX" },
          { key: "SKIP_MIX" },
        ],
        destination: "dotenv",
      },
      fn,
    );

    const text = textOf(result);
    assert.match(text, /EXISTING_MIX.*already set/);
    assert.match(text, /NEW_MIX.*applied/);
    assert.match(text, /SKIP_MIX.*skipped/);
    // Only the new one was elicited for (existing was pre-filtered).
    assert.equal(calls.length, 1);

    delete process.env.NEW_MIX;
  });

  it("returns a cancellation message when user declines the form", async () => {
    const envPath = join(tmp, ".env");

    const { fn } = fakeElicit({ action: "cancel" });

    const result = await secureEnvCollectHandler(
      {
        projectDir: tmp,
        keys: [{ key: "CANCELLED_KEY" }],
        destination: "dotenv",
      },
      fn,
    );

    const text = textOf(result);
    assert.match(text, /cancelled/i);
    // No .env write on cancel: either the file wasn't created at all, or
    // if it was it doesn't contain the key.
    const { existsSync: exists } = await import("node:fs");
    if (exists(envPath)) {
      assert.ok(
        !readFileSync(envPath, "utf-8").includes("CANCELLED_KEY="),
        ".env should not contain key on cancel",
      );
    }
  });

  it("auto-detects destination from project files when not specified", async () => {
    // No vercel/convex signals — falls back to dotenv.
    const { fn } = fakeElicit({
      action: "accept",
      content: { AUTO_DETECT_KEY: "auto-value" },
    });

    const result = await secureEnvCollectHandler(
      {
        projectDir: tmp,
        keys: [{ key: "AUTO_DETECT_KEY" }],
        // Intentionally omit `destination` — handler should auto-detect.
      },
      fn,
    );

    const text = textOf(result);
    assert.match(
      text,
      /auto-detected/,
      "result should announce an auto-detected destination",
    );

    delete process.env.AUTO_DETECT_KEY;
  });
});
