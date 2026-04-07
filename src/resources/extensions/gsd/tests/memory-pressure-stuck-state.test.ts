/**
 * Regression tests for memory pressure monitoring (#3331) and
 * stuck detection persistence (#3704) in auto/loop.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const loopSource = readFileSync(join(__dirname, "..", "auto", "loop.ts"), "utf-8");

describe("memory pressure monitoring (#3331)", () => {
  test("checkMemoryPressure function exists", () => {
    assert.match(loopSource, /function checkMemoryPressure/);
  });

  test("MEMORY_PRESSURE_THRESHOLD constant is defined", () => {
    assert.match(loopSource, /MEMORY_PRESSURE_THRESHOLD\s*=\s*0\.\d+/);
  });

  test("memory check runs every MEMORY_CHECK_INTERVAL iterations", () => {
    assert.match(loopSource, /iteration\s*%\s*MEMORY_CHECK_INTERVAL\s*===\s*0/);
  });

  test("memory pressure triggers graceful stopAuto", () => {
    assert.match(loopSource, /mem\.pressured/);
    assert.match(loopSource, /Stopping gracefully to prevent OOM/);
  });
});

describe("stuck detection persistence (#3704)", () => {
  test("loadStuckState function exists", () => {
    assert.match(loopSource, /function loadStuckState/);
  });

  test("saveStuckState function exists", () => {
    assert.match(loopSource, /function saveStuckState/);
  });

  test("loopState initialized from persisted state", () => {
    assert.match(loopSource, /loadStuckState\(s\.basePath\)/);
  });

  test("stuck state saved after each iteration", () => {
    assert.match(loopSource, /saveStuckState\(s\.basePath,\s*loopState\)/);
  });

  test("stuck state file path uses runtime directory", () => {
    assert.match(loopSource, /stuck-state\.json/);
  });
});
