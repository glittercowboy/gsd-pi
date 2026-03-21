/**
 * Parity tests for the unified execution contract (R008).
 *
 * Proves that both auto and guided modes produce structurally equivalent
 * prompt context for the same unit type via shared assembly functions.
 *
 * Uses Node built-in test runner (K007 pattern) with temp directory fixtures.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  assembleExecuteTaskPrompt,
  assembleCompleteSlicePrompt,
  assemblePlanSlicePrompt,
  assemblePlanMilestonePrompt,
  assembleResearchSlicePrompt,
  assembleResumeTaskPrompt,
  stripAutoModeFraming,
} from "../execution-contract.js";

import { _clearGsdRootCache } from "../paths.js";

// ─── Fixture Helpers ──────────────────────────────────────────────────────────

/**
 * Create a minimal .gsd directory structure that the build functions can
 * resolve. Provides just enough files for assembly to succeed without
 * throwing ENOENT on mandatory paths.
 */
function createFixture(base: string): void {
  const gsd = join(base, ".gsd");
  const milestoneDir = join(gsd, "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");

  mkdirSync(tasksDir, { recursive: true });

  // Milestone files
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    "# Roadmap — Test Milestone\n\n## Slices\n\n- S01: Test Slice\n",
  );
  writeFileSync(
    join(milestoneDir, "M001-CONTEXT.md"),
    "# M001 Context\n\nThis is a test milestone for parity testing.\n",
  );

  // Slice plan with verification section (needed for execute-task excerpt extraction)
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "**Goal:** Test slice for parity testing.",
      "",
      "## Must-Haves",
      "",
      "- Feature A works",
      "",
      "## Verification",
      "",
      "- `echo ok` — sanity check",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Test Task** `est:10m`",
      "  - Do: Implement the thing",
      "",
    ].join("\n"),
  );

  // Task plan
  writeFileSync(
    join(tasksDir, "T01-PLAN.md"),
    [
      "# T01: Test Task",
      "",
      "## Description",
      "",
      "A minimal task for parity testing.",
      "",
      "## Steps",
      "",
      "1. Do the thing",
      "",
      "## Must-Haves",
      "",
      "- [ ] Thing done",
      "",
    ].join("\n"),
  );

  // GSD root files (optional but avoids null-path codepaths)
  writeFileSync(join(gsd, "DECISIONS.md"), "# Decisions\n\nNone yet.\n");
  writeFileSync(join(gsd, "KNOWLEDGE.md"), "# Knowledge\n\nNone yet.\n");
  writeFileSync(join(gsd, "REQUIREMENTS.md"), "# Requirements\n\nNone yet.\n");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("execution-contract: stripAutoModeFraming", () => {
  it("strips the framing line and following blank line", () => {
    const input = "You are executing GSD auto-mode.\n\n## UNIT: Do stuff";
    const result = stripAutoModeFraming(input);
    assert.equal(result, "## UNIT: Do stuff");
  });

  it("strips framing line without following blank line", () => {
    const input = "You are executing GSD auto-mode.\n## UNIT: Do stuff";
    const result = stripAutoModeFraming(input);
    assert.equal(result, "## UNIT: Do stuff");
  });

  it("returns input unchanged when framing is absent", () => {
    const input = "## UNIT: Do stuff\n\nSome content";
    const result = stripAutoModeFraming(input);
    assert.equal(result, input);
  });
});

