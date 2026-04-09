/**
 * Unit tests for GSD Preparation — codebase analysis and brief generation.
 *
 * Exercises the pure preparation functions:
 * - analyzeCodebase() with various project layouts
 * - formatCodebaseBrief() output format and truncation
 * - Pattern extraction from sampled files
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeCodebase,
  formatCodebaseBrief,
  aggregatePriorContext,
  formatPriorContextBrief,
  researchEcosystem,
  formatEcosystemBrief,
  runPreparation,
  type CodebaseBrief,
  type PriorContextBrief,
  type EcosystemBrief,
  type EcosystemFinding,
  type PreparationUIContext,
  type PreparationPreferences,
  type PreparationResult,
} from "../preparation.ts";
import { PROJECT_FILES } from "../detection.ts";

// ─── Test Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-preparation-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ─── analyzeCodebase ────────────────────────────────────────────────────────────

test("analyzeCodebase: empty directory returns valid brief structure", async (t) => {
  const dir = makeTempDir("empty");
  t.after(() => cleanup(dir));

  const brief = await analyzeCodebase(dir);

  assert.ok(brief, "should return a brief");
  assert.ok(brief.techStack, "should have techStack");
  assert.ok(brief.moduleStructure, "should have moduleStructure");
  assert.ok(brief.patterns, "should have patterns");
  assert.ok(Array.isArray(brief.sampledFiles), "should have sampledFiles array");
  assert.equal(brief.sampledFiles.length, 0, "empty dir should have no sampled files");
});

test("analyzeCodebase: detects package.json in PROJECT_FILES", async (t) => {
  const dir = makeTempDir("pkg-json");
  t.after(() => cleanup(dir));

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "test-project", scripts: { test: "jest" } }),
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  assert.ok(
    brief.techStack.detectedFiles.includes("package.json"),
    "should detect package.json",
  );
  assert.equal(brief.techStack.primaryLanguage, "javascript/typescript");
});

test("analyzeCodebase: detects module structure from src/ directory", async (t) => {
  const dir = makeTempDir("module-struct");
  t.after(() => cleanup(dir));

  // Create src directory with subdirs
  mkdirSync(join(dir, "src", "components"), { recursive: true });
  mkdirSync(join(dir, "src", "utils"), { recursive: true });
  mkdirSync(join(dir, "src", "hooks"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });

  const brief = await analyzeCodebase(dir);

  assert.ok(
    brief.moduleStructure.topLevelDirs.includes("src"),
    "should detect src as top-level dir",
  );
  assert.ok(
    brief.moduleStructure.topLevelDirs.includes("test"),
    "should detect test as top-level dir",
  );
  assert.ok(
    brief.moduleStructure.srcSubdirs.includes("components"),
    "should detect components subdir",
  );
  assert.ok(
    brief.moduleStructure.srcSubdirs.includes("utils"),
    "should detect utils subdir",
  );
  assert.ok(
    brief.moduleStructure.srcSubdirs.includes("hooks"),
    "should detect hooks subdir",
  );
});

test("analyzeCodebase: samples TypeScript files from src/", async (t) => {
  const dir = makeTempDir("sample-ts");
  t.after(() => cleanup(dir));

  // Create src directory with TypeScript files
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    `export async function main() { await fetch('/api'); }`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "src", "utils.ts"),
    `export function helper() { try { return 1; } catch (e) { throw e; } }`,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  assert.ok(brief.sampledFiles.length > 0, "should sample at least one file");
  assert.ok(
    brief.sampledFiles.some((f) => f.startsWith("src/")),
    "should prefer src/ files",
  );
});

test("analyzeCodebase: excludes test files from sampling", async (t) => {
  const dir = makeTempDir("exclude-tests");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), `export const x = 1;`, "utf-8");
  writeFileSync(
    join(dir, "src", "index.test.ts"),
    `import test from 'node:test'; test('x', () => {});`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "src", "utils.spec.ts"),
    `describe('utils', () => { it('works', () => {}); });`,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  // Should only have index.ts, not test/spec files
  for (const file of brief.sampledFiles) {
    assert.ok(!file.endsWith(".test.ts"), `should not sample ${file}`);
    assert.ok(!file.endsWith(".spec.ts"), `should not sample ${file}`);
  }
});

test("analyzeCodebase: excludes node_modules from sampling", async (t) => {
  const dir = makeTempDir("exclude-nm");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "some-pkg"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), `export const x = 1;`, "utf-8");
  writeFileSync(
    join(dir, "node_modules", "some-pkg", "index.js"),
    `module.exports = {};`,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  for (const file of brief.sampledFiles) {
    assert.ok(!file.includes("node_modules"), `should not sample ${file}`);
  }
});

test("analyzeCodebase: extracts async/await pattern", async (t) => {
  const dir = makeTempDir("async-await");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "api.ts"),
    `
export async function fetchData() {
  const res = await fetch('/api');
  const data = await res.json();
  return data;
}

export async function saveData(data: any) {
  await fetch('/api', { method: 'POST', body: JSON.stringify(data) });
}
    `,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  assert.equal(
    brief.patterns.asyncStyle,
    "async/await",
    "should detect async/await as primary style",
  );
});

test("analyzeCodebase: extracts try/catch error handling", async (t) => {
  const dir = makeTempDir("try-catch");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "handler.ts"),
    `
export function handleError() {
  try {
    doSomething();
  } catch (error) {
    console.error(error);
  }
}

export function anotherHandler() {
  try {
    doOther();
  } catch (e) {
    throw new Error('wrapped');
  }
}
    `,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  assert.equal(
    brief.patterns.errorHandling,
    "try/catch",
    "should detect try/catch as primary error handling",
  );
});

test("analyzeCodebase: extracts camelCase naming convention", async (t) => {
  const dir = makeTempDir("camel-case");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "utils.ts"),
    `
export function getUserById(userId: string) {
  return fetchUser(userId);
}

export function calculateTotalPrice(itemPrices: number[]) {
  return itemPrices.reduce((a, b) => a + b, 0);
}

export function formatDisplayName(firstName: string, lastName: string) {
  return \`\${firstName} \${lastName}\`;
}
    `,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  // camelCase should be detected (getUserById, userId, fetchUser, etc.)
  assert.ok(
    brief.patterns.namingConvention === "camelCase" || brief.patterns.namingConvention === "mixed",
    `should detect camelCase or mixed, got ${brief.patterns.namingConvention}`,
  );
});

test("analyzeCodebase: gracefully handles empty directories", async (t) => {
  const dir = makeTempDir("empty-src");
  t.after(() => cleanup(dir));

  // Create empty src directory
  mkdirSync(join(dir, "src"), { recursive: true });

  const brief = await analyzeCodebase(dir);

  // Should not throw, should return valid structure
  assert.ok(brief.patterns, "should have patterns");
  assert.equal(brief.patterns.asyncStyle, "unknown", "should return unknown for empty");
  assert.equal(brief.patterns.errorHandling, "unknown", "should return unknown for empty");
  assert.equal(brief.patterns.namingConvention, "unknown", "should return unknown for empty");
});

test("analyzeCodebase: returns unknown for unrecognized language patterns (Ruby)", async (t) => {
  // Ruby is detected by LANGUAGE_MAP but not in LANGUAGE_PATTERNS registry
  // This tests the graceful fallback behavior: naming convention still works,
  // but language-specific patterns (async/error) should return "unknown"
  const dir = makeTempDir("ruby-project");
  t.after(() => cleanup(dir));

  // Create a Ruby project with Gemfile (detected as "ruby" in LANGUAGE_MAP)
  writeFileSync(join(dir, "Gemfile"), `source "https://rubygems.org"\ngem "rails"`, "utf-8");

  // Add a Ruby file with patterns that would match JS/TS regexes incorrectly
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(
    join(dir, "lib", "service.rb"),
    `
class UserService
  def fetch_user(user_id)
    user = User.find(user_id)
    user
  rescue ActiveRecord::RecordNotFound => e
    Rails.logger.error("User not found: #{e.message}")
    nil
  end

  def async_task(&block)
    # Ruby doesn't have async/await but has yield and blocks
    Thread.new { yield }
  end
end
    `,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  // Language should be detected as Ruby
  assert.equal(brief.techStack.primaryLanguage, "ruby", "should detect ruby from Gemfile");

  // Language-specific patterns should return "unknown" (not JS/TS patterns)
  assert.equal(
    brief.patterns.asyncStyle,
    "unknown",
    "should return unknown for async style in unrecognized language",
  );
  assert.equal(
    brief.patterns.errorHandling,
    "unknown",
    "should return unknown for error handling in unrecognized language",
  );

  // But naming convention detection should still work (it's universal)
  // The Ruby code uses snake_case (fetch_user, user_id) and camelCase (UserService)
  assert.ok(
    brief.patterns.namingConvention !== "unknown",
    "naming convention should still be detected for unrecognized languages",
  );

  // Evidence should explain why patterns aren't available
  assert.ok(
    brief.patterns.evidence.asyncStyle.some((e) => e.includes("not in pattern registry")),
    "evidence should explain async style is not available",
  );
  assert.ok(
    brief.patterns.evidence.errorHandling.some((e) => e.includes("not in pattern registry")),
    "evidence should explain error handling is not available",
  );
});

// ─── formatCodebaseBrief ────────────────────────────────────────────────────────

test("formatCodebaseBrief: produces markdown output", async (t) => {
  const brief: CodebaseBrief = {
    techStack: {
      primaryLanguage: "javascript/typescript",
      detectedFiles: ["package.json", "tsconfig.json"],
      packageManager: "npm",
      isMonorepo: false,
      hasTests: true,
      hasCI: true,
    },
    moduleStructure: {
      topLevelDirs: ["src", "test"],
      srcSubdirs: ["components", "utils"],
      totalFilesSampled: 5,
    },
    patterns: {
      asyncStyle: "async/await",
      errorHandling: "try/catch",
      namingConvention: "camelCase",
      evidence: {
        asyncStyle: ["src/api.ts: async/await (5 occurrences)"],
        errorHandling: ["src/handler.ts: try/catch (3 occurrences)"],
        namingConvention: ["camelCase: 50 occurrences"],
      },
      fileCounts: {
        asyncAwait: 3,
        promises: 0,
        callbacks: 0,
        tryCatch: 2,
        errorCallbacks: 0,
        resultTypes: 0,
      },
    },
    sampledFiles: ["src/index.ts", "src/utils.ts"],
  };

  const formatted = formatCodebaseBrief(brief);

  assert.ok(formatted.includes("## Tech Stack"), "should have Tech Stack section");
  assert.ok(formatted.includes("## Module Structure"), "should have Module Structure section");
  assert.ok(formatted.includes("## Code Patterns"), "should have Code Patterns section");
  assert.ok(formatted.includes("javascript/typescript"), "should include language");
  assert.ok(formatted.includes("npm"), "should include package manager");
  assert.ok(formatted.includes("async/await"), "should include async style");
  assert.ok(formatted.includes("try/catch"), "should include error handling");
  assert.ok(formatted.includes("camelCase"), "should include naming convention");
  assert.ok(formatted.includes("3 async/await files"), "should include file counts for async style");
  assert.ok(formatted.includes("2 try/catch files"), "should include file counts for error handling");
});

test("formatCodebaseBrief: caps output at 3000 chars", async (t) => {
  // Create a brief with many files to exceed the limit
  const manyFiles = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`);

  const brief: CodebaseBrief = {
    techStack: {
      primaryLanguage: "javascript/typescript",
      detectedFiles: manyFiles,
      packageManager: "npm",
      isMonorepo: false,
      hasTests: true,
      hasCI: true,
    },
    moduleStructure: {
      topLevelDirs: Array.from({ length: 50 }, (_, i) => `dir-${i}`),
      srcSubdirs: Array.from({ length: 50 }, (_, i) => `subdir-${i}`),
      totalFilesSampled: 100,
    },
    patterns: {
      asyncStyle: "async/await",
      errorHandling: "try/catch",
      namingConvention: "camelCase",
      evidence: {
        asyncStyle: manyFiles.map((f) => `${f}: async/await (10 occurrences)`),
        errorHandling: manyFiles.map((f) => `${f}: try/catch (5 occurrences)`),
        namingConvention: ["camelCase: 500 occurrences"],
      },
      fileCounts: {
        asyncAwait: 50,
        promises: 10,
        callbacks: 5,
        tryCatch: 30,
        errorCallbacks: 5,
        resultTypes: 0,
      },
    },
    sampledFiles: manyFiles,
  };

  const formatted = formatCodebaseBrief(brief);

  assert.ok(
    formatted.length <= 3000,
    `should cap at 3000 chars, got ${formatted.length}`,
  );
  if (formatted.length === 3000) {
    assert.ok(formatted.endsWith("..."), "should end with ellipsis when truncated");
  }
});

test("formatCodebaseBrief: handles minimal brief", async (t) => {
  const brief: CodebaseBrief = {
    techStack: {
      primaryLanguage: undefined,
      detectedFiles: [],
      packageManager: undefined,
      isMonorepo: false,
      hasTests: false,
      hasCI: false,
    },
    moduleStructure: {
      topLevelDirs: [],
      srcSubdirs: [],
      totalFilesSampled: 0,
    },
    patterns: {
      asyncStyle: "unknown",
      errorHandling: "unknown",
      namingConvention: "unknown",
      evidence: {
        asyncStyle: [],
        errorHandling: [],
        namingConvention: [],
      },
      fileCounts: {
        asyncAwait: 0,
        promises: 0,
        callbacks: 0,
        tryCatch: 0,
        errorCallbacks: 0,
        resultTypes: 0,
      },
    },
    sampledFiles: [],
  };

  const formatted = formatCodebaseBrief(brief);

  assert.ok(formatted.includes("## Tech Stack"), "should still have sections");
  assert.ok(formatted.includes("**Monorepo:** No"), "should show monorepo status");
  assert.ok(formatted.includes("unknown"), "should show unknown patterns");
});

// ─── Integration: Brief includes PROJECT_FILES markers ──────────────────────────

test("analyzeCodebase: brief includes detected files from PROJECT_FILES", async (t) => {
  const dir = makeTempDir("project-files");
  t.after(() => cleanup(dir));

  // Create several PROJECT_FILES markers
  writeFileSync(join(dir, "package.json"), '{"name": "test"}', "utf-8");
  writeFileSync(join(dir, "tsconfig.json"), '{}', "utf-8");
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "workflows", "ci.yml"),
    "name: CI",
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  assert.ok(
    brief.techStack.detectedFiles.includes("package.json"),
    "should detect package.json",
  );
  assert.ok(
    brief.techStack.hasCI,
    "should detect CI from .github/workflows",
  );
});

test("analyzeCodebase: brief includes sampled file patterns", async (t) => {
  const dir = makeTempDir("sampled-patterns");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, "src"), { recursive: true });

  // Write files with distinct patterns
  writeFileSync(
    join(dir, "src", "async-heavy.ts"),
    `
async function one() { await fetch('/a'); }
async function two() { await fetch('/b'); }
async function three() { await fetch('/c'); }
    `,
    "utf-8",
  );

  const brief = await analyzeCodebase(dir);

  assert.ok(brief.sampledFiles.length > 0, "should have sampled files");
  assert.ok(
    brief.patterns.evidence.asyncStyle.length > 0,
    "should have async style evidence",
  );
});

// ─── aggregatePriorContext ──────────────────────────────────────────────────────

test("aggregatePriorContext: handles missing files gracefully", async (t) => {
  const dir = makeTempDir("no-gsd");
  t.after(() => cleanup(dir));

  // Create .gsd directory but no files
  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const brief = await aggregatePriorContext(dir);

  assert.equal(brief.decisions.totalCount, 0, "should have no decisions");
  assert.equal(brief.requirements.totalCount, 0, "should have no requirements");
  assert.equal(brief.knowledge, "No prior knowledge recorded.", "should indicate no knowledge");
  assert.equal(brief.summaries, "No prior milestone summaries.", "should indicate no summaries");
});

test("aggregatePriorContext: handles completely empty directory", async (t) => {
  const dir = makeTempDir("empty-project");
  t.after(() => cleanup(dir));

  const brief = await aggregatePriorContext(dir);

  assert.equal(brief.decisions.totalCount, 0);
  assert.equal(brief.requirements.totalCount, 0);
  assert.equal(brief.knowledge, "No prior knowledge recorded.");
  assert.equal(brief.summaries, "No prior milestone summaries.");
});

test("aggregatePriorContext: parses DECISIONS.md and groups by scope", async (t) => {
  const dir = makeTempDir("decisions");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "DECISIONS.md"),
    `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |
|---|------|-------|----------|--------|-----------|------------|---------|
| D001 | M001/S01 | pattern | Async style | async/await | Modern standard | Yes | agent |
| D002 | M001/S02 | architecture | Data layer | SQLite | Simple, embedded | No | human |
| D003 | M001/S03 | pattern | Error handling | try/catch | Consistency | Yes | agent |
`,
    "utf-8",
  );

  const brief = await aggregatePriorContext(dir);

  assert.equal(brief.decisions.totalCount, 3, "should parse all decisions");
  assert.equal(brief.decisions.byScope.get("pattern")?.length, 2, "should group pattern scope");
  assert.equal(brief.decisions.byScope.get("architecture")?.length, 1, "should group architecture scope");

  const patternDecisions = brief.decisions.byScope.get("pattern")!;
  assert.equal(patternDecisions[0].id, "D001");
  assert.equal(patternDecisions[0].decision, "Async style");
  assert.equal(patternDecisions[0].choice, "async/await");
});

test("aggregatePriorContext: parses REQUIREMENTS.md and groups by status", async (t) => {
  const dir = makeTempDir("requirements");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "REQUIREMENTS.md"),
    `# Requirements

## Active

### R001 — First requirement
- Status: active
- Description: Something active

### R002 — Second requirement
- Status: active
- Description: Also active

## Validated

### R003 — Validated requirement
- Status: validated
- Description: This was validated

## Deferred

### R004 — Deferred requirement
- Status: deferred
- Description: Postponed for later
`,
    "utf-8",
  );

  const brief = await aggregatePriorContext(dir);

  assert.equal(brief.requirements.totalCount, 4, "should parse all requirements");
  assert.equal(brief.requirements.active.length, 2, "should have 2 active");
  assert.equal(brief.requirements.validated.length, 1, "should have 1 validated");
  assert.equal(brief.requirements.deferred.length, 1, "should have 1 deferred");

  assert.equal(brief.requirements.active[0].id, "R001");
  assert.equal(brief.requirements.active[0].description, "First requirement");
});

test("aggregatePriorContext: loads KNOWLEDGE.md content", async (t) => {
  const dir = makeTempDir("knowledge");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(
    join(dir, ".gsd", "KNOWLEDGE.md"),
    `# Knowledge Base

## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|
| K001 | global | Always use TypeScript | Type safety | manual |

## Patterns

**Pattern X:** Do this for better Y.
`,
    "utf-8",
  );

  const brief = await aggregatePriorContext(dir);

  assert.ok(brief.knowledge.includes("Rules"), "should include knowledge content");
  assert.ok(brief.knowledge.includes("TypeScript"), "should include rule text");
});

test("aggregatePriorContext: truncates oversized content without cutting mid-section", async (t) => {
  const dir = makeTempDir("large-knowledge");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });

  // Create large knowledge file
  const largeContent = `# Knowledge Base

## Section One

${"Lorem ipsum dolor sit amet. ".repeat(100)}

## Section Two

${"More content here. ".repeat(100)}

## Section Three

${"Even more content. ".repeat(100)}
`;

  writeFileSync(join(dir, ".gsd", "KNOWLEDGE.md"), largeContent, "utf-8");

  const brief = await aggregatePriorContext(dir);

  assert.ok(brief.knowledge.length <= 2000, "should truncate to 2K chars");
  assert.ok(brief.knowledge.includes("[truncated]"), "should indicate truncation");
  // Should try to preserve section boundaries
  assert.ok(
    brief.knowledge.includes("## Section"),
    "should keep section headings intact",
  );
});

test("aggregatePriorContext: loads milestone summaries", async (t) => {
  const dir = makeTempDir("milestones");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(dir, ".gsd", "milestones", "M002"), { recursive: true });

  writeFileSync(
    join(dir, ".gsd", "milestones", "M001", "MILESTONE-SUMMARY.md"),
    `# M001 — First Milestone

**Implemented core functionality and established patterns.**

## What Happened
Did stuff.
`,
    "utf-8",
  );

  writeFileSync(
    join(dir, ".gsd", "milestones", "M002", "MILESTONE-SUMMARY.md"),
    `# M002 — Second Milestone

**Extended the system with new features.**

## What Happened
Did more stuff.
`,
    "utf-8",
  );

  const brief = await aggregatePriorContext(dir);

  assert.ok(brief.summaries.includes("M001"), "should include M001 summary");
  assert.ok(brief.summaries.includes("M002"), "should include M002 summary");
  assert.ok(
    brief.summaries.includes("core functionality"),
    "should extract one-liner from M001",
  );
  assert.ok(
    brief.summaries.includes("new features"),
    "should extract one-liner from M002",
  );
});

// ─── formatPriorContextBrief ────────────────────────────────────────────────────

test("formatPriorContextBrief: produces markdown with all sections", async (t) => {
  const brief: PriorContextBrief = {
    decisions: {
      byScope: new Map([
        [
          "pattern",
          [
            { id: "D001", scope: "pattern", decision: "Async", choice: "await", rationale: "Modern" },
          ],
        ],
        [
          "architecture",
          [
            { id: "D002", scope: "architecture", decision: "DB", choice: "SQLite", rationale: "Simple" },
          ],
        ],
      ]),
      totalCount: 2,
    },
    requirements: {
      active: [{ id: "R001", description: "Core feature", status: "active" }],
      validated: [],
      deferred: [],
      totalCount: 1,
    },
    knowledge: "Some knowledge here.",
    summaries: "### M001\nDid things.",
  };

  const formatted = formatPriorContextBrief(brief);

  assert.ok(formatted.includes("## Prior Decisions"), "should have decisions section");
  assert.ok(formatted.includes("## Prior Requirements"), "should have requirements section");
  assert.ok(formatted.includes("## Prior Knowledge"), "should have knowledge section");
  assert.ok(formatted.includes("## Prior Milestone Summaries"), "should have summaries section");
  assert.ok(formatted.includes("D001"), "should include decision ID");
  assert.ok(formatted.includes("R001"), "should include requirement ID");
  assert.ok(formatted.includes("pattern"), "should include scope heading");
});

test("formatPriorContextBrief: handles empty brief", async (t) => {
  const brief: PriorContextBrief = {
    decisions: {
      byScope: new Map(),
      totalCount: 0,
    },
    requirements: {
      active: [],
      validated: [],
      deferred: [],
      totalCount: 0,
    },
    knowledge: "No prior knowledge recorded.",
    summaries: "No prior milestone summaries.",
  };

  const formatted = formatPriorContextBrief(brief);

  assert.ok(formatted.includes("No prior decisions recorded"), "should indicate no decisions");
  assert.ok(formatted.includes("No prior requirements recorded"), "should indicate no requirements");
  assert.ok(formatted.includes("No prior knowledge recorded"), "should indicate no knowledge");
  assert.ok(formatted.includes("No prior milestone summaries"), "should indicate no summaries");
});

test("formatPriorContextBrief: caps total output at 6K chars", async (t) => {
  // Create a brief with lots of content
  const manyDecisions: Array<{
    id: string;
    scope: string;
    decision: string;
    choice: string;
    rationale: string;
  }> = [];
  for (let i = 0; i < 100; i++) {
    manyDecisions.push({
      id: `D${String(i).padStart(3, "0")}`,
      scope: "pattern",
      decision: `Decision number ${i} with some extra text for length`,
      choice: `Choice ${i} with more text to make it longer`,
      rationale: `Rationale ${i}`,
    });
  }

  const manyRequirements: Array<{
    id: string;
    description: string;
    status: "active";
  }> = [];
  for (let i = 0; i < 100; i++) {
    manyRequirements.push({
      id: `R${String(i).padStart(3, "0")}`,
      description: `Requirement ${i} with a long description that takes up space`,
      status: "active",
    });
  }

  const brief: PriorContextBrief = {
    decisions: {
      byScope: new Map([["pattern", manyDecisions]]),
      totalCount: 100,
    },
    requirements: {
      active: manyRequirements,
      validated: [],
      deferred: [],
      totalCount: 100,
    },
    knowledge: "A ".repeat(1000),
    summaries: "B ".repeat(1000),
  };

  const formatted = formatPriorContextBrief(brief);

  assert.ok(formatted.length <= 6000, `should cap at 6000 chars, got ${formatted.length}`);
});

// ─── researchEcosystem ──────────────────────────────────────────────────────────
// Note: Ecosystem research now always returns available: false from the preparation
// phase. Research happens during the discussion using web search tools.

test("researchEcosystem: always returns available: false (research happens during discussion)", async (t) => {
  const dir = makeTempDir("ecosystem-disabled");
  t.after(() => cleanup(dir));

  const brief = await researchEcosystem(["Next.js", "TypeScript"], dir);

  assert.equal(brief.available, false, "should indicate research not available from preparation");
  assert.ok(brief.skippedReason, "should have skipped reason");
  assert.ok(
    brief.skippedReason!.includes("during the discussion"),
    "should explain research happens during discussion",
  );
  assert.deepEqual(brief.queries, [], "should have empty queries");
  assert.deepEqual(brief.findings, [], "should have empty findings");
});

test("researchEcosystem: returns consistent result regardless of tech stack", async (t) => {
  const dir = makeTempDir("ecosystem-consistent");
  t.after(() => cleanup(dir));

  // With tech stack
  const briefWithTech = await researchEcosystem(["React", "Next.js"], dir);
  // Without tech stack
  const briefEmpty = await researchEcosystem([], dir);

  // Both should return the same unavailable result
  assert.equal(briefWithTech.available, false);
  assert.equal(briefEmpty.available, false);
  assert.deepEqual(briefWithTech.queries, []);
  assert.deepEqual(briefEmpty.queries, []);
});

// ─── formatEcosystemBrief ─��─────────────────────────────────────────────────────
// Note: formatEcosystemBrief now returns a simple fixed message since ecosystem
// research always returns unavailable from the preparation phase.

test("formatEcosystemBrief: returns simplified message for discussion-phase research", async (t) => {
  const brief: EcosystemBrief = {
    available: false,
    queries: [],
    findings: [],
    skippedReason: "Ecosystem research is performed during the discussion using web search tools, not during preparation.",
  };

  const formatted = formatEcosystemBrief(brief);

  assert.ok(formatted.includes("## Ecosystem Research"), "should have section header");
  assert.ok(formatted.includes("during the discussion"), "should mention discussion phase");
  assert.ok(formatted.includes("web search tools"), "should mention web search tools");
});

test("formatEcosystemBrief: returns consistent output regardless of brief content", async (t) => {
  // Even if a brief has findings (which shouldn't happen from preparation),
  // the function returns the simplified message
  const briefWithFindings: EcosystemBrief = {
    available: true,
    queries: ["test query"],
    findings: [{ query: "test", title: "Test", snippet: "test", url: "https://example.com" }],
    provider: "tavily",
  };

  const briefEmpty: EcosystemBrief = {
    available: false,
    queries: [],
    findings: [],
    skippedReason: "Test reason",
  };

  const formatted1 = formatEcosystemBrief(briefWithFindings);
  const formatted2 = formatEcosystemBrief(briefEmpty);

  // Both should return the same simplified message
  assert.equal(formatted1, formatted2, "should return consistent output");
  assert.ok(formatted1.includes("## Ecosystem Research"), "should have section header");
});


// ─── runPreparation (Orchestrator) ──────────────────────────────────────────────

/**
 * Mock UI context that captures notifications for testing.
 */
