/**
 * auto-worktree-auto-resolve.test.ts — Unit tests for isSafeToAutoResolve.
 *
 * Covers: .gsd/ state files, build artifacts (.tsbuildinfo, .pyc, __pycache__,
 * .DS_Store, .map), and rejection of real source files.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  isSafeToAutoResolve,
  SAFE_AUTO_RESOLVE_PATTERNS,
} from "../auto-worktree.ts";

describe("isSafeToAutoResolve", () => {
  // ─── .gsd/ state files ───────────────────────────────────────────────────
  test("returns true for .gsd/ prefixed paths", () => {
    assert.ok(isSafeToAutoResolve(".gsd/STATE.md"));
    assert.ok(isSafeToAutoResolve(".gsd/milestones/M001/CONTEXT.md"));
    assert.ok(isSafeToAutoResolve(".gsd/gsd.db"));
  });

  // ─── Build artifact patterns ─────────────────────────────────────────────
  test("returns true for .tsbuildinfo files", () => {
    assert.ok(isSafeToAutoResolve("tsconfig.tsbuildinfo"));
    assert.ok(isSafeToAutoResolve("dist/tsconfig.tsbuildinfo"));
  });

  test("returns true for .pyc files", () => {
    assert.ok(isSafeToAutoResolve("module.pyc"));
    assert.ok(isSafeToAutoResolve("src/utils/helpers.pyc"));
  });

  test("returns true for __pycache__/ paths", () => {
    assert.ok(isSafeToAutoResolve("src/__pycache__/module.cpython-311.pyc"));
    assert.ok(isSafeToAutoResolve("lib/__pycache__/foo.py"));
  });

  test("returns true for .DS_Store files", () => {
    assert.ok(isSafeToAutoResolve(".DS_Store"));
    assert.ok(isSafeToAutoResolve("src/.DS_Store"));
  });

  test("returns true for .map source map files", () => {
    assert.ok(isSafeToAutoResolve("dist/index.js.map"));
    assert.ok(isSafeToAutoResolve("out/bundle.css.map"));
  });

  // ─── Real source files (should NOT be auto-resolved) ─────────────────────
  test("returns false for .ts source files", () => {
    assert.ok(!isSafeToAutoResolve("src/index.ts"));
    assert.ok(!isSafeToAutoResolve("lib/utils.ts"));
  });

  test("returns false for .js source files", () => {
    assert.ok(!isSafeToAutoResolve("src/index.js"));
    assert.ok(!isSafeToAutoResolve("lib/helpers.js"));
  });

  test("returns false for .py source files", () => {
    assert.ok(!isSafeToAutoResolve("src/main.py"));
    assert.ok(!isSafeToAutoResolve("scripts/deploy.py"));
  });

  test("returns false for config and data files", () => {
    assert.ok(!isSafeToAutoResolve("package.json"));
    assert.ok(!isSafeToAutoResolve("tsconfig.json"));
    assert.ok(!isSafeToAutoResolve("README.md"));
  });

  // ─── SAFE_AUTO_RESOLVE_PATTERNS export ────────────────────────────────────
  test("SAFE_AUTO_RESOLVE_PATTERNS is a non-empty array of RegExp", () => {
    assert.ok(Array.isArray(SAFE_AUTO_RESOLVE_PATTERNS));
    assert.ok(SAFE_AUTO_RESOLVE_PATTERNS.length > 0);
    for (const pattern of SAFE_AUTO_RESOLVE_PATTERNS) {
      assert.ok(pattern instanceof RegExp);
    }
  });
});
