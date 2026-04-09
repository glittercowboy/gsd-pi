/**
 * Parallel research slices dispatch — structural tests.
 *
 * Verifies the dispatch rule and prompt builder exist with correct structure.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { resolveDispatch } from "../auto-dispatch.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dispatchSrc = readFileSync(join(__dirname, "..", "auto-dispatch.ts"), "utf-8");
const promptsSrc = readFileSync(join(__dirname, "..", "auto-prompts.ts"), "utf-8");
const templatePath = join(__dirname, "..", "prompts", "parallel-research-slices.md");
const templateSrc = readFileSync(templatePath, "utf-8");

const tmpDirs: string[] = [];

function makeTmpProject(): string {
  const base = mkdtempSync(join(tmpdir(), "parallel-research-"));
  tmpDirs.push(base);
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Parallel Research Milestone",
      "",
      "**Vision:** Research-ready slices.",
      "",
      "**Success Criteria:**",
      "- Research both slices",
      "",
      "## Slices",
      "",
      "- [ ] **S01: Alpha** `risk:low` `depends:[]`",
      "- [ ] **S02: Beta** `risk:low` `depends:[]`",
      "",
      "## Boundary Map",
      "",
    ].join("\n"),
    "utf-8",
  );
  return base;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  tmpDirs.length = 0;
});

// ─── Dispatch rule ────────────────────────────────────────────────────────

test("dispatch: parallel-research-slices rule exists", () => {
  assert.ok(
    dispatchSrc.includes("parallel-research-slices"),
    "dispatch table should have parallel-research-slices rule",
  );
});

test("dispatch: parallel-research-slices requires 2+ slices", () => {
  assert.ok(
    dispatchSrc.includes("researchReadySlices.length < 2"),
    "rule should require at least 2 slices for parallel dispatch",
  );
});

test("dispatch: parallel-research-slices respects skip_research", () => {
  const ruleIdx = dispatchSrc.indexOf("parallel-research-slices");
  const ruleBlock = dispatchSrc.slice(ruleIdx, ruleIdx + 500);
  assert.ok(
    ruleBlock.includes("skip_research") || dispatchSrc.slice(ruleIdx - 300, ruleIdx).includes("skip_research"),
    "rule should check skip_research preference",
  );
});

// ─── Prompt builder ───────────────────────────────────────────────────────

test("prompt: buildParallelResearchSlicesPrompt exported", () => {
  assert.ok(
    promptsSrc.includes("export async function buildParallelResearchSlicesPrompt"),
    "buildParallelResearchSlicesPrompt should be exported",
  );
});

test("prompt: builds per-slice subagent prompts", () => {
  assert.ok(
    promptsSrc.includes("buildResearchSlicePrompt"),
    "parallel prompt builder should delegate to per-slice research prompts",
  );
});

// ─── Template ─────────────────────────────────────────────────────────────

test("template: parallel-research-slices.md has required variables", () => {
  assert.ok(templateSrc.includes("{{sliceCount}}"), "template should use sliceCount");
  assert.ok(templateSrc.includes("{{mid}}"), "template should use mid");
  assert.ok(templateSrc.includes("{{subagentPrompts}}"), "template should use subagentPrompts");
});

// ─── Validate milestone prompt ────────────────────────────────────────────

test("template: validate-milestone uses parallel reviewers", () => {
  const validateSrc = readFileSync(join(__dirname, "..", "prompts", "validate-milestone.md"), "utf-8");
  assert.ok(
    validateSrc.includes("Reviewer A") && validateSrc.includes("Reviewer B") && validateSrc.includes("Reviewer C"),
    "validate-milestone should dispatch 3 parallel reviewers",
  );
});

test("resolveDispatch prefers parallel research when multiple slices are ready", async () => {
  const base = makeTmpProject();

  const action = await resolveDispatch({
    basePath: base,
    mid: "M001",
    midTitle: "Parallel Research Milestone",
    state: {
      phase: "planning",
      activeMilestone: { id: "M001", title: "Parallel Research Milestone", status: "active" },
      activeSlice: { id: "S01", title: "Alpha" },
      activeTask: null,
      registry: [],
      blockers: [],
    } as any,
    prefs: undefined,
  });

  assert.equal(action.action, "dispatch");
  if (action.action === "dispatch") {
    assert.equal(action.unitType, "research-slice");
    assert.equal(action.unitId, "M001/parallel-research");
  }
});
