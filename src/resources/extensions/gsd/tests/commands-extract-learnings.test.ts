import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  parseExtractLearningsArgs,
  buildLearningsOutputPath,
  resolvePhaseArtifacts,
  buildExtractLearningsPrompt,
  buildExtractionStepsBlock,
  buildFrontmatter,
  extractProjectName,
} from "../commands-extract-learnings.js";

// ─── parseExtractLearningsArgs ────────────────────────────────────────────────

describe("parseExtractLearningsArgs", () => {
  it("parses a milestone ID", () => {
    const result = parseExtractLearningsArgs("M001");
    assert.deepEqual(result, { milestoneId: "M001" });
  });

  it("returns null milestoneId for empty string", () => {
    const result = parseExtractLearningsArgs("");
    assert.deepEqual(result, { milestoneId: null });
  });

  it("returns null milestoneId for whitespace-only string", () => {
    const result = parseExtractLearningsArgs("  ");
    assert.deepEqual(result, { milestoneId: null });
  });

  it("trims whitespace from milestone ID", () => {
    const result = parseExtractLearningsArgs("  M002  ");
    assert.deepEqual(result, { milestoneId: "M002" });
  });
});

// ─── buildLearningsOutputPath ─────────────────────────────────────────────────

describe("buildLearningsOutputPath", () => {
  it("builds the correct output path", () => {
    const result = buildLearningsOutputPath("/base/.gsd/milestones/M001", "M001");
    assert.equal(result, "/base/.gsd/milestones/M001/M001-LEARNINGS.md");
  });

  it("builds path for different milestone ID", () => {
    const result = buildLearningsOutputPath("/project/.gsd/milestones/M005", "M005");
    assert.equal(result, "/project/.gsd/milestones/M005/M005-LEARNINGS.md");
  });
});

// ─── resolvePhaseArtifacts ────────────────────────────────────────────────────

