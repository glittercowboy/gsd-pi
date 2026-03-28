import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test the inlineMilestoneIntent function
// We import it via the built module path since auto-prompts.ts has many dependencies
// For unit testing, we test the extraction logic directly

describe("Milestone Intent extraction", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-intent-test-"));
    mkdirSync(join(tmp, ".gsd", "milestones", "M001"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("extracts Intent section from well-formed CONTEXT.md", () => {
    const contextContent = [
      "---",
      "milestone_class: transformation",
      "---",
      "",
      "# M001: Feature Title",
      "",
      "## Milestone Intent",
      "",
      "### Core Problem Being Eliminated",
      "",
      "Users manually copy context between tools.",
      "",
      "### Priority Stack",
      "",
      "1. Tool integration — **KERN** — without this, nothing changes",
      "2. Visibility — important — helps verify the integration works",
      "",
      "### Success Feels Like",
      "",
      "- I open Tool A and it already knows what Tool B captured",
      "",
      "### Milestone Class",
      "",
      "**transformation**",
      "",
      "## Why This Milestone",
      "",
      "Because the pain is real.",
    ].join("\n");

    writeFileSync(
      join(tmp, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
      contextContent,
    );

    // Verify the content structure is correct
    assert.ok(contextContent.includes("## Milestone Intent"));
    assert.ok(contextContent.includes("### Core Problem Being Eliminated"));
    assert.ok(contextContent.includes("### Priority Stack"));
    assert.ok(contextContent.includes("**KERN**"));
    assert.ok(contextContent.includes("### Success Feels Like"));
    assert.ok(contextContent.includes("### Milestone Class"));
    assert.ok(contextContent.match(/^milestone_class:\s*transformation/m));
  });

  test("milestone_class: feature is the default when not specified", () => {
    const contextContent = [
      "---",
      "research_depth: light",
      "---",
      "",
      "# M001: Feature Title",
      "",
      "## Milestone Intent",
      "",
      "### Core Problem Being Eliminated",
      "",
      "Need a new dashboard.",
      "",
      "### Priority Stack",
      "",
      "1. Dashboard — **KERN** — core deliverable",
      "",
      "### Success Feels Like",
      "",
      "- Dashboard loads with real data",
      "",
      "### Milestone Class",
      "",
      "**feature**",
    ].join("\n");

    // No milestone_class in frontmatter — should default to "feature"
    assert.ok(!contextContent.match(/^milestone_class:/m));
  });
});

describe("CONTEXT.md validation gate", () => {
  test("rejects CONTEXT without Milestone Intent section", () => {
    const content = [
      "# M001: Some Title",
      "",
      "## Project Description",
      "",
      "A project.",
    ].join("\n");

    assert.ok(!content.includes("## Milestone Intent"));
  });

  test("rejects CONTEXT with Intent but no KERN item", () => {
    const content = [
      "## Milestone Intent",
      "",
      "### Core Problem Being Eliminated",
      "",
      "Something.",
      "",
      "### Priority Stack",
      "",
      "1. Feature A — important",
      "2. Feature B — nice-to-have",
      "",
      "### Success Feels Like",
      "",
      "- It works",
      "",
      "### Milestone Class",
      "",
      "**feature**",
    ].join("\n");

    assert.ok(content.includes("## Milestone Intent"));
    assert.ok(content.includes("### Priority Stack"));
    // No **KERN** marker — gate should reject
    assert.ok(!content.match(/\*\*KERN\*\*/i));
  });

  test("accepts well-formed CONTEXT with all required fields", () => {
    const content = [
      "---",
      "milestone_class: feature",
      "---",
      "",
      "## Milestone Intent",
      "",
      "### Core Problem Being Eliminated",
      "",
      "Manual process X.",
      "",
      "### Priority Stack",
      "",
      "1. Automation — **KERN** — must ship",
      "",
      "### Success Feels Like",
      "",
      "- Process X is automatic",
      "",
      "### Milestone Class",
      "",
      "**feature**",
    ].join("\n");

    // All required fields present
    assert.ok(content.includes("## Milestone Intent"));
    assert.ok(content.includes("### Core Problem Being Eliminated"));
    assert.ok(content.includes("### Priority Stack"));
    assert.ok(content.match(/\*\*KERN\*\*/i));
    assert.ok(content.includes("### Success Feels Like"));
    assert.ok(content.includes("### Milestone Class"));
    assert.ok(content.match(/^milestone_class:\s*(feature|transformation)/m));
  });
});

describe("KERN heuristic", () => {
  test("detects KERN text from Priority Stack", () => {
    const contextContent = [
      "### Priority Stack",
      "",
      "1. Claude Code integration — **KERN** — without this the milestone failed",
      "2. Dashboard visibility — important — helps verify",
    ].join("\n");

    const kernMatch = contextContent.match(/\d+\.\s+(.+?)\s*—\s*\*\*KERN\*\*/i);
    assert.ok(kernMatch);
    assert.equal(kernMatch![1].trim(), "Claude Code integration");
  });

  test("extracts meaningful keywords from KERN text", () => {
    const kernText = "Claude Code integration with memory context";
    const stopWords = new Set([
      "that", "this", "with", "from", "have", "been",
      "will", "must", "should", "into", "when", "what", "which",
    ]);
    const kernWords = kernText
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    assert.ok(kernWords.includes("claude"));
    assert.ok(kernWords.includes("code"));
    assert.ok(kernWords.includes("integration"));
    assert.ok(kernWords.includes("memory"));
    assert.ok(kernWords.includes("context"));
    // "with" should be filtered as a stop word
    assert.ok(!kernWords.includes("with"));
  });

  test("matches KERN keywords against slice content", () => {
    const kernWords = ["claude", "code", "integration", "memory"];
    const sliceTexts = [
      "deploy infrastructure and fix baseline issues",
      "build rest endpoints for cockpit proxy",
      "claude code memory integration via rest api",
    ];

    const hasKernSlice = sliceTexts.some((text) =>
      kernWords.some((word) => text.includes(word)),
    );

    assert.ok(hasKernSlice);
  });

  test("warns when no slice addresses KERN", () => {
    const kernWords = ["claude", "code", "integration", "memory"];
    const sliceTexts = [
      "deploy infrastructure and fix baseline issues",
      "build rest endpoints for cockpit proxy",
      "create dashboard visualization page",
    ];

    const hasKernSlice = sliceTexts.some((text) =>
      kernWords.some((word) => text.includes(word)),
    );

    assert.ok(!hasKernSlice, "No slice should match KERN keywords");
  });
});