describe("execution-contract: execute-task parity", () => {
  let tmpDir: string;

  beforeEach(() => {
    _clearGsdRootCache();
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-ec-test-"));
    createFixture(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    _clearGsdRootCache();
  });

  it("execute-task prompt has same structural sections in both modes", async () => {
    const autoPrompt = await assembleExecuteTaskPrompt(
      "M001", "S01", "Test Slice", "T01", "Test Task", tmpDir, "auto", "minimal",
    );
    const guidedPrompt = await assembleExecuteTaskPrompt(
      "M001", "S01", "Test Slice", "T01", "Test Task", tmpDir, "guided", "minimal",
    );

    // Both should contain the same structural sections
    assert.ok(autoPrompt.includes("## Context Manifest"), "auto should have Context Manifest");
    assert.ok(guidedPrompt.includes("## Context Manifest"), "guided should have Context Manifest");

    assert.ok(autoPrompt.includes("## Carry-Forward Context"), "auto should have Carry-Forward Context");
    assert.ok(guidedPrompt.includes("## Carry-Forward Context"), "guided should have Carry-Forward Context");

    assert.ok(autoPrompt.includes("## Resume State"), "auto should have Resume State");
    assert.ok(guidedPrompt.includes("## Resume State"), "guided should have Resume State");

    assert.ok(autoPrompt.includes("## Inlined Task Plan"), "auto should have Inlined Task Plan");
    assert.ok(guidedPrompt.includes("## Inlined Task Plan"), "guided should have Inlined Task Plan");

    assert.ok(autoPrompt.includes("## Slice Plan Excerpt"), "auto should have Slice Plan Excerpt");
    assert.ok(guidedPrompt.includes("## Slice Plan Excerpt"), "guided should have Slice Plan Excerpt");

    // Mode-specific framing
    assert.ok(
      autoPrompt.includes("You are executing GSD auto-mode."),
      "auto prompt SHOULD contain auto-mode framing",
    );
    assert.ok(
      !guidedPrompt.includes("You are executing GSD auto-mode."),
      "guided prompt should NOT contain auto-mode framing",
    );
  });

  it("resume-task prompt has same structural sections as execute-task in both modes", async () => {
    const autoPrompt = await assembleResumeTaskPrompt(
      "M001", "S01", "Test Slice", "T01", "Test Task", tmpDir, "auto", "minimal",
    );
    const guidedPrompt = await assembleResumeTaskPrompt(
      "M001", "S01", "Test Slice", "T01", "Test Task", tmpDir, "guided", "minimal",
    );

    // Resume delegates to buildExecuteTaskPrompt, so same sections
    assert.ok(autoPrompt.includes("## Context Manifest"), "auto resume should have Context Manifest");
    assert.ok(guidedPrompt.includes("## Context Manifest"), "guided resume should have Context Manifest");

    // Mode-specific framing
    assert.ok(
      autoPrompt.includes("You are executing GSD auto-mode."),
      "auto resume SHOULD contain auto-mode framing",
    );
    assert.ok(
      !guidedPrompt.includes("You are executing GSD auto-mode."),
      "guided resume should NOT contain auto-mode framing",
    );
  });
});

describe("execution-contract: plan-slice parity", () => {
  let tmpDir: string;

  beforeEach(() => {
    _clearGsdRootCache();
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-ec-test-"));
    createFixture(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    _clearGsdRootCache();
  });

  it("plan-slice prompt has same structural sections in both modes", async () => {
    const autoPrompt = await assemblePlanSlicePrompt(
      "M001", "Test Milestone", "S01", "Test Slice", tmpDir, "auto", "minimal",
    );
    const guidedPrompt = await assemblePlanSlicePrompt(
      "M001", "Test Milestone", "S01", "Test Slice", tmpDir, "guided", "minimal",
    );

    assert.ok(autoPrompt.includes("## Inlined Context"), "auto should have Inlined Context");
    assert.ok(guidedPrompt.includes("## Inlined Context"), "guided should have Inlined Context");

    assert.ok(
      autoPrompt.includes("You are executing GSD auto-mode."),
      "auto prompt SHOULD contain auto-mode framing",
    );
    assert.ok(
      !guidedPrompt.includes("You are executing GSD auto-mode."),
      "guided prompt should NOT contain auto-mode framing",
    );
  });
});

describe("execution-contract: complete-slice parity", () => {
  let tmpDir: string;

  beforeEach(() => {
    _clearGsdRootCache();
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-ec-test-"));
    createFixture(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    _clearGsdRootCache();
  });

  it("complete-slice prompt has same structural sections in both modes", async () => {
    const autoPrompt = await assembleCompleteSlicePrompt(
      "M001", "Test Milestone", "S01", "Test Slice", tmpDir, "auto", "minimal",
    );
    const guidedPrompt = await assembleCompleteSlicePrompt(
      "M001", "Test Milestone", "S01", "Test Slice", tmpDir, "guided", "minimal",
    );

    assert.ok(autoPrompt.includes("## Inlined Context"), "auto should have Inlined Context");
    assert.ok(guidedPrompt.includes("## Inlined Context"), "guided should have Inlined Context");

    assert.ok(
      autoPrompt.includes("You are executing GSD auto-mode."),
      "auto prompt SHOULD contain auto-mode framing",
    );
    assert.ok(
      !guidedPrompt.includes("You are executing GSD auto-mode."),
      "guided prompt should NOT contain auto-mode framing",
    );
  });
});

describe("execution-contract: plan-milestone parity", () => {
  let tmpDir: string;

  beforeEach(() => {
    _clearGsdRootCache();
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-ec-test-"));
    createFixture(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    _clearGsdRootCache();
  });

  it("plan-milestone prompt has same structural sections in both modes", async () => {
    const autoPrompt = await assemblePlanMilestonePrompt(
      "M001", "Test Milestone", tmpDir, "auto", "minimal",
    );
    const guidedPrompt = await assemblePlanMilestonePrompt(
      "M001", "Test Milestone", tmpDir, "guided", "minimal",
    );

    assert.ok(autoPrompt.includes("## Inlined Context"), "auto should have Inlined Context");
    assert.ok(guidedPrompt.includes("## Inlined Context"), "guided should have Inlined Context");

    assert.ok(
      autoPrompt.includes("You are executing GSD auto-mode."),
      "auto prompt SHOULD contain auto-mode framing",
    );
    assert.ok(
      !guidedPrompt.includes("You are executing GSD auto-mode."),
      "guided prompt should NOT contain auto-mode framing",
    );
  });
});

describe("execution-contract: research-slice parity", () => {
  let tmpDir: string;

  beforeEach(() => {
    _clearGsdRootCache();
    tmpDir = mkdtempSync(join(tmpdir(), "gsd-ec-test-"));
    createFixture(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    _clearGsdRootCache();
  });

  it("research-slice prompt has same structural sections in both modes", async () => {
    const autoPrompt = await assembleResearchSlicePrompt(
      "M001", "Test Milestone", "S01", "Test Slice", tmpDir, "auto",
    );
    const guidedPrompt = await assembleResearchSlicePrompt(
      "M001", "Test Milestone", "S01", "Test Slice", tmpDir, "guided",
    );

    assert.ok(autoPrompt.includes("## Inlined Context"), "auto should have Inlined Context");
    assert.ok(guidedPrompt.includes("## Inlined Context"), "guided should have Inlined Context");

    assert.ok(
      autoPrompt.includes("You are executing GSD auto-mode."),
      "auto prompt SHOULD contain auto-mode framing",
    );
    assert.ok(
      !guidedPrompt.includes("You are executing GSD auto-mode."),
      "guided prompt should NOT contain auto-mode framing",
    );
  });
});

describe("execution-contract: import graph", () => {
  it("execution-contract does not import guided-flow (no circular dependency)", () => {
    const contractPath = fileURLToPath(
      new URL("../execution-contract.ts", import.meta.url),
    );
    const source = readFileSync(contractPath, "utf-8");

    assert.ok(
      !(/from\s+["'].*guided-flow/.test(source)),
      "execution-contract.ts must not import from guided-flow",
    );
    assert.ok(
      !(/import\s+.*guided-flow/.test(source)),
      "execution-contract.ts must not import guided-flow",
    );
  });

  it("execution-contract does not import auto-dispatch (one-directional dependency)", () => {
    const contractPath = fileURLToPath(
      new URL("../execution-contract.ts", import.meta.url),
    );
    const source = readFileSync(contractPath, "utf-8");

    assert.ok(
      !(/from\s+["'].*auto-dispatch/.test(source)),
      "execution-contract.ts must not import from auto-dispatch",
    );
  });
});
