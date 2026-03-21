/**
 * json-persistence-atomic.test.ts — Tests for atomic JSON persistence.
 *
 * Verifies that saveJsonFile() uses atomic write-tmp-rename pattern
 * so that crashes mid-write don't corrupt the target file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  saveJsonFile,
  loadJsonFile,
  writeJsonFileAtomic,
} from "../json-persistence.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "gsd-json-test-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

test("saveJsonFile creates file with valid JSON content", () => {
  const dir = makeTempDir();
  const filePath = join(dir, "test.json");

  try {
    const data = { foo: "bar", count: 42 };
    saveJsonFile(filePath, data);

    assert.ok(existsSync(filePath), "File should exist");
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed, data);
  } finally {
    cleanup(dir);
  }
});

test("saveJsonFile does not leave .tmp files on success", () => {
  const dir = makeTempDir();
  const filePath = join(dir, "clean.json");

  try {
    saveJsonFile(filePath, { test: true });

    // No .tmp files should remain
    const files = readdirSync(dir);
    const tmpFiles = files.filter(f => f.includes(".tmp"));
    assert.equal(tmpFiles.length, 0, `Unexpected .tmp files: ${tmpFiles.join(", ")}`);
  } finally {
    cleanup(dir);
  }
});

test("saveJsonFile creates parent directories", () => {
  const dir = makeTempDir();
  const filePath = join(dir, "deep", "nested", "data.json");

  try {
    saveJsonFile(filePath, { nested: true });

    assert.ok(existsSync(filePath), "File should exist in nested directory");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.deepEqual(parsed, { nested: true });
  } finally {
    cleanup(dir);
  }
});

test("saveJsonFile overwrites existing file atomically", () => {
  const dir = makeTempDir();
  const filePath = join(dir, "overwrite.json");

  try {
    // Write initial value
    saveJsonFile(filePath, { version: 1, data: "initial" });
    assert.equal(JSON.parse(readFileSync(filePath, "utf-8")).version, 1);

    // Overwrite
    saveJsonFile(filePath, { version: 2, data: "updated" });
    const result = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(result.version, 2);
    assert.equal(result.data, "updated");
  } finally {
    cleanup(dir);
  }
});

test("saveJsonFile produces valid content readable by loadJsonFile", () => {
  const dir = makeTempDir();
  const filePath = join(dir, "roundtrip.json");

  try {
    interface TestData { items: string[]; count: number }
    const original: TestData = { items: ["a", "b", "c"], count: 3 };

    saveJsonFile(filePath, original);

    const loaded = loadJsonFile<TestData>(
      filePath,
      (d): d is TestData => typeof d === "object" && d !== null && "items" in d,
      () => ({ items: [], count: 0 }),
    );

    assert.deepEqual(loaded, original);
  } finally {
    cleanup(dir);
  }
});

test("writeJsonFileAtomic and saveJsonFile produce equivalent results", () => {
  const dir = makeTempDir();
  const atomicPath = join(dir, "atomic.json");
  const savePath = join(dir, "save.json");

  try {
    const data = { key: "value", num: 123 };

    writeJsonFileAtomic(atomicPath, data);
    saveJsonFile(savePath, data);

    // Both should produce valid JSON with same content
    const atomicParsed = JSON.parse(readFileSync(atomicPath, "utf-8"));
    const saveParsed = JSON.parse(readFileSync(savePath, "utf-8"));

    assert.deepEqual(atomicParsed, data);
    assert.deepEqual(saveParsed, data);
  } finally {
    cleanup(dir);
  }
});

test("saveJsonFile handles large data objects", () => {
  const dir = makeTempDir();
  const filePath = join(dir, "large.json");

  try {
    // Create a large object to stress-test atomic write
    const largeData = {
      items: Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        description: "x".repeat(100),
      })),
    };

    saveJsonFile(filePath, largeData);

    const loaded = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(loaded.items.length, 1000);
    assert.equal(loaded.items[999].id, 999);
  } finally {
    cleanup(dir);
  }
});

test("saveJsonFile is non-fatal on permission errors", () => {
  // Write to a path that doesn't exist and can't be created
  // saveJsonFile should swallow the error, not throw
  assert.doesNotThrow(() => {
    saveJsonFile("/nonexistent/deeply/nested/path/file.json", { test: true });
  });
});