function createMockUI(): PreparationUIContext & { notifications: Array<{ message: string; type?: string }> } {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    notifications,
    notify(message: string, type?: "info" | "warning" | "error" | "success") {
      notifications.push({ message, type });
    },
  };
}

test("runPreparation: returns complete result with all briefs populated", async (t) => {
  const dir = makeTempDir("runprep-full");
  t.after(() => cleanup(dir));

  // Set up a minimal project
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name": "test-project"}', "utf-8");
  writeFileSync(join(dir, "src", "index.ts"), 'export const x = 1;', "utf-8");

  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false, // Skip web research to avoid API key requirement
    discuss_depth: "standard",
  };

  const result = await runPreparation(dir, ui, prefs);

  // Check result structure
  assert.equal(result.enabled, true, "should be enabled");
  assert.ok(result.codebase, "should have codebase");
  assert.ok(result.priorContext, "should have priorContext");
  assert.ok(result.ecosystem, "should have ecosystem");
  assert.ok(typeof result.codebaseBrief === "string", "should have codebaseBrief");
  assert.ok(typeof result.priorContextBrief === "string", "should have priorContextBrief");
  assert.ok(typeof result.ecosystemBrief === "string", "should have ecosystemBrief");
  assert.ok(result.durationMs > 0, "should have positive duration");
  assert.equal(result.ecosystemResearchPerformed, false, "should not have performed ecosystem research");

  // Check TUI progress notifications
  assert.ok(ui.notifications.length > 0, "should have notifications");
  assert.ok(
    ui.notifications.some((n) => n.message.includes("Analyzing codebase")),
    "should show codebase analysis start",
  );
  assert.ok(
    ui.notifications.some((n) => n.message.includes("✓ Analyzed codebase")),
    "should show codebase analysis complete",
  );
  assert.ok(
    ui.notifications.some((n) => n.message.includes("Reviewing prior context")),
    "should show prior context start",
  );
  assert.ok(
    ui.notifications.some((n) => n.message.includes("✓ Reviewed prior context")),
    "should show prior context complete",
  );
});

