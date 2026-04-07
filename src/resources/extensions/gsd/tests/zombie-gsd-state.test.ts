/**
 * zombie-gsd-state.test.ts — #2942
 *
 * A partially initialized .gsd/ (symlink exists but no PREFERENCES.md or
 * milestones/) must be detected as incomplete bootstrap. Tests the extracted
 * hasGsdBootstrapArtifacts() function with real filesystem fixtures.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasGsdBootstrapArtifacts } from "../paths.ts";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `gsd-zombie-${prefix}-`));
}

describe("#2942: hasGsdBootstrapArtifacts", () => {
  test("returns false when .gsd/ does not exist", (t) => {
    const dir = createTempDir("none");
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    assert.deepStrictEqual(hasGsdBootstrapArtifacts(dir), false);
  });

  test("returns false when .gsd/ exists but is empty (zombie state)", (t) => {
    const dir = createTempDir("zombie");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".gsd"), { recursive: true });

    assert.deepStrictEqual(hasGsdBootstrapArtifacts(dir), false);
  });

  test("returns true when .gsd/PREFERENCES.md exists", (t) => {
    const dir = createTempDir("prefs");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "# Preferences");

    assert.deepStrictEqual(hasGsdBootstrapArtifacts(dir), true);
  });

  test("returns true when .gsd/milestones/ exists", (t) => {
    const dir = createTempDir("milestones");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });

    assert.deepStrictEqual(hasGsdBootstrapArtifacts(dir), true);
  });

  test("returns true when both PREFERENCES.md and milestones/ exist", (t) => {
    const dir = createTempDir("both");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "# Preferences");

    assert.deepStrictEqual(hasGsdBootstrapArtifacts(dir), true);
  });

  test("returns false when .gsd/ has only unrelated files (zombie state)", (t) => {
    const dir = createTempDir("unrelated");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, ".gsd"), { recursive: true });
    writeFileSync(join(dir, ".gsd", "gsd.db"), "");
    writeFileSync(join(dir, ".gsd", "auto.lock"), "{}");

    assert.deepStrictEqual(hasGsdBootstrapArtifacts(dir), false);
  });
});
