/**
 * Tests for Claude Code skill directory support in getSkillSearchDirs().
 *
 * Verifies that ~/.claude/skills/ and .claude/skills/ are included in
 * the skill search path alongside ~/.agents/skills/ and .agents/skills/.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSkillSearchDirs } from "../preferences-skills.ts";

describe("getSkillSearchDirs — Claude Code directory support", () => {
  const cwd = "/tmp/test-project";

  test("includes ~/.agents/skills/ as user-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const agents = dirs.find((d) => d.dir === join(homedir(), ".agents", "skills"));
    assert.ok(agents, "should include ~/.agents/skills/");
    assert.equal(agents!.method, "user-skill");
  });

  test("includes .agents/skills/ as project-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const projectAgents = dirs.find((d) => d.dir === join(cwd, ".agents", "skills"));
    assert.ok(projectAgents, "should include .agents/skills/");
    assert.equal(projectAgents!.method, "project-skill");
  });

  test("includes ~/.claude/skills/ as user-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const claude = dirs.find((d) => d.dir === join(homedir(), ".claude", "skills"));
    assert.ok(claude, "should include ~/.claude/skills/");
    assert.equal(claude!.method, "user-skill");
  });

  test("includes .claude/skills/ as project-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const projectClaude = dirs.find((d) => d.dir === join(cwd, ".claude", "skills"));
    assert.ok(projectClaude, "should include .claude/skills/");
    assert.equal(projectClaude!.method, "project-skill");
  });

  test("~/.agents/skills/ appears before ~/.claude/skills/ (priority order)", () => {
    const dirs = getSkillSearchDirs(cwd);
    const agentsIdx = dirs.findIndex((d) => d.dir === join(homedir(), ".agents", "skills"));
    const claudeIdx = dirs.findIndex((d) => d.dir === join(homedir(), ".claude", "skills"));
    assert.ok(agentsIdx < claudeIdx, "~/.agents/skills/ should have higher priority than ~/.claude/skills/");
  });
});
