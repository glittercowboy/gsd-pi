/**
 * custom-verification.test.ts — Tests for runCustomVerification().
 *
 * Tests all four verification policies (content-heuristic, shell-command,
 * prompt-verify, human-review) plus edge cases (no policy, missing file).
 * Each test creates a temp run directory with a DEFINITION.yaml and
 * optional test artifacts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { runCustomVerification } from "../custom-verification.ts";
import type { WorkflowDefinition } from "../definition-loader.ts";

/** Create a temp run directory with the given definition and optional files. */
function makeTempRun(
  def: WorkflowDefinition,
  files?: Record<string, string>,
): string {
  const runDir = mkdtempSync(join(tmpdir(), "cv-test-"));
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def), "utf-8");

  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = join(runDir, relPath);
      // Ensure parent directories exist
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

// ─── content-heuristic tests ────────────────────────────────────────────

describe("content-heuristic policy", () => {
  it("returns 'continue' when file exists and meets size/pattern", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Generate report",
        prompt: "Generate a report",
        requires: [],
        produces: ["report.md"],
        verify: {
          policy: "content-heuristic",
          minSize: 10,
          pattern: "# Report",
        },
      },
    ]);

    const runDir = makeTempRun(def, {
      "report.md": "# Report\n\nThis is a valid report with sufficient content.",
    });

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "continue");
  });

  it("returns 'pause' when produces file is missing", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Generate report",
        prompt: "Generate a report",
        requires: [],
        produces: ["report.md"],
        verify: { policy: "content-heuristic" },
      },
    ]);

    // No files created — report.md doesn't exist
    const runDir = makeTempRun(def);

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "pause");
  });

  it("returns 'pause' when file exists but below minSize", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Generate report",
        prompt: "Generate a report",
        requires: [],
        produces: ["report.md"],
        verify: {
          policy: "content-heuristic",
          minSize: 1000,
        },
      },
    ]);

    const runDir = makeTempRun(def, {
      "report.md": "tiny",
    });

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "pause");
  });

  it("returns 'pause' when file exists but pattern does not match", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Generate report",
        prompt: "Generate a report",
        requires: [],
        produces: ["report.md"],
        verify: {
          policy: "content-heuristic",
          pattern: "^# Summary",
        },
      },
    ]);

    const runDir = makeTempRun(def, {
      "report.md": "This has no heading at all.",
    });

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "pause");
  });

  it("returns 'continue' when produces is empty", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Think step",
        prompt: "Think about the problem",
        requires: [],
        produces: [],
        verify: { policy: "content-heuristic" },
      },
    ]);

    const runDir = makeTempRun(def);

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "continue");
  });

  it("returns 'continue' when file exists with no minSize or pattern checks", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Generate output",
        prompt: "Generate output",
        requires: [],
        produces: ["output.txt"],
        verify: { policy: "content-heuristic" },
      },
    ]);

    const runDir = makeTempRun(def, {
      "output.txt": "",
    });

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "continue");
  });
});

// ─── shell-command tests ────────────────────────────────────────────────

describe("shell-command policy", () => {
  it("returns 'continue' when command exits 0", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Build artifact",
        prompt: "Build the artifact",
        requires: [],
        produces: ["artifact.txt"],
        verify: {
          policy: "shell-command",
          command: "test -f artifact.txt",
        },
      },
    ]);

    const runDir = makeTempRun(def, {
      "artifact.txt": "content",
    });

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "continue");
  });

  it("returns 'retry' when command exits non-zero", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Build artifact",
        prompt: "Build the artifact",
        requires: [],
        produces: ["artifact.txt"],
        verify: {
          policy: "shell-command",
          command: "test -f nonexistent-file.txt",
        },
      },
    ]);

    const runDir = makeTempRun(def);

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "retry");
  });
});

// ─── prompt-verify tests ────────────────────────────────────────────────

describe("prompt-verify policy", () => {
  it("returns 'pause'", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Creative step",
        prompt: "Write something creative",
        requires: [],
        produces: ["creative.md"],
        verify: {
          policy: "prompt-verify",
          prompt: "Does the creative output meet the brief?",
        },
      },
    ]);

    const runDir = makeTempRun(def);

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "pause");
  });
});

// ─── human-review tests ─────────────────────────────────────────────────

describe("human-review policy", () => {
  it("returns 'pause'", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Review step",
        prompt: "Prepare for review",
        requires: [],
        produces: ["review-doc.md"],
        verify: { policy: "human-review" },
      },
    ]);

    const runDir = makeTempRun(def);

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "pause");
  });
});

// ─── no verify policy tests ─────────────────────────────────────────────

describe("no verify policy", () => {
  it("returns 'continue' when step has no verify field", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Simple step",
        prompt: "Do something simple",
        requires: [],
        produces: [],
        // No verify field
      },
    ]);

    const runDir = makeTempRun(def);

    const result = runCustomVerification(runDir, "step-1");
    assert.equal(result, "continue");
  });

  it("returns 'continue' when step ID is not found in definition", () => {
    const def = makeDef([
      {
        id: "step-1",
        name: "Only step",
        prompt: "Only step",
        requires: [],
        produces: [],
      },
    ]);

    const runDir = makeTempRun(def);

    const result = runCustomVerification(runDir, "nonexistent-step");
    assert.equal(result, "continue");
  });
});

// ─── missing DEFINITION.yaml ────────────────────────────────────────────

describe("error handling", () => {
  it("throws when DEFINITION.yaml is missing", () => {
    const runDir = mkdtempSync(join(tmpdir(), "cv-test-nodef-"));
    // No DEFINITION.yaml written

    assert.throws(
      () => runCustomVerification(runDir, "step-1"),
      /ENOENT/,
    );
  });
});

// ─── CustomExecutionPolicy integration ──────────────────────────────────

describe("CustomExecutionPolicy.verify() integration", () => {
  it("extracts stepId from unitId and calls runCustomVerification", async () => {
    // Import the policy class
    const { CustomExecutionPolicy } = await import("../custom-execution-policy.ts");

    const def = makeDef([
      {
        id: "analyze",
        name: "Analyze",
        prompt: "Analyze the data",
        requires: [],
        produces: ["analysis.md"],
        verify: { policy: "content-heuristic" },
      },
    ]);

    const runDir = makeTempRun(def, {
      "analysis.md": "Analysis complete.",
    });

    const policy = new CustomExecutionPolicy(runDir);
    const result = await policy.verify("custom-step", "my-workflow/analyze", {
      basePath: "/tmp",
    });
    assert.equal(result, "continue");
  });

  it("returns 'pause' when content-heuristic fails via policy", async () => {
    const { CustomExecutionPolicy } = await import("../custom-execution-policy.ts");

    const def = makeDef([
      {
        id: "generate",
        name: "Generate",
        prompt: "Generate output",
        requires: [],
        produces: ["output.md"],
        verify: { policy: "content-heuristic" },
      },
    ]);

    // No output.md created
    const runDir = makeTempRun(def);

    const policy = new CustomExecutionPolicy(runDir);
    const result = await policy.verify("custom-step", "my-workflow/generate", {
      basePath: "/tmp",
    });
    assert.equal(result, "pause");
  });
});
