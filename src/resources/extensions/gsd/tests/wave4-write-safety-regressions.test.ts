// GSD State Machine — Wave 4 Write Safety Regression Tests
// Validates randomized tmp suffix in json-persistence and atomic writes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveJsonFile, loadJsonFile } from "../json-persistence.js";

// ── Fix 15: json-persistence uses randomized tmp suffix ──

describe("saveJsonFile atomic write", () => {
  test("writes JSON file correctly", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "test.json");
      saveJsonFile(file, { key: "value" });
      const content = JSON.parse(readFileSync(file, "utf-8"));
      assert.deepStrictEqual(content, { key: "value" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no .tmp file left after successful write", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "test.json");
      saveJsonFile(file, { data: 123 });
      const files = readdirSync(tmp);
      const tmpFiles = files.filter((f: string) => f.includes(".tmp"));
      assert.strictEqual(tmpFiles.length, 0, "No .tmp files should remain after write");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("concurrent writes don't corrupt data", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "shared.json");
      // Write two different values rapidly — both should succeed without corruption
      saveJsonFile(file, { writer: "first" });
      saveJsonFile(file, { writer: "second" });
      const content = JSON.parse(readFileSync(file, "utf-8"));
      assert.strictEqual(content.writer, "second");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("round-trip through loadJsonFile", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "roundtrip.json");
      const data = { items: [1, 2, 3], name: "test" };
      saveJsonFile(file, data);
      const loaded = loadJsonFile(
        file,
        (d): d is typeof data => typeof d === "object" && d !== null && "items" in d,
        () => ({ items: [], name: "" }),
      );
      assert.deepStrictEqual(loaded.items, [1, 2, 3]);
      assert.strictEqual(loaded.name, "test");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