describe("resolvePhaseArtifacts", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = join(tmpdir(), `gsd-learnings-test-${randomUUID()}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("finds required ROADMAP and SUMMARY when both present", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# M001 Roadmap content", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# M001 Summary content", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.roadmap, join(tmpBase, "M001-ROADMAP.md"));
    assert.equal(result.summary, join(tmpBase, "M001-SUMMARY.md"));
    assert.deepEqual(result.missingRequired, []);
  });

  it("reports missing ROADMAP as missingRequired (regression for #4429)", () => {
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.ok(result.missingRequired.includes("M001-ROADMAP.md"));
    assert.equal(result.roadmap, null);
  });

  it("does NOT require M001-PLAN.md (regression for #4429 — milestones use ROADMAP)", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.ok(
      !result.missingRequired.includes("M001-PLAN.md"),
      "PLAN.md must not be demanded at milestone scope",
    );
    assert.deepEqual(result.missingRequired, []);
  });

  it("reports missing SUMMARY as missingRequired", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.ok(result.missingRequired.includes("M001-SUMMARY.md"));
    assert.equal(result.summary, null);
  });

  it("reports both required files missing when neither present", () => {
    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.missingRequired.length, 2);
    assert.ok(result.missingRequired.includes("M001-ROADMAP.md"));
    assert.ok(result.missingRequired.includes("M001-SUMMARY.md"));
  });

  it("finds optional VERIFICATION when present", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    writeFileSync(join(tmpBase, "M001-VERIFICATION.md"), "# Verification", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.verification, join(tmpBase, "M001-VERIFICATION.md"));
  });

  it("returns null for optional VERIFICATION when absent", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.verification, null);
  });

  it("finds optional UAT when present", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");
    writeFileSync(join(tmpBase, "M001-UAT.md"), "# UAT", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.uat, join(tmpBase, "M001-UAT.md"));
  });

  it("returns null for optional UAT when absent, no error", () => {
    writeFileSync(join(tmpBase, "M001-ROADMAP.md"), "# Roadmap", "utf-8");
    writeFileSync(join(tmpBase, "M001-SUMMARY.md"), "# Summary", "utf-8");

    const result = resolvePhaseArtifacts(tmpBase, "M001");
    assert.equal(result.uat, null);
    assert.deepEqual(result.missingRequired, []);
  });
});

// ─── buildExtractLearningsPrompt ──────────────────────────────────────────────

describe("buildExtractLearningsPrompt", () => {
  it("includes milestoneId and outputPath", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/project/.gsd/milestones/M001/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap content",
      summaryContent: "# Summary content",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject",
    });

    assert.ok(result.includes("M001"));
    assert.ok(result.includes("/project/.gsd/milestones/M001/M001-LEARNINGS.md"));
  });

  it("includes all 4 learning categories", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject",
    });

    assert.ok(result.includes("Decisions"));
    assert.ok(result.includes("Lessons"));
    assert.ok(result.includes("Patterns"));
    assert.ok(result.includes("Surprises"));
  });

  it("includes roadmap and summary content", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "ROADMAP_CONTENT_UNIQUE_123",
      summaryContent: "SUMMARY_CONTENT_UNIQUE_456",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject",
    });

    assert.ok(result.includes("ROADMAP_CONTENT_UNIQUE_123"));
    assert.ok(result.includes("SUMMARY_CONTENT_UNIQUE_456"));
  });

  it("includes optional artifacts when present", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: "VERIFICATION_UNIQUE_789",
      uatContent: "UAT_UNIQUE_012",
      missingArtifacts: [],
      projectName: "MyProject",
    });

    assert.ok(result.includes("VERIFICATION_UNIQUE_789"));
    assert.ok(result.includes("UAT_UNIQUE_012"));
  });

  it("lists missing artifacts when present", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: ["M001-VERIFICATION.md"],
      projectName: "MyProject",
    });

    assert.ok(result.includes("M001-VERIFICATION.md"));
  });

  it("references capture_thought as the memory-store mirror write (Option A' dual-write)", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject",
    });

    assert.ok(
      result.includes("capture_thought"),
      "prompt must instruct the LLM to mirror durable insights into the memory store via capture_thought",
    );
  });

  it("does NOT reference phantom gsd_graph tool (regression for #4429)", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject",
    });

    assert.ok(
      !result.includes("gsd_graph"),
      "prompt must not advertise the non-existent gsd_graph tool",
    );
  });

  it("source-attribution example references ROADMAP.md, not PLAN.md (regression for #4429)", () => {
    const result = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "MyProject",
    });

    assert.ok(result.includes("M001-ROADMAP.md/Architecture Decisions"));
    assert.ok(!result.includes("M001-PLAN.md/Architecture Decisions"));
  });
});

// ─── buildFrontmatter ─────────────────────────────────────────────────────────

describe("buildFrontmatter", () => {
  it("starts with --- and ends with ---", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      projectName: "MyProject",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 0, lessons: 0, patterns: 0, surprises: 0 },
      missingArtifacts: [],
    });

    assert.ok(result.startsWith("---\n"));
    assert.ok(result.endsWith("---"));
  });

  it("includes required fields", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Test Milestone",
      projectName: "MyProject",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 3, lessons: 2, patterns: 1, surprises: 0 },
      missingArtifacts: [],
    });

    assert.ok(result.includes("phase:"));
    assert.ok(result.includes("phase_name:"));
    assert.ok(result.includes("project:"));
    assert.ok(result.includes("generated:"));
    assert.ok(result.includes("counts:"));
    assert.ok(result.includes("missing_artifacts:"));
  });

  it("includes milestoneId as phase value", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Auth System",
      projectName: "MyApp",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 0, lessons: 0, patterns: 0, surprises: 0 },
      missingArtifacts: [],
    });

    assert.ok(result.includes("M001"));
    assert.ok(result.includes("Auth System"));
    assert.ok(result.includes("MyApp"));
    assert.ok(result.includes("2026-04-15T10:00:00Z"));
  });

  it("includes missing artifacts list", () => {
    const result = buildFrontmatter({
      milestoneId: "M001",
      milestoneName: "Test",
      projectName: "Proj",
      generatedAt: "2026-04-15T10:00:00Z",
      counts: { decisions: 0, lessons: 0, patterns: 0, surprises: 0 },
      missingArtifacts: ["M001-VERIFICATION.md", "M001-UAT.md"],
    });

    assert.ok(result.includes("M001-VERIFICATION.md"));
    assert.ok(result.includes("M001-UAT.md"));
  });
});

// ─── extractProjectName ───────────────────────────────────────────────────────

describe("extractProjectName", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = join(tmpdir(), `gsd-projname-test-${randomUUID()}`);
    mkdirSync(join(tmpBase, ".gsd"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("reads name from PROJECT.md frontmatter", () => {
    writeFileSync(
      join(tmpBase, ".gsd", "PROJECT.md"),
      "---\nname: My Cool Project\nversion: 1\n---\n# Project\n",
      "utf-8",
    );

    const result = extractProjectName(tmpBase);
    assert.equal(result, "My Cool Project");
  });

  it("falls back to directory name when PROJECT.md absent", () => {
    const result = extractProjectName(tmpBase);
    // Should return the last path segment of tmpBase
    assert.equal(result, tmpBase.split("/").at(-1));
  });

  it("falls back to directory name when PROJECT.md has no name field", () => {
    writeFileSync(
      join(tmpBase, ".gsd", "PROJECT.md"),
      "---\nversion: 1\n---\n# Project\n",
      "utf-8",
    );

    const result = extractProjectName(tmpBase);
    assert.equal(result, tmpBase.split("/").at(-1));
  });
});

// ─── buildExtractionStepsBlock ────────────────────────────────────────────────
//
// The steps block is the single source of truth for how learnings are routed
// into KNOWLEDGE.md and the DECISIONS DB. Both the manual /gsd extract-learnings
// path and the auto complete-milestone path render it verbatim, so every
// structural assertion below protects both paths at once.

describe("buildExtractionStepsBlock", () => {
  const ctx = {
    milestoneId: "M042",
    outputPath: "/project/.gsd/milestones/M042/M042-LEARNINGS.md",
    relativeOutputPath: ".gsd/milestones/M042/M042-LEARNINGS.md",
  };

  it("declares itself as the structured extraction procedure", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Structured Learnings Extraction"));
  });

  it("instructs the LLM to write LEARNINGS.md at the given relative path", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes(ctx.relativeOutputPath));
    assert.ok(block.includes("YAML frontmatter"));
  });

  it("covers all four extraction categories", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Decisions"));
    assert.ok(block.includes("Lessons"));
    assert.ok(block.includes("Patterns"));
    assert.ok(block.includes("Surprises"));
  });

  it("requires a Source attribution for every item", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Source:"));
    assert.ok(block.includes("M042-ROADMAP.md"));
  });

  // ─── Removed by ADR-013 step 6 cutover ────────────────────────────────────
  //
  // The following nine tests asserted structural properties of the legacy
  // KNOWLEDGE.md table scaffolding (Rules/Patterns/Lessons headers, P###/L###
  // row templates, em-dash placeholders, append-only semantics, "missing file"
  // template) and the gsd_save_decision call-out (parameter list, "never edit
  // DECISIONS.md" prohibition). The cutover replaced both surfaces with
  // capture_thought calls into the memories table; the extraction steps no
  // longer reference KNOWLEDGE.md tables or gsd_save_decision at all, so each
  // assertion is now structurally false.
  //
  // The replacement assertions ("removes the legacy KNOWLEDGE.md table append
  // step", "removes the gsd_save_decision call", "requires structuredFields
  // payload on architecture-category memories") below cover the inverse
  // contract.
  //
  // Per ADR-013 cutover criterion: "No regression test in tests/ is silenced
  // or removed without an explicit rationale comment in the diff." That
  // criterion is satisfied by this comment block.

  it("keeps Surprises milestone-local (not persisted to memory store, no MCP call)", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(block.includes("Surprises stay only in LEARNINGS.md"));
  });

  it("enforces a deduplication rule across all persistence steps", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(/deduplication/i.test(block) || /dedup/i.test(block));
    assert.ok(/semantically equivalent/i.test(block));
    assert.ok(/skip/i.test(block));
  });

  it("instructs capture_thought as the sole persistence path for Patterns, Lessons, and Decisions (ADR-013 step 6 cutover)", () => {
    const block = buildExtractionStepsBlock(ctx);
    // Each of the three persistence steps must call capture_thought.
    const captureThoughtMatches = block.match(/capture_thought/g) ?? [];
    assert.ok(
      captureThoughtMatches.length >= 3,
      `expected at least 3 capture_thought references (Patterns + Lessons + Decisions); got ${captureThoughtMatches.length}`,
    );
    // Required category vocabulary for the three captures.
    assert.ok(/category:\s*"pattern"/.test(block), "Patterns must use category: \"pattern\"");
    assert.ok(/category:\s*"gotcha"/.test(block), "Lessons must reference category: \"gotcha\"");
    assert.ok(/category:\s*"architecture"/.test(block), "Decisions must use category: \"architecture\"");
    // Milestone scope must be threaded through.
    assert.ok(block.includes(`scope: "${ctx.milestoneId}"`), "capture_thought calls must scope to the milestone ID");
  });

  it("removes the legacy KNOWLEDGE.md table append step (ADR-013 step 6 cutover)", () => {
    const block = buildExtractionStepsBlock(ctx);
    // ADR-013 Cutover: memories table is the single source of truth.
    // KNOWLEDGE.md is no longer written by the extraction flow.
    assert.ok(!block.includes("| # | Scope | Rule | Why | Added |"), "Rules table scaffolding must be removed");
    assert.ok(!block.includes("| # | Pattern | Where | Notes |"), "Patterns table scaffolding must be removed");
    assert.ok(!block.includes("| # | What Happened | Root Cause | Fix | Scope |"), "Lessons table scaffolding must be removed");
    assert.ok(!/\| P<NNN>/.test(block), "Pattern row template must be removed");
    assert.ok(!/\| L<NNN>/.test(block), "Lesson row template must be removed");
    assert.ok(!block.includes(".gsd/KNOWLEDGE.md"), "extraction flow must not reference KNOWLEDGE.md as a write target");
  });

  it("removes the gsd_save_decision call (ADR-013 step 6 cutover)", () => {
    const block = buildExtractionStepsBlock(ctx);
    // ADR-013 Cutover: decisions are now persisted via capture_thought with
    // category=architecture and a structuredFields payload that preserves the
    // gsd_save_decision schema. The legacy MCP tool is no longer called from
    // the extraction flow.
    assert.ok(!block.includes("gsd_save_decision"), "gsd_save_decision must no longer appear in extraction steps");
  });

  it("requires structuredFields payload on architecture-category memories (ADR-013 lossless projection)", () => {
    const block = buildExtractionStepsBlock(ctx);
    // ADR-013 Cutover: architecture-category memories must carry structured
    // fields so projection back to a human-visible decisions register stays
    // lossless. The Decisions persistence step must instruct the LLM to set
    // structuredFields with the original gsd_save_decision schema fields.
    assert.ok(/structuredFields/.test(block), "Decisions persistence step must instruct structuredFields use");
    assert.ok(/scope/i.test(block) && /decision/i.test(block) && /choice/i.test(block) && /rationale/i.test(block),
      "structuredFields must enumerate the preserved decision fields");
  });

  it("does NOT reference the non-existent gsd_graph tool (#4429 regression)", () => {
    const block = buildExtractionStepsBlock(ctx);
    assert.ok(!block.includes("gsd_graph"));
  });

  it("substitutes the milestone ID into every placeholder callout", () => {
    const block = buildExtractionStepsBlock({
      milestoneId: "M999",
      outputPath: "/p/.gsd/milestones/M999/M999-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M999/M999-LEARNINGS.md",
    });
    assert.ok(!block.includes("M042"));
    assert.ok(block.includes("M999"));
  });
});

// ─── buildExtractLearningsPrompt composition ──────────────────────────────────

describe("buildExtractLearningsPrompt composes the steps block", () => {
  it("embeds the exact buildExtractionStepsBlock output for the same context", () => {
    const shared = {
      milestoneId: "M007",
      outputPath: "/p/.gsd/milestones/M007/M007-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M007/M007-LEARNINGS.md",
    };
    const expected = buildExtractionStepsBlock(shared);
    const prompt = buildExtractLearningsPrompt({
      ...shared,
      milestoneName: "Composition",
      roadmapContent: "# Roadmap body",
      summaryContent: "# Summary body",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "TestProj",
    });

    assert.ok(prompt.includes(expected));
  });

  it("no longer contains the orphan-file disclaimer from the previous revision", () => {
    const prompt = buildExtractLearningsPrompt({
      milestoneId: "M001",
      milestoneName: "Test",
      outputPath: "/out/M001-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-LEARNINGS.md",
      roadmapContent: "# Roadmap",
      summaryContent: "# Summary",
      verificationContent: null,
      uatContent: null,
      missingArtifacts: [],
      projectName: "P",
    });

    assert.ok(!prompt.includes("no automated pipeline currently consumes it"));
  });
});

// ─── complete-milestone.md loadPrompt round-trip ─────────────────────────────

describe("complete-milestone loadPrompt round-trip (#4429)", () => {
  it("substitutes {{extractLearningsSteps}} end-to-end via prompt-loader", async () => {
    const { loadPrompt } = await import("../prompt-loader.js");
    const stepsBlock = buildExtractionStepsBlock({
      milestoneId: "M123",
      outputPath: "/p/.gsd/milestones/M123/M123-LEARNINGS.md",
      relativeOutputPath: ".gsd/milestones/M123/M123-LEARNINGS.md",
    });

    const rendered = loadPrompt("complete-milestone", {
      workingDirectory: "/p",
      milestoneId: "M123",
      milestoneTitle: "Test Milestone",
      roadmapPath: ".gsd/milestones/M123/M123-ROADMAP.md",
      inlinedContext: "(inlined context stub)",
      milestoneSummaryPath: "/p/.gsd/milestones/M123/M123-SUMMARY.md",
      extractLearningsSteps: stepsBlock,
    });

    // Placeholder must be gone — real content must be in.
    assert.ok(!rendered.includes("{{extractLearningsSteps}}"));
    assert.ok(rendered.includes("Structured Learnings Extraction"));
    // ADR-013 cutover: gsd_save_decision is no longer in the rendered block;
    // the new persistence path is capture_thought with structuredFields.
    assert.ok(rendered.includes("capture_thought"));
    assert.ok(rendered.includes("M123"));
  });
});

// ─── complete-milestone.md template wiring ────────────────────────────────────

describe("complete-milestone.md template wiring (#4429)", () => {
  const promptPath = join(
    __dirname,
    "..",
    "prompts",
    "complete-milestone.md",
  );

  it("declares the {{extractLearningsSteps}} placeholder", () => {
    const content = readFileSync(promptPath, "utf-8");
    assert.ok(content.includes("{{extractLearningsSteps}}"));
  });

  it("no longer contains the deprecated ad-hoc KNOWLEDGE.md step", () => {
    const content = readFileSync(promptPath, "utf-8");
    assert.ok(
      !content.includes("Review all slice summaries for cross-cutting lessons, patterns, or gotchas"),
      "the pre-#4429 one-sentence step 12 must be removed",
    );
  });

  it("keeps the milestone-completion commit instruction after the placeholder", () => {
    const content = readFileSync(promptPath, "utf-8");
    const placeholderIdx = content.indexOf("{{extractLearningsSteps}}");
    const commitIdx = content.indexOf("Do not commit manually");
    assert.ok(placeholderIdx > 0);
    assert.ok(commitIdx > placeholderIdx, "commit instruction must come after extraction block");
  });
});
