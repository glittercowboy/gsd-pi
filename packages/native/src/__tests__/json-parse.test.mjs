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
  console.error("Native addon not found. Run `npm run build:native -w @gsd/native` first.");
  process.exit(1);
}

describe("native json: parseJson()", () => {
  test("parses complete JSON object", () => {
    const result = native.parseJson('{"key": "value", "num": 42}');
    assert.equal(result.key, "value");
    assert.equal(result.num, 42);
  });

  test("parses JSON array", () => {
    const result = native.parseJson("[1, 2, 3]");
    assert.deepEqual(result, [1, 2, 3]);
  });

  test("parses JSON string", () => {
    const result = native.parseJson('"hello"');
    assert.equal(result, "hello");
  });

  test("parses JSON number", () => {
    const result = native.parseJson("42.5");
    assert.equal(result, 42.5);
  });

  test("parses JSON boolean", () => {
    assert.equal(native.parseJson("true"), true);
    assert.equal(native.parseJson("false"), false);
  });

  test("parses JSON null", () => {
    assert.equal(native.parseJson("null"), null);
  });

  test("throws on invalid JSON", () => {
    assert.throws(() => native.parseJson("{invalid}"));
  });
});

describe("native json: parsePartialJson()", () => {
  test("parses complete JSON unchanged", () => {
    const result = native.parsePartialJson('{"key": "value"}');
    assert.equal(result.key, "value");
  });

  test("closes unclosed string", () => {
    const result = native.parsePartialJson('{"key": "val');
    assert.equal(result.key, "val");
  });

  test("closes unclosed object", () => {
    const result = native.parsePartialJson('{"key": "value"');
    assert.equal(result.key, "value");
  });

  test("closes unclosed array", () => {
    const result = native.parsePartialJson('{"arr": [1, 2, 3');
    assert.deepEqual(result.arr, [1, 2, 3]);
  });

  test("removes trailing comma in object", () => {
    const result = native.parsePartialJson('{"a": 1, "b": 2,}');
    assert.equal(result.a, 1);
    assert.equal(result.b, 2);
  });

  test("removes trailing comma in array", () => {
    const result = native.parsePartialJson("[1, 2, 3,]");
    assert.deepEqual(result, [1, 2, 3]);
  });

  test("handles truncated value after colon", () => {
    const result = native.parsePartialJson('{"key":');
    assert.equal(result.key, null);
  });

  test("handles truncated true", () => {
    const result = native.parsePartialJson('{"key": tr');
    assert.equal(result.key, true);
  });

  test("handles truncated false", () => {
    const result = native.parsePartialJson('{"key": fal');
    assert.equal(result.key, false);
  });

  test("handles truncated null", () => {
    const result = native.parsePartialJson('{"key": nu');
    assert.equal(result.key, null);
  });

  test("handles nested partial structures", () => {
    const result = native.parsePartialJson('{"a": {"b": [1, 2');
    assert.deepEqual(result.a.b, [1, 2]);
  });
});

describe("native json: parseStreamingJson()", () => {
  test("returns empty object for empty string", () => {
    const result = native.parseStreamingJson("");
    assert.deepEqual(result, {});
  });

  test("returns empty object for whitespace", () => {
    const result = native.parseStreamingJson("   ");
    assert.deepEqual(result, {});
  });

  test("parses complete JSON", () => {
    const result = native.parseStreamingJson('{"tool": "search", "args": {"query": "test"}}');
    assert.equal(result.tool, "search");
    assert.equal(result.args.query, "test");
  });

  test("parses partial JSON (streaming scenario)", () => {
    const result = native.parseStreamingJson('{"tool": "search", "args": {"query": "te');
    assert.equal(result.tool, "search");
    assert.equal(result.args.query, "te");
  });

  test("handles deeply nested partial JSON", () => {
    const result = native.parseStreamingJson('{"a": {"b": {"c": [1, 2, {"d": "val');
    assert.equal(result.a.b.c[2].d, "val");
  });

  test("handles escaped characters in strings", () => {
    const result = native.parseStreamingJson('{"path": "C:\\\\Users\\\\test');
    assert.ok(result.path.includes("C:\\Users\\test"));
  });
});
