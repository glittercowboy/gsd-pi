/**
 * tool-param-optionality — Verifies that enrichment/metadata parameters on
 * planning and completion tools are optional, not required.
 *
 * Models with limited tool-calling capability (e.g. kimi-k2.5, glm-5-turbo)
 * cannot reliably populate 20+ top-level parameters in a single tool call.
 * This test ensures that only the core identification and content parameters
 * are required, while enrichment arrays (patterns, requirements, files, etc.)
 * are optional — so any model can call the tool successfully.
 *
 * See: https://github.com/gsd-build/gsd-2/issues/2771
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbTools } from "../bootstrap/db-tools.ts";
import { Value } from "@sinclair/typebox/value";

// ─── Mock PI ──────────────────────────────────────────────────────────────────

function makeMockPi() {
  const tools: any[] = [];
  return {
    registerTool: (tool: any) => tools.push(tool),
    tools,
  } as any;
}

const pi = makeMockPi();
registerDbTools(pi);

function getTool(name: string) {
  return pi.tools.find((t: any) => t.name === name);
}

// ─── Helper: count required top-level properties ─────────────────────────────

function getRequiredProps(tool: any): string[] {
  const schema = tool.parameters;
  return schema.required ?? [];
}

function getOptionalProps(tool: any): string[] {
  const schema = tool.parameters;
  const allProps = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return allProps.filter((p: string) => !required.has(p));
}

// ─── gsd_slice_complete: enrichment arrays must be optional ──────────────────

test("gsd_slice_complete — enrichment arrays are optional", () => {
  const tool = getTool("gsd_slice_complete");
  assert.ok(tool, "gsd_slice_complete must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core identification and content fields MUST be required
  const coreRequired = [
    "sliceId",
    "milestoneId",
    "sliceTitle",
    "oneLiner",
    "narrative",
    "verification",
    "uatContent",
  ];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment/metadata arrays MUST be optional
  const enrichmentFields = [
    "keyFiles",
    "keyDecisions",
    "patternsEstablished",
    "observabilitySurfaces",
    "provides",
    "requirementsSurfaced",
    "drillDownPaths",
    "affects",
    "requirementsAdvanced",
    "requirementsValidated",
    "requirementsInvalidated",
    "filesModified",
    "requires",
    "deviations",
    "knownLimitations",
    "followUps",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_slice_complete — validates with only core params", () => {
  const tool = getTool("gsd_slice_complete");
  assert.ok(tool, "gsd_slice_complete must be registered");

  const minimalParams = {
    sliceId: "S01",
    milestoneId: "M001",
    sliceTitle: "Test slice",
    oneLiner: "Did the thing",
    narrative: "We did it step by step.",
    verification: "Tests pass.",
    uatContent: "## UAT\n- [x] Works",
  };

  // Should pass schema validation with only core params
  const errors = [...Value.Errors(tool.parameters, minimalParams)];
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
});

// ─── gsd_plan_milestone: enrichment arrays must be optional ──────────────────

test("gsd_plan_milestone — enrichment arrays are optional", () => {
  const tool = getTool("gsd_plan_milestone");
  assert.ok(tool, "gsd_plan_milestone must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields
  const coreRequired = ["milestoneId", "title", "vision", "slices"];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment fields must be optional
  const enrichmentFields = [
    "successCriteria",
    "keyRisks",
    "proofStrategy",
    "verificationContract",
    "verificationIntegration",
    "verificationOperational",
    "verificationUat",
    "definitionOfDone",
    "requirementCoverage",
    "boundaryMapMarkdown",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_plan_milestone — validates with only core params", () => {
  const tool = getTool("gsd_plan_milestone");
  assert.ok(tool, "gsd_plan_milestone must be registered");

  const minimalParams = {
    milestoneId: "M001",
    title: "Test milestone",
    vision: "Build the thing.",
    slices: [
      {
        sliceId: "S01",
        title: "First slice",
        risk: "Low",
        depends: [],
        demo: "After this, X works",
        goal: "Set up X",
        successCriteria: "X is set up",
        proofLevel: "unit-tests",
        integrationClosure: "N/A",
        observabilityImpact: "None",
      },
    ],
  };

  const errors = [...Value.Errors(tool.parameters, minimalParams)];
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
});

// ─── gsd_task_complete: enrichment arrays must be optional ───────────────────

test("gsd_task_complete — enrichment arrays are optional", () => {
  const tool = getTool("gsd_task_complete");
  assert.ok(tool, "gsd_task_complete must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields
  const coreRequired = [
    "taskId",
    "sliceId",
    "milestoneId",
    "oneLiner",
    "narrative",
    "verification",
  ];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment fields must be optional
  const enrichmentFields = [
    "keyFiles",
    "keyDecisions",
    "deviations",
    "knownIssues",
    "blockerDiscovered",
    "verificationEvidence",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_task_complete — validates with only core params", () => {
  const tool = getTool("gsd_task_complete");
  assert.ok(tool, "gsd_task_complete must be registered");

  const minimalParams = {
    taskId: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    oneLiner: "Implemented the feature",
    narrative: "Created the module and wired it up.",
    verification: "npm test passes.",
  };

  const errors = [...Value.Errors(tool.parameters, minimalParams)];
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
});

// ─── gsd_complete_milestone: enrichment arrays must be optional ──────────────

test("gsd_complete_milestone — enrichment arrays are optional", () => {
  const tool = getTool("gsd_complete_milestone");
  assert.ok(tool, "gsd_complete_milestone must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields
  const coreRequired = [
    "milestoneId",
    "title",
    "oneLiner",
    "narrative",
    "verificationPassed",
  ];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment fields must be optional
  const enrichmentFields = [
    "successCriteriaResults",
    "definitionOfDoneResults",
    "requirementOutcomes",
    "keyDecisions",
    "keyFiles",
    "lessonsLearned",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_complete_milestone — validates with only core params", () => {
  const tool = getTool("gsd_complete_milestone");
  assert.ok(tool, "gsd_complete_milestone must be registered");

  const minimalParams = {
    milestoneId: "M001",
    title: "Test milestone",
    oneLiner: "Finished it.",
    narrative: "All work completed.",
    verificationPassed: true,
  };

  const errors = [...Value.Errors(tool.parameters, minimalParams)];
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
});

// ─── gsd_plan_slice: enrichment fields must be optional ──────────────────────

test("gsd_plan_slice — enrichment fields are optional", () => {
  const tool = getTool("gsd_plan_slice");
  assert.ok(tool, "gsd_plan_slice must be registered");

  const required = new Set(getRequiredProps(tool));

  // Core fields
  const coreRequired = ["milestoneId", "sliceId", "goal", "tasks"];
  for (const field of coreRequired) {
    assert.ok(required.has(field), `core field "${field}" must be required`);
  }

  // Enrichment fields
  const enrichmentFields = [
    "successCriteria",
    "proofLevel",
    "integrationClosure",
    "observabilityImpact",
  ];
  for (const field of enrichmentFields) {
    assert.ok(!required.has(field), `enrichment field "${field}" must be optional, not required`);
  }
});

test("gsd_plan_slice — validates with only core params", () => {
  const tool = getTool("gsd_plan_slice");
  assert.ok(tool, "gsd_plan_slice must be registered");

  const minimalParams = {
    milestoneId: "M001",
    sliceId: "S01",
    goal: "Implement feature X",
    tasks: [
      {
        taskId: "T01",
        title: "Build X",
        description: "Build the thing",
        estimate: "2h",
        files: ["src/x.ts"],
        verify: "npm test",
        inputs: [],
        expectedOutput: ["src/x.ts"],
      },
    ],
  };

  const errors = [...Value.Errors(tool.parameters, minimalParams)];
  assert.strictEqual(errors.length, 0, `Minimal params should validate but got errors: ${errors.map(e => `${e.path}: ${e.message}`).join(", ")}`);
});

// ─── Required param count ceiling ────────────────────────────────────────────

test("no planning/completion tool requires more than 10 top-level params", () => {
  const heavyTools = [
    "gsd_slice_complete",
    "gsd_plan_milestone",
    "gsd_task_complete",
    "gsd_complete_milestone",
    "gsd_plan_slice",
  ];

  for (const name of heavyTools) {
    const tool = getTool(name);
    assert.ok(tool, `${name} must be registered`);
    const required = getRequiredProps(tool);
    assert.ok(
      required.length <= 10,
      `${name} has ${required.length} required params (max 10) — required: ${required.join(", ")}`,
    );
  }
});
