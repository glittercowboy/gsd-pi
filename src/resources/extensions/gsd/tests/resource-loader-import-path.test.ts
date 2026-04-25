// GSD2 — Regression test for broken resource-loader import path
// Ensures auto.ts imports resource-loader via package resolution, not a
// relative path that breaks when deployed to ~/.gsd/agent/extensions/gsd/.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const autoSrc = readFileSync(join(import.meta.dirname, "..", "auto.ts"), "utf-8");

describe("resource-loader import path", () => {
  test("must not use relative import reaching above extensions/", () => {
    // The old broken pattern: import("../../../" + "resource-loader.js")
    // This resolves to ~/.gsd/resource-loader.js from deployed location, which
    // doesn't exist. Regression introduced in #3899.
    const brokenPattern = /import\(\s*["']\.\.\/\.\.\/\.\..*resource-loader/;
    assert.ok(
      !brokenPattern.test(autoSrc),
      "auto.ts must not import resource-loader via relative path above extensions/ — " +
      "breaks when deployed to ~/.gsd/agent/extensions/gsd/ (see #3899)",
    );
  });

  test("uses GSD_PKG_ROOT to resolve resource-loader from package root", () => {
    // The fix uses GSD_PKG_ROOT (set by loader.ts) to construct an absolute
    // file URL to dist/resource-loader.js — works in both source and deployed,
    // and on Windows where raw paths fail with ERR_UNSUPPORTED_ESM_URL_SCHEME.
    assert.ok(
      autoSrc.includes('process.env.GSD_PKG_ROOT'),
      "auto.ts should use GSD_PKG_ROOT to resolve resource-loader",
    );
    assert.ok(
      autoSrc.includes('pathToFileURL'),
      "auto.ts should convert path to file URL for cross-platform import()",
    );
  });
});
