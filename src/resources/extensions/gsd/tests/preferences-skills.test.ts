import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * getAgentDir() resolves its env var name from piConfig.name in the nearest
 * package.json.  In production (dist/) that's "gsd" → GSD_CODING_AGENT_DIR.
 * In the workspace test context (src/) it may resolve to "pi" →
 * PI_CODING_AGENT_DIR because packages/pi-coding-agent/package.json is found
 * first.  We set BOTH so the test works in either context.
 */
const AGENT_DIR_ENVS = ["GSD_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"];

function setAgentDirEnv(value: string) {
  for (const key of AGENT_DIR_ENVS) process.env[key] = value;
}

function restoreAgentDirEnv(saved: Record<string, string | undefined>) {
  for (const key of AGENT_DIR_ENVS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function saveAgentDirEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of AGENT_DIR_ENVS) saved[key] = process.env[key];
  return saved;
}

function makeSkillDir(baseDir: string, relativePath: string, skillName: string): string {
  const dir = join(baseDir, relativePath, skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${skillName}\n`);
  return dir;
}

test("resolveSkillReference resolves bare skill names from ~/.agents/skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-pref-skills-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent-home");
  const homeDir = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const savedEnv = saveAgentDirEnv();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  setAgentDirEnv(agentDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir; // Windows: os.homedir() reads USERPROFILE

  try {
    makeSkillDir(homeDir, ".agents/skills", "cmux");
    const { resolveSkillReference } = await import("../preferences-skills.ts");
    const result = resolveSkillReference("cmux", cwd);
    assert.equal(result.method, "user-skill");
    assert.equal(result.resolvedPath, join(homeDir, ".agents", "skills", "cmux", "SKILL.md"));
  } finally {
    restoreAgentDirEnv(savedEnv);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSkillReference prefers ~/.gsd/agent/skills over ~/.agents/skills for the same bare name", async () => {
  const root = mkdtempSync(join(tmpdir(), "gsd-pref-skills-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent-home");
  const homeDir = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const savedEnv = saveAgentDirEnv();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  setAgentDirEnv(agentDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir; // Windows: os.homedir() reads USERPROFILE

  try {
    makeSkillDir(agentDir, "skills", "cmux");
    makeSkillDir(homeDir, ".agents/skills", "cmux");
    const { resolveSkillReference } = await import("../preferences-skills.ts");
    const result = resolveSkillReference("cmux", cwd);
    assert.equal(result.method, "user-skill");
    assert.equal(result.resolvedPath, join(agentDir, "skills", "cmux", "SKILL.md"));
  } finally {
    restoreAgentDirEnv(savedEnv);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});