test("runPreparation: returns early when discuss_preparation is false", async (t) => {
  const dir = makeTempDir("runprep-disabled");
  t.after(() => cleanup(dir));

  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: false,
  };

  const result = await runPreparation(dir, ui, prefs);

  assert.equal(result.enabled, false, "should indicate preparation disabled");
  assert.equal(result.codebaseBrief, "", "should have empty codebase brief");
  assert.equal(result.priorContextBrief, "", "should have empty prior context brief");
  assert.equal(result.ecosystemBrief, "", "should have empty ecosystem brief");
  assert.equal(ui.notifications.length, 0, "should not show any notifications");
  assert.ok(result.durationMs >= 0, "should have non-negative duration");
});

test("runPreparation: ecosystem research always returns unavailable (happens during discussion)", async (t) => {
  const dir = makeTempDir("runprep-no-ecosystem");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name": "test"}', "utf-8");

  const ui = createMockUI();
  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: true, // Even with this enabled, ecosystem research returns unavailable
  };

  const result = await runPreparation(dir, ui, prefs);

  assert.equal(result.enabled, true);
  assert.equal(result.ecosystemResearchPerformed, false, "should not perform ecosystem research from preparation");
  assert.equal(result.ecosystem.available, false);
  assert.ok(
    result.ecosystem.skippedReason?.includes("during the discussion"),
    "should indicate research happens during discussion",
  );

  // Should NOT have ecosystem research notifications (no longer part of preparation)
  assert.ok(
    !ui.notifications.some((n) => n.message.includes("Researching ecosystem")),
    "should not show ecosystem research notification",
  );
});

