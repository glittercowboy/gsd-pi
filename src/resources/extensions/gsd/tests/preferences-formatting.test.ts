/**
 * Tests for formatSkillRef — pure formatting logic for skill references
 * in the system prompt. Moved from preferences-skills.ts to preferences-types.ts
 * to break the preferences ↔ preferences-skills circular dependency.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatSkillRef } from "../preferences-types.ts";
import type { SkillResolution } from "../preferences-types.ts";

function makeResolutions(entries: [string, Partial<SkillResolution>][]): Map<string, SkillResolution> {
  const map = new Map<string, SkillResolution>();
  for (const [key, partial] of entries) {
    map.set(key, {
      original: partial.original ?? key,
      resolvedPath: partial.resolvedPath ?? null,
      method: partial.method ?? "unresolved",
    });
  }
  return map;
}

describe("formatSkillRef", () => {
  test("marks unresolved references with a warning", () => {
    const resolutions = makeResolutions([
      ["my-skill", { method: "unresolved" }],
    ]);
    const result = formatSkillRef("my-skill", resolutions);
    assert.match(result, /my-skill/);
    assert.match(result, /not found/);
  });

  test("marks unknown references (not in map) with a warning", () => {
    const resolutions = new Map<string, SkillResolution>();
    const result = formatSkillRef("unknown-skill", resolutions);
    assert.match(result, /unknown-skill/);
    assert.match(result, /not found/);
  });

  test("returns bare ref for absolute-path resolution", () => {
    const resolutions = makeResolutions([
      ["/home/user/skills/SKILL.md", {
        method: "absolute-path",
        resolvedPath: "/home/user/skills/SKILL.md",
      }],
    ]);
    const result = formatSkillRef("/home/user/skills/SKILL.md", resolutions);
    assert.equal(result, "/home/user/skills/SKILL.md");
  });

  test("returns bare ref for absolute-dir resolution", () => {
    const resolutions = makeResolutions([
      ["/home/user/skills/my-skill", {
        method: "absolute-dir",
        resolvedPath: "/home/user/skills/my-skill/SKILL.md",
      }],
    ]);
    const result = formatSkillRef("/home/user/skills/my-skill", resolutions);
    assert.equal(result, "/home/user/skills/my-skill");
  });

  test("shows resolved path for user-skill resolution", () => {
    const resolutions = makeResolutions([
      ["code-review", {
        method: "user-skill",
        resolvedPath: "/home/user/.claude/skills/code-review/SKILL.md",
      }],
    ]);
    const result = formatSkillRef("code-review", resolutions);
    assert.match(result, /code-review/);
    assert.match(result, /\.claude\/skills\/code-review\/SKILL\.md/);
  });

  test("shows resolved path for project-skill resolution", () => {
    const resolutions = makeResolutions([
      ["lint-fix", {
        method: "project-skill",
        resolvedPath: "/repo/.gsd/skills/lint-fix/SKILL.md",
      }],
    ]);
    const result = formatSkillRef("lint-fix", resolutions);
    assert.match(result, /lint-fix/);
    assert.match(result, /\.gsd\/skills\/lint-fix\/SKILL\.md/);
  });
});
