import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const addonDir = path.resolve(__dirname, "..", "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;
const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node"),
];

let native;
for (const candidate of candidates) {
  try {
    native = require(candidate);
    break;
  } catch {
    // try next
  }
}

if (!native) {
  console.error("Native addon not found. Run build:native first.");
  process.exit(1);
}

function isClipboardUnavailableError(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? "";
  return (
    message.includes("Failed to access clipboard") &&
    (
      message.includes("X11 server connection timed out") ||
      message.includes("X11 server connection") ||
      message.includes("wl-clipboard") ||
      message.includes("No display") ||
      message.includes("DISPLAY")
    )
  );
}

function skipIfClipboardUnavailable(t, error) {
  if (isClipboardUnavailableError(error)) {
    t.skip(`system clipboard unavailable in this environment: ${error.message}`);
    return;
  }
  throw error;
}

describe("native clipboard: copyToClipboard()", () => {
  test("copies text without throwing", (t) => {
    try {
      native.copyToClipboard("GSD clipboard test");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("accepts empty string", (t) => {
    try {
      native.copyToClipboard("");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("accepts unicode text", (t) => {
    try {
      native.copyToClipboard("Hello 世界");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});

describe("native clipboard: readTextFromClipboard()", () => {
  test("reads back text that was copied", (t) => {
    try {
      const testText = `GSD clipboard roundtrip ${Date.now()}`;
      native.copyToClipboard(testText);
      const result = native.readTextFromClipboard();
      assert.equal(result, testText);
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("returns a string or null", (t) => {
    try {
      const result = native.readTextFromClipboard();
      assert.ok(result === null || typeof result === "string");
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});

describe("native clipboard: readImageFromClipboard()", () => {
  test("returns a promise", async (t) => {
    const result = native.readImageFromClipboard();
    assert.ok(result instanceof Promise);
    try {
      await result;
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });

  test("resolves to ClipboardImage or null", async (t) => {
    try {
      const result = await native.readImageFromClipboard();
      if (result !== null) {
        assert.ok(result.data instanceof Uint8Array, "data should be Uint8Array");
        assert.equal(result.mimeType, "image/png");
      }
    } catch (error) {
      skipIfClipboardUnavailable(t, error);
    }
  });
});
