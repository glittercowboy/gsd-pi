import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills } from "@gsd/pi-coding-agent";
import {
  buildPlanMilestonePrompt,
  buildResearchMilestonePrompt,
  buildSkillActivationBlock,
} from "../auto-prompts.js";
import { warnIfManifestHasMissingSkills } from "../skill-manifest.js";
import { _resetLogs, drainLogs, setStderrLoggingEnabled } from "../workflow-logger.js";
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

function writeProjectPreferences(base: string, preferences: string): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), `---\n${preferences}---\n`);
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

test("buildSkillActivationBlock does not auto-activate skills via broad context heuristic", () => {
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

    // Skills should not be activated just because their name appears in task context.
    // Activation requires explicit preference sources (always_use, skill_rules, prefer_skills, skills_used).
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock activates skills via prefer_skills when context matches", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "Use for React components, hooks, JSX, and frontend UI work.");
    writeSkill(base, "swiftui", "Use for SwiftUI views, iOS layout, and Apple platform UI work.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, {
      sliceTitle: "Build React dashboard",
      taskId: "T01",
      taskTitle: "Implement React settings panel",
    }, {
      prefer_skills: ["react"],
    });

    assert.match(result, /Call Skill\(\{ skill: 'react' \}\)/);
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

    assert.equal(result, "<skill_activation>Call Skill({ skill: 'swift-testing' }).</skill_activation>");
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

    assert.match(result, /Call Skill\(\{ skill: 'accessibility' \}\)/);
    assert.match(result, /Call Skill\(\{ skill: 'prisma' \}\)/);
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock honors avoid_skills against always_use_skills", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "Use for React components and frontend UI work.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, {
      taskTitle: "Implement React settings panel",
    }, {
      always_use_skills: ["react"],
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

test("buildSkillActivationBlock does not activate skills from extraContext or taskPlanContent body", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "xcode-build", "Use for Xcode build workflows and iOS compilation.");
    writeSkill(base, "ableton-lom", "Use for Ableton Live Object Model scripting.");
    writeSkill(base, "frontend-design", "Use for frontend design systems and UI components.");
    loadOnlyTestSkills(base);

    const taskPlan = [
      "---",
      "skills_used: []",
      "---",
      "# T01: Build the API endpoint",
      "Use xcode-build patterns and frontend-design tokens.",
    ].join("\n");

    const result = buildBlock(base, {
      taskTitle: "Build REST API",
      extraContext: ["Build workflow for iOS and Ableton integration testing"],
      taskPlanContent: taskPlan,
    });

    // None of these skills should activate — extraContext and taskPlanContent body
    // must not be used for heuristic matching.
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock rejects skill names with special characters", () => {
  const base = makeTempBase();
  try {
    // Skill names with quotes, braces, or other non-alphanumeric characters are
    // rejected by the SAFE_SKILL_NAME guard to prevent prompt injection.
    writeSkill(base, "my-skill's", "Skill with apostrophe in name.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, {}, {
      always_use_skills: ["my-skill's"],
    });

    // Unsafe skill name is filtered out — empty result
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock allows valid skill names and rejects invalid ones", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "React skill.");
    writeSkill(base, "bad'name", "Injection attempt.");
    writeSkill(base, "good-skill-2", "Another valid skill.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, {}, {
      always_use_skills: ["react", "bad'name", "good-skill-2"],
    });

    assert.match(result, /skill_activation/);
    assert.match(result, /Call Skill\(\{ skill: 'react' \}\)/);
    assert.match(result, /Call Skill\(\{ skill: 'good-skill-2' \}\)/);
    assert.doesNotMatch(result, /bad'name/);
  } finally {
    cleanup(base);
  }
});

// ─── Per-unit-type skill manifest (RFC #4779) ─────────────────────────────────

test("buildSkillActivationBlock: explicit always_use_skills bypass the unit-type manifest", () => {
  const base = makeTempBase();
  try {
    // write-docs is in the research-milestone manifest; swiftui is not.
    // Both are in always_use_skills — a user-explicit source — so BOTH
    // should activate regardless of the manifest. User intent wins over
    // unit-type defaults. See RFC #4779 and skill-manifest.ts rationale.
    writeSkill(base, "write-docs", "Use when writing docs or RFCs.");
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, { unitType: "research-milestone" }, {
      always_use_skills: ["write-docs", "swiftui"],
    });

    assert.match(result, /Call Skill\(\{ skill: 'write-docs' \}\)/);
    assert.match(result, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock falls through to all skills for unknown unit type", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    loadOnlyTestSkills(base);

    const result = buildBlock(base, { unitType: "unknown-unit-type" }, {
      always_use_skills: ["swiftui"],
    });

    // Unknown unit type = wildcard fallback (pre-manifest behavior).
    assert.match(result, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});

test("buildSkillActivationBlock without unitType preserves pre-manifest behavior", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    loadOnlyTestSkills(base);

    // No unitType param — filter should no-op.
    const result = buildBlock(base, {}, {
      always_use_skills: ["swiftui"],
    });

    assert.match(result, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});

test("milestone prompt builders propagate always_use_skills through buildSkillActivationBlock", async () => {
  const base = makeTempBase();
  try {
    // Both skills are in always_use_skills — explicit user intent bypasses
    // the unit-type manifest, so both activate in both milestone flows.
    writeSkill(base, "write-docs", "Use when writing docs or RFCs.");
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    writeProjectPreferences(base, "always_use_skills:\n  - write-docs\n  - swiftui\n");
    loadOnlyTestSkills(base);

    const researchPrompt = await buildResearchMilestonePrompt("M001", "Test", base);
    assert.match(researchPrompt, /Call Skill\(\{ skill: 'write-docs' \}\)/);
    assert.match(researchPrompt, /Call Skill\(\{ skill: 'swiftui' \}\)/);

    const planPrompt = await buildPlanMilestonePrompt("M001", "Test", base);
    assert.match(planPrompt, /Call Skill\(\{ skill: 'write-docs' \}\)/);
    assert.match(planPrompt, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});

test("skill manifest strict warnings require GSD_SKILL_MANIFEST_STRICT=1", (t) => {
  const previousStrict = process.env.GSD_SKILL_MANIFEST_STRICT;
  const previousStderr = setStderrLoggingEnabled(false);
  t.after(() => {
    if (previousStrict === undefined) {
      delete process.env.GSD_SKILL_MANIFEST_STRICT;
    } else {
      process.env.GSD_SKILL_MANIFEST_STRICT = previousStrict;
    }
    setStderrLoggingEnabled(previousStderr);
    _resetLogs();
  });

  process.env.GSD_SKILL_MANIFEST_STRICT = "0";
  _resetLogs();
  warnIfManifestHasMissingSkills("research-milestone", new Set());
  assert.equal(drainLogs().length, 0, "strict=0 must preserve silent behavior");

  process.env.GSD_SKILL_MANIFEST_STRICT = "1";
  _resetLogs();
  warnIfManifestHasMissingSkills("research-milestone", new Set());
  const logs = drainLogs();
  assert.ok(
    logs.some(log => log.message.includes("skill-manifest: references uninstalled skill")),
    "strict=1 should warn about missing manifest entries",
  );
});