test("runPreparation: works without UI context (silent mode)", async (t) => {
  const dir = makeTempDir("runprep-silent");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name": "test"}', "utf-8");

  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
  };

  // Pass null for UI to test silent mode
  const result = await runPreparation(dir, null, prefs);

  assert.equal(result.enabled, true, "should work without UI");
  assert.ok(result.codebase, "should have codebase");
  assert.ok(result.priorContext, "should have priorContext");
  assert.ok(result.durationMs > 0, "should have duration");
});

test("runPreparation: completes within 60s requirement (R112)", async (t) => {
  const dir = makeTempDir("runprep-timing");
  t.after(() => cleanup(dir));

  // Create a project with some content to analyze
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name": "test"}', "utf-8");
  writeFileSync(join(dir, "tsconfig.json"), '{}', "utf-8");

  for (let i = 0; i < 10; i++) {
    writeFileSync(
      join(dir, "src", `file${i}.ts`),
      `export async function fn${i}() { await Promise.resolve(); }\n`.repeat(50),
      "utf-8",
    );
  }

  const prefs: PreparationPreferences = {
    discuss_preparation: true,
    discuss_web_research: false,
    discuss_depth: "standard",
  };

  const startTime = performance.now();
  const result = await runPreparation(dir, null, prefs);
  const elapsed = performance.now() - startTime;

  assert.ok(result.durationMs < 60000, `should complete within 60s, took ${result.durationMs}ms`);
  assert.ok(elapsed < 60000, `elapsed time should be under 60s, was ${elapsed}ms`);
});

