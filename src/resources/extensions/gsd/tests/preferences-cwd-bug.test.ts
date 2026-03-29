/**
 * Regression test for #2985 Bug 1: preferences.ts process.cwd() side-channel.
 *
 * loadEffectiveGSDPreferences() must accept an explicit projectRoot parameter
 * so that its output depends on the project it was called for, not on whatever
 * directory process.cwd() happens to point at.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadProjectGSDPreferences,
  loadEffectiveGSDPreferences,
} from "../preferences.ts";
import { _clearGsdRootCache } from "../paths.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function createProjectDir(prefsYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-prefs-cwd-"));
  const gsdDir = join(dir, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "PREFERENCES.md"), `---\n${prefsYaml}\n---\n`);
  return dir;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("#2985 Bug 1 — preferences.ts cwd side-channel", () => {
  let projectA: string;
  let projectB: string;
  const savedCwd = process.cwd();
  const savedHome = process.env.HOME;
  const savedGsdHome = process.env.GSD_HOME;

  beforeEach(() => {
    _clearGsdRootCache();
    // Use unique custom_instructions to distinguish projects (mode has only 2 valid values)
    projectA = createProjectDir('custom_instructions:\n  - "project-alpha-marker"');
    projectB = createProjectDir('custom_instructions:\n  - "project-beta-marker"');
    // Isolate from real HOME so global preferences don't interfere
    process.env.HOME = mkdtempSync(join(tmpdir(), "gsd-home-"));
    process.env.GSD_HOME = join(process.env.HOME, ".gsd");
  });

  afterEach(() => {
    process.chdir(savedCwd);
    _clearGsdRootCache();
    process.env.HOME = savedHome;
    if (savedGsdHome !== undefined) {
      process.env.GSD_HOME = savedGsdHome;
    } else {
      delete process.env.GSD_HOME;
    }
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  test("loadProjectGSDPreferences(projectRoot) returns project-specific prefs regardless of cwd", () => {
    // When cwd is projectB, loading prefs for projectA should still return projectA's prefs
    process.chdir(projectB);
    const prefsA = loadProjectGSDPreferences(projectA);
    assert.ok(prefsA, "should load prefs for projectA");
    assert.ok(
      prefsA!.preferences.custom_instructions?.includes("project-alpha-marker"),
      "should return projectA's custom instruction, not cwd's",
    );

    const prefsB = loadProjectGSDPreferences(projectB);
    assert.ok(prefsB, "should load prefs for projectB");
    assert.ok(
      prefsB!.preferences.custom_instructions?.includes("project-beta-marker"),
      "should return projectB's custom instruction",
    );
  });

  test("loadEffectiveGSDPreferences(projectRoot) returns correct prefs for specified project", () => {
    // cwd is projectB, but we ask for projectA
    process.chdir(projectB);
    const effective = loadEffectiveGSDPreferences(projectA);
    assert.ok(effective, "should load effective prefs for projectA");
    assert.ok(
      effective!.preferences.custom_instructions?.includes("project-alpha-marker"),
      "should return projectA's custom instruction when projectRoot=projectA, even though cwd=projectB",
    );
  });

  test("loadEffectiveGSDPreferences() without argument falls back to cwd for backward compat", () => {
    process.chdir(projectA);
    const effective = loadEffectiveGSDPreferences();
    assert.ok(effective, "should load prefs from cwd when no projectRoot given");
    assert.ok(
      effective!.preferences.custom_instructions?.includes("project-alpha-marker"),
      "should return cwd project's custom instruction",
    );
  });
});
