/**
 * context-injector.test.ts — Tests for injectContext().
 *
 * Tests context injection from prior step artifacts: single-step,
 * multi-step chain, missing artifact, no contextFrom, truncation,
 * and unknown step ID in contextFrom.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { injectContext } from "../context-injector.ts";
import type { WorkflowDefinition } from "../definition-loader.ts";

/** Create a temp run directory with the given definition and optional files. */
function makeTempRun(
  def: WorkflowDefinition,
  files?: Record<string, string>,
): string {
  const runDir = mkdtempSync(join(tmpdir(), "ci-test-"));
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");

  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = join(runDir, relPath);
      const parentDir = join(absPath, "..");
      mkdirSync(parentDir, { recursive: true });
      writeFileSync(absPath, content, "utf-8");
    }
  }

  return runDir;
}

/** Minimal valid workflow definition factory. */
function makeDef(
  steps: WorkflowDefinition["steps"],
): WorkflowDefinition {
  return {
    version: 1,
    name: "test-workflow",
    steps,
  };
}

// ─── single-step context ────────────────────────────────────────────────

describe("single-step context injection", () => {
  it("prepends step-1 artifact content to step-2 prompt", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Research",
        prompt: "Research the topic",
        requires: [],
        produces: ["output.md"],
      },
      {
        id: "step-2",
        name: "Write",
        prompt: "Write the report",
        requires: ["step-1"],
        produces: ["report.md"],
        contextFrom: ["step-1"],
      },
    ]);

    const runDir = makeTempRun(def, {
      "output.md": "Research findings: AI is growing fast.",
    });

    const result = injectContext(runDir, "step-2", "Write the report");
    assert.ok(result.includes("Research findings: AI is growing fast."));
    assert.ok(result.includes('Context from step "step-1"'));
    assert.ok(result.includes("(file: output.md)"));
    assert.ok(result.endsWith("Write the report"));
  });
});

// ─── multi-step chain ───────────────────────────────────────────────────

describe("multi-step context chain", () => {
  it("prepends artifacts from both step-1 and step-2", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Research",
        prompt: "Research",
        requires: [],
        produces: ["research.md"],
      },
      {
        id: "step-2",
        name: "Outline",
        prompt: "Outline",
        requires: ["step-1"],
        produces: ["outline.md"],
      },
      {
        id: "step-3",
        name: "Draft",
        prompt: "Write the draft",
        requires: ["step-1", "step-2"],
        produces: ["draft.md"],
        contextFrom: ["step-1", "step-2"],
      },
    ]);

    const runDir = makeTempRun(def, {
      "research.md": "Research content here.",
      "outline.md": "Outline content here.",
    });

    const result = injectContext(runDir, "step-3", "Write the draft");
    assert.ok(result.includes("Research content here."));
    assert.ok(result.includes("Outline content here."));
    assert.ok(result.includes('Context from step "step-1"'));
    assert.ok(result.includes('Context from step "step-2"'));
    assert.ok(result.endsWith("Write the draft"));

    // Verify order: step-1 context appears before step-2 context
    const idx1 = result.indexOf('Context from step "step-1"');
    const idx2 = result.indexOf('Context from step "step-2"');
    assert.ok(idx1 < idx2, "step-1 context should appear before step-2 context");
  });
});

// ─── missing artifact file ──────────────────────────────────────────────

describe("missing artifact file", () => {
  it("skips missing artifact and includes existing ones", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Research",
        prompt: "Research",
        requires: [],
        produces: ["found.md", "missing.md"],
      },
      {
        id: "step-2",
        name: "Write",
        prompt: "Write the report",
        requires: ["step-1"],
        produces: ["report.md"],
        contextFrom: ["step-1"],
      },
    ]);

    // Only create found.md, not missing.md
    const runDir = makeTempRun(def, {
      "found.md": "Found content.",
    });

    const result = injectContext(runDir, "step-2", "Write the report");
    assert.ok(result.includes("Found content."));
    assert.ok(!result.includes("missing.md"));
    assert.ok(result.endsWith("Write the report"));
  });

  it("returns prompt unchanged when all referenced artifacts are missing", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Research",
        prompt: "Research",
        requires: [],
        produces: ["missing.md"],
      },
      {
        id: "step-2",
        name: "Write",
        prompt: "Write the report",
        requires: ["step-1"],
        produces: ["report.md"],
        contextFrom: ["step-1"],
      },
    ]);

    const runDir = makeTempRun(def);

    const result = injectContext(runDir, "step-2", "Write the report");
    assert.equal(result, "Write the report");
  });
});

// ─── no contextFrom ────────────────────────────────────────────────────

describe("no contextFrom", () => {
  it("returns prompt unchanged when step has no contextFrom", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Research",
        prompt: "Research",
        requires: [],
        produces: ["output.md"],
      },
    ]);

    const runDir = makeTempRun(def, {
      "output.md": "Some content.",
    });

    const result = injectContext(runDir, "step-1", "Research");
    assert.equal(result, "Research");
  });

  it("returns prompt unchanged when step ID not found in definition", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Research",
        prompt: "Research",
        requires: [],
        produces: [],
      },
    ]);

    const runDir = makeTempRun(def);

    const result = injectContext(runDir, "nonexistent", "Some prompt");
    assert.equal(result, "Some prompt");
  });
});

// ─── truncation ─────────────────────────────────────────────────────────

describe("truncation guard", () => {
  it("truncates artifacts exceeding 10,000 characters", () => {
    const largeContent = "A".repeat(15_000);

    const def = makeDef([
      {
        id: "step-1",
        name: "Generate",
        prompt: "Generate",
        requires: [],
        produces: ["big.md"],
      },
      {
        id: "step-2",
        name: "Consume",
        prompt: "Use the output",
        requires: ["step-1"],
        produces: [],
        contextFrom: ["step-1"],
      },
    ]);

    const runDir = makeTempRun(def, {
      "big.md": largeContent,
    });

    const result = injectContext(runDir, "step-2", "Use the output");
    assert.ok(result.includes("...[truncated]"));
    // The injected content should be 10,000 chars + truncation marker, not all 15,000
    const contextPart = result.split("Use the output")[0];
    assert.ok(contextPart.length < 15_000, "Context should be truncated below original size");
    // Verify the truncated content is exactly 10,000 A's (no collision with header text)
    const aCount = (contextPart.match(/A/g) || []).length;
    assert.equal(aCount, 10_000, "Should contain exactly 10,000 chars of original content");
  });
});

// ─── unknown step ID in contextFrom ─────────────────────────────────────

describe("unknown step in contextFrom", () => {
  it("skips unknown step IDs gracefully", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Research",
        prompt: "Research",
        requires: [],
        produces: ["output.md"],
      },
      {
        id: "step-2",
        name: "Write",
        prompt: "Write the report",
        requires: ["step-1"],
        produces: [],
        contextFrom: ["step-1", "nonexistent-step"],
      },
    ]);

    const runDir = makeTempRun(def, {
      "output.md": "Research content.",
    });

    const result = injectContext(runDir, "step-2", "Write the report");
    // Should include step-1 content despite nonexistent-step being in contextFrom
    assert.ok(result.includes("Research content."));
    assert.ok(result.endsWith("Write the report"));
  });
});

// ─── error handling ─────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws when DEFINITION.yaml is missing", () => {
    const runDir = mkdtempSync(join(tmpdir(), "ci-test-nodef-"));

    assert.throws(
      () => injectContext(runDir, "step-1", "Some prompt"),
      /ENOENT/,
    );
  });
});
