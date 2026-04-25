/**
 * Regression tests for subagent model preference wiring.
 *
 * Fixes: subagent_model config in reactive_execution was validated and stored
 * but never passed through to subagent dispatch instruction strings, so the
 * executing agent autonomously chose "sonnet" instead of the configured model.
 *
 * Issue: gsd-build/gsd-2#4078
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validatePreferences } from "../preferences-validation.ts";
import { extractSourceRegion } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsSrc = readFileSync(join(__dirname, "..", "auto-prompts.ts"), "utf-8");
const dispatchSrc = readFileSync(join(__dirname, "..", "auto-dispatch.ts"), "utf-8");

// ─── Preference Validation ────────────────────────────────────────────────

test("reactive_execution: subagent_model is preserved in validated preferences", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      subagent_model: "claude-opus-4-6",
    },
  });
  assert.equal(result.errors.length, 0);
  assert.equal(
    result.preferences.reactive_execution?.subagent_model,
    "claude-opus-4-6",
    "subagent_model should be preserved through validation",
  );
});

test("reactive_execution: subagent_model rejects empty string", () => {
  const result = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      subagent_model: "",
    } as any,
  });
  assert.ok(
    result.errors.some((e) => e.includes("subagent_model")),
    "empty subagent_model should produce a validation error",
  );
});

// ─── Structural: Prompt Builders Accept subagentModel ────────────────────

test("buildReactiveExecutePrompt: accepts subagentModel parameter", () => {
  const fnStart = promptsSrc.indexOf("export async function buildReactiveExecutePrompt");
  assert.ok(fnStart !== -1, "buildReactiveExecutePrompt should be exported");
  const signature = extractSourceRegion(promptsSrc, "export async function buildReactiveExecutePrompt", { fromIdx: fnStart });
  assert.ok(
    signature.includes("subagentModel"),
    "buildReactiveExecutePrompt should accept a subagentModel parameter",
  );
});

test("buildParallelResearchSlicesPrompt: accepts subagentModel parameter", () => {
  const fnStart = promptsSrc.indexOf("export async function buildParallelResearchSlicesPrompt");
  assert.ok(fnStart !== -1, "buildParallelResearchSlicesPrompt should be exported");
  const signature = extractSourceRegion(promptsSrc, "export async function buildParallelResearchSlicesPrompt", { fromIdx: fnStart });
  assert.ok(
    signature.includes("subagentModel"),
    "buildParallelResearchSlicesPrompt should accept a subagentModel parameter",
  );
});

test("buildGateEvaluatePrompt: accepts subagentModel parameter", () => {
  const fnStart = promptsSrc.indexOf("export async function buildGateEvaluatePrompt");
  assert.ok(fnStart !== -1, "buildGateEvaluatePrompt should be exported");
  const signature = extractSourceRegion(promptsSrc, "export async function buildGateEvaluatePrompt", { fromIdx: fnStart });
  assert.ok(
    signature.includes("subagentModel"),
    "buildGateEvaluatePrompt should accept a subagentModel parameter",
  );
});

// ─── Structural: Instruction Strings Inject Model ────────────────────────

test("buildReactiveExecutePrompt: instruction string uses subagentModel when set", () => {
  const fnStart = promptsSrc.indexOf("export async function buildReactiveExecutePrompt");
  const fnEnd = promptsSrc.indexOf("\nexport async function", fnStart + 1);
  const fnBody = promptsSrc.slice(fnStart, fnEnd);
  assert.ok(
    fnBody.includes("subagentModel"),
    "buildReactiveExecutePrompt body should reference subagentModel",
  );
  // The instruction line must be dynamic (not a plain string literal)
  assert.ok(
    !fnBody.includes('"Use this as the prompt for a `subagent` call:"'),
    "instruction should not be a plain static string — model must be injectable",
  );
});

test("buildParallelResearchSlicesPrompt: instruction string uses subagentModel when set", () => {
  const fnStart = promptsSrc.indexOf("export async function buildParallelResearchSlicesPrompt");
  const fnEnd = promptsSrc.indexOf("\nexport async function", fnStart + 1);
  const fnBody = promptsSrc.slice(fnStart, fnEnd);
  assert.ok(
    fnBody.includes("subagentModel"),
    "buildParallelResearchSlicesPrompt body should reference subagentModel",
  );
});

test("buildGateEvaluatePrompt: instruction string uses subagentModel when set", () => {
  const fnStart = promptsSrc.indexOf("export async function buildGateEvaluatePrompt");
  const fnEnd = promptsSrc.indexOf("\nexport async function", fnStart + 1);
  const fnBody = promptsSrc.slice(fnStart, fnEnd);
  assert.ok(
    fnBody.includes("subagentModel"),
    "buildGateEvaluatePrompt body should reference subagentModel",
  );
});

// ─── Structural: Dispatch Wires Model to Prompt Builders ─────────────────

test("auto-dispatch: passes model to buildReactiveExecutePrompt", () => {
  // Find the reactive-execute dispatch rule
  const ruleStart = dispatchSrc.indexOf("reactive-execute (parallel dispatch)");
  assert.ok(ruleStart !== -1, "reactive-execute dispatch rule should exist");
  const ruleBlock = extractSourceRegion(dispatchSrc, "reactive-execute (parallel dispatch)", { fromIdx: ruleStart });
  assert.ok(
    ruleBlock.includes("subagent_model") || ruleBlock.includes("subagentModel"),
    "reactive-execute rule should resolve and pass the subagent model",
  );
});

test("auto-dispatch: passes model to buildParallelResearchSlicesPrompt", () => {
  const callIdx = dispatchSrc.indexOf("buildParallelResearchSlicesPrompt(");
  assert.ok(callIdx !== -1, "buildParallelResearchSlicesPrompt call should exist");
  // The call site should pass a model argument (not just 4 args)
  const callSite = extractSourceRegion(dispatchSrc, "buildParallelResearchSlicesPrompt(", { fromIdx: callIdx });
  assert.ok(
    callSite.includes("subagentModel") || callSite.includes("resolveModelWithFallbacksForUnit"),
    "buildParallelResearchSlicesPrompt call should include model argument",
  );
});

test("auto-dispatch: passes model to buildGateEvaluatePrompt", () => {
  const callIdx = dispatchSrc.indexOf("buildGateEvaluatePrompt(");
  assert.ok(callIdx !== -1, "buildGateEvaluatePrompt call should exist");
  const callSite = extractSourceRegion(dispatchSrc, "buildGateEvaluatePrompt(", { fromIdx: callIdx });
  assert.ok(
    callSite.includes("subagentModel") || callSite.includes("resolveModelWithFallbacksForUnit"),
    "buildGateEvaluatePrompt call should include model argument",
  );
});

// ─── Integration: Prompt Output Contains Model String ────────────────────

test("buildReactiveExecutePrompt: output contains model string when subagentModel provided", async (t) => {
  const { buildReactiveExecutePrompt } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-subagent-model-reactive-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(gsd, "tasks"), { recursive: true });

  writeFileSync(
    join(gsd, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "**Goal:** Verify model injection",
      "**Demo:** Model appears in subagent prompt",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Task One** `est:15m`",
      "  Do something.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(gsd, "tasks", "T01-PLAN.md"),
    [
      "# T01: Task One",
      "",
      "## Description",
      "Do something.",
      "",
      "## Inputs",
      "",
      "- `src/config.json` — Config",
      "",
      "## Expected Output",
      "",
      "- `src/out.ts` — Result",
    ].join("\n"),
  );

  const prompt = await buildReactiveExecutePrompt(
    "M001", "Test Milestone", "S01", "Test Slice",
    ["T01"], repo, "claude-opus-4-6",
  );

  assert.ok(
    prompt.includes('model: "claude-opus-4-6"'),
    `Prompt should contain model instruction. Got:\n${prompt.slice(0, 500)}`,
  );
});

test("buildReactiveExecutePrompt: no model instruction when subagentModel omitted", async (t) => {
  const { buildReactiveExecutePrompt } = await import("../auto-prompts.ts");
  const repo = mkdtempSync(join(tmpdir(), "gsd-subagent-model-none-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const gsd = join(repo, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(join(gsd, "tasks"), { recursive: true });

  writeFileSync(
    join(gsd, "S01-PLAN.md"),
    [
      "# S01: Test Slice",
      "",
      "**Goal:** Verify no model when omitted",
      "**Demo:** No model string",
      "",
      "## Tasks",
      "",
      "- [ ] **T01: Task One** `est:15m`",
      "  Do something.",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(gsd, "tasks", "T01-PLAN.md"),
    [
      "# T01: Task One",
      "",
      "## Description",
      "Do something.",
      "",
      "## Inputs",
      "",
      "- `src/config.json` — Config",
      "",
      "## Expected Output",
      "",
      "- `src/out.ts` — Result",
    ].join("\n"),
  );

  const prompt = await buildReactiveExecutePrompt(
    "M001", "Test Milestone", "S01", "Test Slice",
    ["T01"], repo,
    // no subagentModel
  );

  assert.ok(
    !prompt.includes('with model:'),
    "Prompt should not contain model instruction when subagentModel is omitted",
  );
});
