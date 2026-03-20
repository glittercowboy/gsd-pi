import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills } from "@gsd/pi-coding-agent";
import { buildSkillActivationBlock } from "../auto-prompts.js";
import type { GSDPreferences } from "../preferences.js";

function makeTempBase(): string {
  return mkdtempSync(join(tmpdir(), "gsd-skill-activation-"));
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function writeSkill(base: string, name: string, description: string): void {
  const dir = join(base, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

function loadOnlyTestSkills(base: string): void {
  loadSkills({ cwd: base, includeDefaults: false, skillPaths: [join(base, "skills")] });
}

function buildBlock(
  base: string,
  params: Partial<Parameters<typeof buildSkillActivationBlock>[0]> = {},
  preferences: GSDPreferences = {},
): string {
  return buildSkillActivationBlock({
    base,
    milestoneId: "M001",
    sliceId: "S01",
    ...params,
    preferences,
  });
}

test("buildSkillActivationBlock matches installed skills from task context", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "Use for React components, hooks, JSX, and frontend UI work.");
    writeSkill(base, "swiftui", "Use for SwiftUI views, iOS layout, and Apple platform UI work.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, {
      sliceTitle: "Build React dashboard",
      taskId: "T01",
      taskTitle: "Implement React settings panel",
    });

    assert.match(result, /<skill_activation>/);
    assert.match(result, /Call Skill\('react'\)/);
    assert.doesNotMatch(result, /swiftui/);
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock includes always_use_skills from preferences using exact Skill tool format", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swift-testing", "Use for Swift Testing assertions and verification patterns.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, { taskTitle: "Unrelated task title" }, {
      always_use_skills: ["swift-testing"],
    });

    assert.equal(result, "<skill_activation>Call Skill('swift-testing').</skill_activation>");
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock includes skill_rules matches and task-plan skills_used", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "prisma", "Use for Prisma schema, migrations, and ORM queries.");
    writeSkill(base, "accessibility", "Use for accessibility, aria attributes, and keyboard support.");
    loadOnlyTestSkills(base);

    const taskPlan = [
      "---",
      "skills_used:",
      "  - accessibility",
      "---",
      "# T01: Example",
    ].join("\n");

    const result = buildBlock(base, {
      taskTitle: "Update prisma schema",
      taskPlanContent: taskPlan,
    }, {
      skill_rules: [{ when: "prisma database schema", use: ["prisma"] }],
    });

    assert.match(result, /Call Skill\('accessibility'\)/);
    assert.match(result, /Call Skill\('prisma'\)/);
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock honors avoid_skills", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "Use for React components and frontend UI work.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, {
      taskTitle: "Implement React settings panel",
    }, {
      avoid_skills: ["react"],
    });

    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock falls back cleanly when nothing matches", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swiftui", "Use for SwiftUI apps.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, {
      taskTitle: "Plain text docs task",
    });

    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});
