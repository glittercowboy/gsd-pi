/**
 * Tests for /gsd review command
 *
 * Covers pure functions only — handler integration tests are not practical
 * without a full pi ExtensionAPI stub.
 */

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseReviewArgs,
  buildReviewOutputPath,
  resolveReviewArtifacts,
  buildReviewPrompt,
} from "../commands-review.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-review-test-"));
  tmpDirs.push(dir);
  return dir;
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tmpDirs.length = 0;
});

// ─── parseReviewArgs ──────────────────────────────────────────────────────────

describe("parseReviewArgs", () => {
  test("returns null milestoneId for empty string", () => {
    const result = parseReviewArgs("");
    assert.strictEqual(result.milestoneId, null);
  });

  test("returns null milestoneId for whitespace-only string", () => {
    const result = parseReviewArgs("   ");
    assert.strictEqual(result.milestoneId, null);
  });

  test("extracts milestoneId from plain argument", () => {
    const result = parseReviewArgs("M001");
    assert.strictEqual(result.milestoneId, "M001");
  });

  test("trims surrounding whitespace from milestoneId", () => {
    const result = parseReviewArgs("  M002  ");
    assert.strictEqual(result.milestoneId, "M002");
  });

  test("handles milestone IDs with leading zeros", () => {
    const result = parseReviewArgs("M010");
    assert.strictEqual(result.milestoneId, "M010");
  });

  test("extracts only the first token when multiple words are given", () => {
    const result = parseReviewArgs("M001 extra-stuff");
    assert.strictEqual(result.milestoneId, "M001");
  });

  test("returns null for milestoneId containing shell-unsafe characters", () => {
    const result = parseReviewArgs("M001; rm -rf ~");
    assert.strictEqual(result.milestoneId, null);
  });

  test("returns null for milestoneId with dollar sign", () => {
    const result = parseReviewArgs("$ENV_VAR");
    assert.strictEqual(result.milestoneId, null);
  });
});

// ─── buildReviewOutputPath ────────────────────────────────────────────────────

describe("buildReviewOutputPath", () => {
  test("builds correct output path for milestone", () => {
    const result = buildReviewOutputPath("/project/.gsd/milestones/M001", "M001");
    assert.strictEqual(result, "/project/.gsd/milestones/M001/M001-REVIEWS.md");
  });

  test("builds correct output path with descriptor-suffixed dir", () => {
    const result = buildReviewOutputPath(
      "/project/.gsd/milestones/M002-AUTH-SYSTEM",
      "M002",
    );
    assert.strictEqual(result, "/project/.gsd/milestones/M002-AUTH-SYSTEM/M002-REVIEWS.md");
  });
});

// ─── resolveReviewArtifacts ───────────────────────────────────────────────────

describe("resolveReviewArtifacts", () => {
  test("returns all nulls and missingRequired when milestone dir is empty", () => {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, "M001"), { recursive: true });
    const result = resolveReviewArtifacts(join(tmpDir, "M001"), "M001");

    assert.strictEqual(result.roadmapPath, null);
    assert.strictEqual(result.contextPath, null);
    assert.strictEqual(result.researchPath, null);
    assert.deepStrictEqual(result.missingRequired, ["M001-ROADMAP.md"]);
  });

  test("resolves roadmap when M001-ROADMAP.md exists", () => {
    const tmpDir = makeTmpDir();
    const mDir = join(tmpDir, "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-ROADMAP.md"), "# Milestone Roadmap");

    const result = resolveReviewArtifacts(mDir, "M001");
    assert.ok(result.roadmapPath !== null, "roadmapPath should be resolved");
    assert.ok(result.roadmapPath!.endsWith("M001-ROADMAP.md"));
    assert.deepStrictEqual(result.missingRequired, []);
  });

  test("resolves optional context when M001-CONTEXT.md exists", () => {
    const tmpDir = makeTmpDir();
    const mDir = join(tmpDir, "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(mDir, "M001-CONTEXT.md"), "# Context");

    const result = resolveReviewArtifacts(mDir, "M001");
    assert.ok(result.contextPath !== null, "contextPath should be resolved");
    assert.ok(result.contextPath!.endsWith("M001-CONTEXT.md"));
  });

  test("resolves optional research when M001-RESEARCH.md exists", () => {
    const tmpDir = makeTmpDir();
    const mDir = join(tmpDir, "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-ROADMAP.md"), "# Roadmap");
    writeFileSync(join(mDir, "M001-RESEARCH.md"), "# Research");

    const result = resolveReviewArtifacts(mDir, "M001");
    assert.ok(result.researchPath !== null, "researchPath should be resolved");
    assert.ok(result.researchPath!.endsWith("M001-RESEARCH.md"));
  });

  test("returns null for absent optional artifacts without adding to missingRequired", () => {
    const tmpDir = makeTmpDir();
    const mDir = join(tmpDir, "M001");
    mkdirSync(mDir, { recursive: true });
    writeFileSync(join(mDir, "M001-ROADMAP.md"), "# Roadmap");

    const result = resolveReviewArtifacts(mDir, "M001");
    assert.strictEqual(result.contextPath, null);
    assert.strictEqual(result.researchPath, null);
    // Only ROADMAP is required — optional files don't go in missingRequired
    assert.deepStrictEqual(result.missingRequired, []);
  });
});