test("runPreparation: does not throw on any input", async (t) => {
  const dir = makeTempDir("runprep-robust");
  t.after(() => cleanup(dir));

  // Test with completely empty directory
  const prefs: PreparationPreferences = {};

  let result: PreparationResult | undefined;
  let error: unknown;

  try {
    result = await runPreparation(dir, null, prefs);
  } catch (e) {
    error = e;
  }

  assert.equal(error, undefined, "should not throw");
  assert.ok(result, "should return result");
  assert.equal(result!.enabled, true, "should be enabled by default");
});

test("runPreparation: detects framework from config files in codebase brief", async (t) => {
  const dir = makeTempDir("runprep-framework");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name": "test"}', "utf-8");
  writeFileSync(join(dir, "next.config.mjs"), 'export default {};', "utf-8");

  const prefs: PreparationPreferences = {
    discuss_preparation: true,
  };

  const result = await runPreparation(dir, null, prefs);

  // Should detect Next.js config file in codebase analysis
  assert.ok(
    result.codebase.techStack.detectedFiles.includes("next.config.mjs"),
    "should detect next.config.mjs in codebase brief",
  );
  // Ecosystem queries are always empty from preparation (research happens during discussion)
  assert.deepEqual(result.ecosystem.queries, [], "ecosystem queries should be empty from preparation");
});

test("runPreparation: default preferences enable preparation and web research", async (t) => {
  const dir = makeTempDir("runprep-defaults");
  t.after(() => cleanup(dir));

  mkdirSync(join(dir, ".gsd"), { recursive: true });

  const ui = createMockUI();
  const prefs: PreparationPreferences = {}; // All defaults

  const result = await runPreparation(dir, ui, prefs);

  // With defaults, preparation should be enabled
  assert.equal(result.enabled, true, "should be enabled by default");
  // Notifications should be shown
  assert.ok(ui.notifications.length > 0, "should show notifications");
});
