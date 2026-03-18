/**
 * Mechanical Completion — unit tests (ADR-003).
 *
 * Tests deterministic slice/milestone completion using fixture data.
 * Uses node:test + node:assert for consistency with token-profile.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ─── Fixture Helpers ──────────────────────────────────────────────────────────

function createTmpBase(): string {
  const base = join(tmpdir(), `gsd-mech-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function scaffold(base: string, mid: string, sid: string, taskSummaries: Array<{ tid: string; content: string }>) {
  const gsdRoot = join(base, ".gsd");
  const mDir = join(gsdRoot, "milestones", mid);
  const sDir = join(mDir, "slices", sid);
  const tDir = join(sDir, "tasks");
  mkdirSync(tDir, { recursive: true });

  for (const { tid, content } of taskSummaries) {
    writeFileSync(join(tDir, `${tid}-SUMMARY.md`), content, "utf-8");
  }

  return { gsdRoot, mDir, sDir, tDir };
}

function makeTaskSummary(tid: string, opts: {
  oneLiner?: string;
  provides?: string[];
  key_files?: string[];
  key_decisions?: string[];
  verification_result?: string;
}): string {
  const lines: string[] = [
    "---",
    `id: ${tid}`,
    `parent: S01`,
    `milestone: M001`,
  ];
  if (opts.provides?.length) lines.push(`provides:\n${opts.provides.map(p => `  - ${p}`).join("\n")}`);
  if (opts.key_files?.length) lines.push(`key_files:\n${opts.key_files.map(f => `  - ${f}`).join("\n")}`);
  if (opts.key_decisions?.length) lines.push(`key_decisions:\n${opts.key_decisions.map(d => `  - ${d}`).join("\n")}`);
  lines.push(`verification_result: ${opts.verification_result ?? "passed"}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${tid}: Test Task`);
  lines.push("");
  if (opts.oneLiner) lines.push(`**${opts.oneLiner}**`);
  lines.push("");
  lines.push("## What Happened");
  lines.push("");
  lines.push(`Implemented the feature described in ${tid}. This was a significant change that modified multiple files across the codebase to support the new functionality.`);
  lines.push("");
  return lines.join("\n");
}

// ─── Source-level structural tests ────────────────────────────────────────────

const mechanicalSrc = readFileSync(
  join(import.meta.dirname!, "..", "mechanical-completion.ts"),
  "utf-8",
);

test("mechanical-completion: exports mechanicalSliceCompletion", () => {
  assert.ok(
    mechanicalSrc.includes("export async function mechanicalSliceCompletion"),
    "should export mechanicalSliceCompletion",
  );
});

test("mechanical-completion: exports aggregateMilestoneVerification", () => {
  assert.ok(
    mechanicalSrc.includes("export async function aggregateMilestoneVerification"),
    "should export aggregateMilestoneVerification",
  );
});

test("mechanical-completion: exports generateMilestoneSummary", () => {
  assert.ok(
    mechanicalSrc.includes("export async function generateMilestoneSummary"),
    "should export generateMilestoneSummary",
  );
});

test("mechanical-completion: exports appendNewDecisions", () => {
  assert.ok(
    mechanicalSrc.includes("export async function appendNewDecisions"),
    "should export appendNewDecisions",
  );
});

test("mechanical-completion: uses atomicWriteSync for file writes", () => {
  assert.ok(
    mechanicalSrc.includes("atomicWriteSync"),
    "should use atomicWriteSync for safe file writes",
  );
});

test("mechanical-completion: quality gate checks summary length for multi-task slices", () => {
  assert.ok(
    mechanicalSrc.includes("totalContent.length < 200"),
    "should have quality gate for summary content length",
  );
});

test("mechanical-completion: marks slice [x] in roadmap", () => {
  assert.ok(
    mechanicalSrc.includes("markSliceInRoadmap"),
    "should mark slice done in roadmap",
  );
});

test("mechanical-completion: aggregates VERIFY.json files for milestone validation", () => {
  assert.ok(
    mechanicalSrc.includes("resolveTaskJsonFiles") && mechanicalSrc.includes("VERIFY"),
    "should read VERIFY.json files for milestone validation",
  );
});

test("mechanical-completion: deduplicates decisions against existing DECISIONS.md", () => {
  assert.ok(
    mechanicalSrc.includes("existing.includes(d.trim())"),
    "should deduplicate decisions against existing content",
  );
});

test("mechanical-completion: produces VALIDATION.md with verdict frontmatter", () => {
  assert.ok(
    mechanicalSrc.includes("verdict:") && mechanicalSrc.includes("remediation_round: 0"),
    "VALIDATION.md should have verdict and remediation_round frontmatter",
  );
});

// ─── Integration tests with fixture data ──────────────────────────────────────

test("mechanical: slice completion with 2 task summaries produces SUMMARY.md", async () => {
  const base = createTmpBase();
  try {
    const mid = "M001";
    const sid = "S01";

    // Scaffold task summaries
    scaffold(base, mid, sid, [
      {
        tid: "T01",
        content: makeTaskSummary("T01", {
          oneLiner: "Set up project structure",
          provides: ["project-scaffold"],
          key_files: ["src/index.ts", "package.json"],
          verification_result: "passed",
        }),
      },
      {
        tid: "T02",
        content: makeTaskSummary("T02", {
          oneLiner: "Add core API endpoints",
          provides: ["api-endpoints"],
          key_files: ["src/api.ts"],
          key_decisions: ["Used Express over Fastify"],
          verification_result: "passed",
        }),
      },
    ]);

    // Write a roadmap with the slice unchecked
    const roadmapPath = join(base, ".gsd", "milestones", mid, `${mid}-ROADMAP.md`);
    writeFileSync(roadmapPath, `# Roadmap\n\n- [ ] **${sid}: First Slice**\n`, "utf-8");

    // Write a slice plan with Verification section
    const planPath = join(base, ".gsd", "milestones", mid, "slices", sid, `${sid}-PLAN.md`);
    writeFileSync(planPath, `# Plan\n\n## Verification\n\n- Run \`npm test\`\n- Check output\n`, "utf-8");

    // Dynamic import to get the actual module
    const { mechanicalSliceCompletion } = await import("../mechanical-completion.js");
    const ok = await mechanicalSliceCompletion(base, mid, sid);

    assert.ok(ok, "should return true for valid slice completion");

    // Check SUMMARY.md was written
    const summaryPath = join(base, ".gsd", "milestones", mid, "slices", sid, `${sid}-SUMMARY.md`);
    assert.ok(existsSync(summaryPath), "SUMMARY.md should exist");

    const summaryContent = readFileSync(summaryPath, "utf-8");
    assert.ok(summaryContent.includes("T01"), "summary should reference T01");
    assert.ok(summaryContent.includes("T02"), "summary should reference T02");
    assert.ok(summaryContent.includes("verification_result: passed"), "should have passed verification");

    // Check roadmap was updated
    const updatedRoadmap = readFileSync(roadmapPath, "utf-8");
    assert.ok(updatedRoadmap.includes("[x]"), "roadmap should have [x] checkbox");

    // Check UAT was written
    const uatPath = join(base, ".gsd", "milestones", mid, "slices", sid, `${sid}-UAT.md`);
    assert.ok(existsSync(uatPath), "UAT.md should exist");
    const uatContent = readFileSync(uatPath, "utf-8");
    assert.ok(uatContent.includes("npm test"), "UAT should contain verification content");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mechanical: returns false for empty task summaries", async () => {
  const base = createTmpBase();
  try {
    const mid = "M001";
    const sid = "S01";
    scaffold(base, mid, sid, []);

    const { mechanicalSliceCompletion } = await import("../mechanical-completion.js");
    const ok = await mechanicalSliceCompletion(base, mid, sid);
    assert.ok(!ok, "should return false when no summaries exist");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mechanical: returns false for insufficient summary content in multi-task slice", async () => {
  const base = createTmpBase();
  try {
    const mid = "M001";
    const sid = "S01";

    // Two tasks but with very short content (under 200 chars)
    scaffold(base, mid, sid, [
      { tid: "T01", content: "---\nid: T01\nparent: S01\nmilestone: M001\n---\n\n# T01: A\n\n**Short**\n" },
      { tid: "T02", content: "---\nid: T02\nparent: S01\nmilestone: M001\n---\n\n# T02: B\n\n**Brief**\n" },
    ]);

    const { mechanicalSliceCompletion } = await import("../mechanical-completion.js");
    const ok = await mechanicalSliceCompletion(base, mid, sid);
    assert.ok(!ok, "should return false when summaries are too short");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mechanical: milestone verification aggregates VERIFY.json files", async () => {
  const base = createTmpBase();
  try {
    const mid = "M001";
    const sid = "S01";
    const { tDir } = scaffold(base, mid, sid, []);

    // Write VERIFY.json files
    const evidence = {
      schemaVersion: 1,
      taskId: "T01",
      unitId: "M001/S01/T01",
      timestamp: Date.now(),
      passed: true,
      discoverySource: "plan",
      checks: [
        { command: "npm test", exitCode: 0, durationMs: 1500, verdict: "pass", blocking: true },
      ],
    };
    writeFileSync(join(tDir, "T01-VERIFY.json"), JSON.stringify(evidence), "utf-8");

    const evidence2 = { ...evidence, taskId: "T02", passed: false, checks: [
      { command: "npm test", exitCode: 1, durationMs: 500, verdict: "fail", blocking: true },
    ]};
    writeFileSync(join(tDir, "T02-VERIFY.json"), JSON.stringify(evidence2), "utf-8");

    const { aggregateMilestoneVerification } = await import("../mechanical-completion.js");
    const result = await aggregateMilestoneVerification(base, mid);

    assert.equal(result.verdict, "mixed", "should be mixed when some pass and some fail");
    assert.equal(result.checks.length, 2, "should have 2 checks");

    // Check VALIDATION.md was written
    const validationPath = join(base, ".gsd", "milestones", mid, `${mid}-VALIDATION.md`);
    assert.ok(existsSync(validationPath), "VALIDATION.md should exist");
    const validationContent = readFileSync(validationPath, "utf-8");
    assert.ok(validationContent.includes("verdict: mixed"), "should have mixed verdict in frontmatter");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mechanical: milestone summary aggregates slice summaries", async () => {
  const base = createTmpBase();
  try {
    const mid = "M001";

    // Create two slices with summaries
    for (const sid of ["S01", "S02"]) {
      const sDir = join(base, ".gsd", "milestones", mid, "slices", sid);
      mkdirSync(sDir, { recursive: true });
      writeFileSync(
        join(sDir, `${sid}-SUMMARY.md`),
        `---\nid: ${sid}\nprovides:\n  - feature-${sid.toLowerCase()}\nkey_files:\n  - src/${sid.toLowerCase()}.ts\n---\n\n# ${sid}: Slice\n\n**${sid} implemented**\n`,
        "utf-8",
      );
    }

    const { generateMilestoneSummary } = await import("../mechanical-completion.js");
    const content = await generateMilestoneSummary(base, mid);

    assert.ok(content.includes("S01"), "should reference S01");
    assert.ok(content.includes("S02"), "should reference S02");
    assert.ok(content.includes("feature-s01"), "should aggregate provides");
    assert.ok(content.includes("feature-s02"), "should aggregate provides");

    const summaryPath = join(base, ".gsd", "milestones", mid, `${mid}-SUMMARY.md`);
    assert.ok(existsSync(summaryPath), "M##-SUMMARY.md should exist");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("mechanical: decision deduplication skips existing decisions", async () => {
  const base = createTmpBase();
  try {
    const gsdRoot = join(base, ".gsd");
    mkdirSync(gsdRoot, { recursive: true });

    // Write existing decisions
    const decisionsPath = join(gsdRoot, "DECISIONS.md");
    writeFileSync(decisionsPath, "# Decisions\n\n- Used TypeScript for type safety\n", "utf-8");

    const { appendNewDecisions } = await import("../mechanical-completion.js");

    // Call with one existing and one new decision
    const mockSummaries = [
      {
        frontmatter: {
          id: "T01", parent: "S01", milestone: "M001",
          provides: [], requires: [], affects: [],
          key_files: [], key_decisions: ["Used TypeScript for type safety", "Chose Express over Koa"],
          patterns_established: [], drill_down_paths: [], observability_surfaces: [],
          duration: "", verification_result: "passed", completed_at: "", blocker_discovered: false,
        },
        title: "T01", oneLiner: "", whatHappened: "", deviations: "", filesModified: [],
      },
    ];

    await appendNewDecisions(base, mockSummaries as any);

    const updated = readFileSync(decisionsPath, "utf-8");
    assert.ok(updated.includes("Chose Express over Koa"), "should append new decision");
    // The existing decision should not be duplicated
    const matches = updated.match(/Used TypeScript for type safety/g);
    assert.equal(matches?.length, 1, "should not duplicate existing decision");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