// ─── buildReviewPrompt ────────────────────────────────────────────────────────

describe("buildReviewPrompt", () => {
  test("includes milestoneId in the prompt header", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth System",
      outputPath: "/project/.gsd/milestones/M001/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap content",
      contextContent: null,
      researchContent: null,
      projectName: "TestProject",
    });

    assert.ok(prompt.includes("M001"), "prompt must include milestone ID");
    assert.ok(prompt.includes("Auth System"), "prompt must include milestone name");
  });

  test("includes roadmap content in the prompt", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "## Unique Roadmap Marker ABC123",
      contextContent: null,
      researchContent: null,
      projectName: "MyProject",
    });

    assert.ok(
      prompt.includes("Unique Roadmap Marker ABC123"),
      "prompt must include roadmap content",
    );
  });

  test("includes context section when contextContent is provided", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: "## Unique Context Marker XYZ789",
      researchContent: null,
      projectName: "MyProject",
    });

    assert.ok(
      prompt.includes("Unique Context Marker XYZ789"),
      "prompt must include context content when provided",
    );
  });

  test("includes research section when researchContent is provided", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: null,
      researchContent: "## Unique Research Marker QRS456",
      projectName: "MyProject",
    });

    assert.ok(
      prompt.includes("Unique Research Marker QRS456"),
      "prompt must include research content when provided",
    );
  });

  test("includes the output path in the prompt", () => {
    const outputPath = "/project/.gsd/milestones/M001/M001-REVIEWS.md";
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath,
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: null,
      researchContent: null,
      projectName: "MyProject",
    });

    assert.ok(prompt.includes(outputPath), "prompt must include the output file path");
  });

  test("includes review instructions in the prompt", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: null,
      researchContent: null,
      projectName: "MyProject",
    });

    // Should contain instructions for external CLI invocation
    assert.ok(
      prompt.includes("gemini") || prompt.includes("external"),
      "prompt must include external reviewer instructions",
    );
  });

  test("includes REVIEWS.md output format instructions", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: null,
      researchContent: null,
      projectName: "MyProject",
    });

    assert.ok(
      prompt.includes("REVIEWS.md") || prompt.includes("M001-REVIEWS.md"),
      "prompt must mention the output file",
    );
    assert.ok(
      prompt.includes("Consensus") || prompt.includes("consensus"),
      "prompt must include consensus summary instructions",
    );
  });

  test("recommends fast models for external CLI invocations", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: null,
      researchContent: null,
      projectName: "MyProject",
    });

    assert.ok(
      prompt.includes("gemini-2.0-flash"),
      "prompt must recommend gemini-2.0-flash for Gemini reviews",
    );
    assert.ok(
      prompt.includes("o4-mini"),
      "prompt must recommend o4-mini for Codex reviews",
    );
  });

  test("instructs agent to display REVIEWS.md content after writing", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: null,
      researchContent: null,
      projectName: "MyProject",
    });

    assert.ok(
      prompt.includes("full contents") || prompt.includes("output the"),
      "prompt must instruct agent to display the REVIEWS.md content",
    );
  });

  test("offers next-action options including steer and discuss", () => {
    const prompt = buildReviewPrompt({
      milestoneId: "M001",
      milestoneName: "Auth",
      outputPath: "/out/M001-REVIEWS.md",
      relativeOutputPath: ".gsd/milestones/M001/M001-REVIEWS.md",
      roadmapContent: "# Roadmap",
      contextContent: null,
      researchContent: null,
      projectName: "MyProject",
    });

    assert.ok(
      prompt.includes("/gsd steer update"),
      "prompt must contain the steer action-menu option",
    );
    assert.ok(
      prompt.includes("/gsd discuss"),
      "prompt must contain the discuss action-menu option",
    );
  });
});
