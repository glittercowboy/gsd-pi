import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { symlinkSync, realpathSync } from "node:fs";

import { _getAdapter, closeDatabase } from "../../../src/resources/extensions/gsd/gsd-db.ts";
import { registerWorkflowTools, WORKFLOW_TOOL_NAMES, validateProjectDir } from "./workflow-tools.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-mcp-workflow-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try {
    closeDatabase();
  } catch {
    // swallow
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // swallow
  }
}

function writeWriteGateSnapshot(
  base: string,
  snapshot: { verifiedDepthMilestones?: string[]; activeQueuePhase?: boolean; pendingGateId?: string | null },
): void {
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "write-gate-state.json"),
    JSON.stringify(
      {
        verifiedDepthMilestones: snapshot.verifiedDepthMilestones ?? [],
        activeQueuePhase: snapshot.activeQueuePhase ?? false,
        pendingGateId: snapshot.pendingGateId ?? null,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function makeMockServer() {
  const tools: Array<{
    name: string;
    description: string;
    params: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  }> = [];
  return {
    tools,
    tool(
      name: string,
      description: string,
      params: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      tools.push({ name, description, params, handler });
    },
  };
}

describe("workflow MCP tools", () => {
  it("registers the full headless-safe workflow tool surface", () => {
    const server = makeMockServer();
    registerWorkflowTools(server as any);

    assert.equal(server.tools.length, WORKFLOW_TOOL_NAMES.length);
    assert.deepEqual(server.tools.map((t) => t.name), [...WORKFLOW_TOOL_NAMES]);
  });

  it("gsd_summary_save writes artifact through the shared executor", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");
      const originalCwd = process.cwd();

      const result = await tool!.handler({
        projectDir: base,
        milestone_id: "M001",
        slice_id: "S01",
        artifact_type: "SUMMARY",
        content: "# Summary\n\nHello",
      });

      const text = (result as any).content[0].text as string;
      assert.match(text, /Saved SUMMARY artifact/);
      assert.equal(process.cwd(), originalCwd, "workflow MCP tools should not mutate process.cwd");
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md")),
        "summary file should exist on disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("rejects workflow tool calls outside the configured project root", async () => {
    const base = makeTmpBase();
    const otherBase = makeTmpBase();
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = base;
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");

      await assert.rejects(
        () =>
          tool!.handler({
            projectDir: otherBase,
            milestone_id: "M001",
            artifact_type: "SUMMARY",
            content: "# Summary",
          }),
        /configured workflow project root/,
      );
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(base);
      cleanup(otherBase);
    }
  });

  it("rejects non-file executor module URLs", async () => {
    const base = makeTmpBase();
    const prevModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = base;
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = "data:text/javascript,export default {}";
      const { registerWorkflowTools: freshRegisterWorkflowTools } = await import(`./workflow-tools.ts?bad-module=${randomUUID()}`);
      const server = makeMockServer();
      freshRegisterWorkflowTools(server as any);
      const tool = server.tools.find((t) => t.name === "gsd_summary_save");
      assert.ok(tool, "summary tool should be registered");

      await assert.rejects(
        () =>
          tool!.handler({
            projectDir: base,
            milestone_id: "M001",
            artifact_type: "SUMMARY",
            content: "# Summary",
          }),
        /only supports file: URLs or filesystem paths/,
      );
    } finally {
      if (prevModule === undefined) {
        delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
      } else {
        process.env.GSD_WORKFLOW_EXECUTORS_MODULE = prevModule;
      }
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(base);
    }
  });

  it("blocks workflow mutation tools while a discussion gate is pending", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
      );
      writeWriteGateSnapshot(base, { pendingGateId: "depth_verification_M001_confirm" });

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");

      await assert.rejects(
        () =>
          taskTool!.handler({
            projectDir: base,
            taskId: "T01",
            sliceId: "S01",
            milestoneId: "M001",
            oneLiner: "Completed task",
            narrative: "Did the work",
            verification: "npm test",
          }),
        /Discussion gate .* has not been confirmed/,
      );
    } finally {
      cleanup(base);
    }
  });

  it("blocks workflow mutation tools during queue mode", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
      );
      writeWriteGateSnapshot(base, { activeQueuePhase: true });

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");

      await assert.rejects(
        () =>
          taskTool!.handler({
            projectDir: base,
            taskId: "T01",
            sliceId: "S01",
            milestoneId: "M001",
            oneLiner: "Completed task",
            narrative: "Did the work",
            verification: "npm test",
          }),
        /planning tool .* not executes work|Cannot gsd_task_complete|Unknown tools are not permitted during queue mode/,
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_task_complete and gsd_milestone_status work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"),
        "# S01\n\n- [ ] **T01: Demo** `est:5m`\n",
      );

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const statusTool = server.tools.find((t) => t.name === "gsd_milestone_status");
      assert.ok(taskTool, "task tool should be registered");
      assert.ok(statusTool, "status tool should be registered");

      const taskResult = await taskTool!.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task",
        narrative: "Did the work",
        verification: "npm test",
      });

      assert.match((taskResult as any).content[0].text as string, /Completed task T01/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md")),
        "task summary should be written to disk",
      );

      const statusResult = await statusTool!.handler({
        projectDir: base,
        milestoneId: "M001",
      });
      const parsed = JSON.parse((statusResult as any).content[0].text as string);
      assert.equal(parsed.milestoneId, "M001");
      assert.equal(parsed.sliceCount, 1);
      assert.equal(parsed.slices[0].id, "S01");
    } finally {
      cleanup(base);
    }
  });

  it("#4477 gsd_task_complete forwards every schema field to the executor (regression for destructure-rebuild bug class)", async () => {
    // Locks in the class-fix from PR #4477 review: handleTaskComplete previously
    // destructured args into a hand-listed set of fields and rebuilt the call
    // payload, which silently dropped ADR-011's `escalation` field (and any
    // future schema field added without updating the rebuild). The fix passes
    // `args` through directly, matching the spread pattern of sibling
    // handlers. This test verifies the contract by injecting a mock executor
    // module that captures the args, calling gsd_task_complete with an
    // `escalation` payload, and asserting the field reached the executor.
    const base = makeTmpBase();
    const capturePath = join(base, "captured-args.json");
    const mockModulePath = join(base, "mock-executors.mjs");
    const prevModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    const prevCapture = process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
    try {
      // Mock module: implements the WorkflowToolExecutors shape.
      // executeTaskComplete writes its received args to disk for assertion.
      // Other executors are no-op stubs to satisfy isWorkflowToolExecutors.
      const mockSource = `
import { writeFileSync } from "node:fs";

const noop = async () => ({ content: [{ type: "text", text: "noop" }] });

export const SUPPORTED_SUMMARY_ARTIFACT_TYPES = ["SUMMARY", "UAT", "CONTEXT", "PLAN"];
export const executeMilestoneStatus = noop;
export const executePlanMilestone = noop;
export const executePlanSlice = noop;
export const executeReplanSlice = noop;
export const executeSliceComplete = noop;
export const executeCompleteMilestone = noop;
export const executeValidateMilestone = noop;
export const executeReassessRoadmap = noop;
export const executeSaveGateResult = noop;
export const executeSummarySave = noop;

export const executeTaskComplete = async (params, projectDir) => {
  const capturePath = process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
  if (capturePath) {
    writeFileSync(capturePath, JSON.stringify({ params, projectDir }, null, 2));
  }
  return {
    content: [{ type: "text", text: "mock task complete" }],
    details: { taskId: params.taskId },
  };
};
`;
      writeFileSync(mockModulePath, mockSource, "utf-8");
      process.env.GSD_WORKFLOW_EXECUTORS_MODULE = mockModulePath;
      process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH = capturePath;

      // Fresh import bypasses the cached workflowToolExecutorsPromise so the
      // mock module is actually loaded for this test.
      const { registerWorkflowTools: freshRegisterWorkflowTools } = await import(
        `./workflow-tools.ts?escalation-test=${randomUUID()}`
      );
      const server = makeMockServer();
      freshRegisterWorkflowTools(server as any);
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      assert.ok(taskTool, "task tool should be registered");

      // Mirrors the ADR-011 escalation schema: question + 2-4 options
      // (each with id/label/tradeoffs) + recommendation + rationale +
      // continueWithDefault flag.
      const escalationPayload = {
        question: "Should the auth flow use OAuth or PAT?",
        options: [
          { id: "A", label: "OAuth", tradeoffs: "Best UX; requires more setup." },
          { id: "B", label: "PAT", tradeoffs: "Simpler; weaker rotation story." },
        ],
        recommendation: "A",
        recommendationRationale: "Initial requirement implied multi-user; OAuth fits better.",
        continueWithDefault: true,
      };

      await taskTool!.handler({
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "M001",
        oneLiner: "Completed task with escalation",
        narrative: "Did the work but flagged an ambiguity",
        verification: "npm test",
        escalation: escalationPayload,
        verificationEvidence: [
          { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 },
        ],
      });

      assert.ok(existsSync(capturePath), "mock executor should have written captured args to disk");
      const captured = JSON.parse(readFileSync(capturePath, "utf-8"));

      // The handler resolves projectDir via realpathSync (security/symlink check),
      // so on macOS where /var symlinks to /private/var, the captured path will
      // be the realpath form. Normalize both sides.
      assert.equal(captured.projectDir, realpathSync(base), "projectDir should be passed as second arg");
      assert.deepEqual(
        captured.params.escalation,
        escalationPayload,
        "escalation payload must reach the executor verbatim — regression guard for the destructure-rebuild bug class (#4477 review)",
      );
      // Spot-check a couple of other fields to ensure the spread pattern
      // doesn't accidentally exclude the rest while including escalation.
      assert.equal(captured.params.taskId, "T01", "taskId must be forwarded");
      assert.equal(captured.params.milestoneId, "M001", "milestoneId must be forwarded");
      assert.deepEqual(
        captured.params.verificationEvidence,
        [{ command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 }],
        "verificationEvidence must be forwarded (existing field)",
      );
      // Ensure no projectDir leak into params (it should be the second arg only).
      assert.equal(
        captured.params.projectDir,
        undefined,
        "projectDir must NOT appear in params — it's stripped via the spread destructure",
      );
    } finally {
      if (prevModule === undefined) {
        delete process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
      } else {
        process.env.GSD_WORKFLOW_EXECUTORS_MODULE = prevModule;
      }
      if (prevCapture === undefined) {
        delete process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH;
      } else {
        process.env.GSD_TEST_TASK_COMPLETE_CAPTURE_PATH = prevCapture;
      }
      cleanup(base);
    }
  });

  it("gsd_complete_task alias delegates to gsd_task_complete behavior", async () => {
    const base = makeTmpBase();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M002", "slices", "S02"), { recursive: true });
      writeFileSync(
        join(base, ".gsd", "milestones", "M002", "slices", "S02", "S02-PLAN.md"),
        "# S02\n\n- [ ] **T02: Demo** `est:5m`\n",
      );

      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const aliasTool = server.tools.find((t) => t.name === "gsd_complete_task");
      assert.ok(aliasTool, "task completion alias should be registered");

      const result = await aliasTool!.handler({
        projectDir: base,
        taskId: "T02",
        sliceId: "S02",
        milestoneId: "M002",
        oneLiner: "Completed task via alias",
        narrative: "Did the work through alias",
        verification: "npm test",
      });

      assert.match((result as any).content[0].text as string, /Completed task T02/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M002", "slices", "S02", "tasks", "T02-SUMMARY.md")),
        "alias should write task summary to disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone and gsd_plan_slice work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");

      const milestoneResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Workflow MCP planning",
        vision: "Plan milestone over MCP.",
        slices: [
          {
            sliceId: "S01",
            title: "Bridge planning",
            risk: "medium",
            depends: [],
            demo: "Milestone plan persists through MCP.",
            goal: "Persist roadmap state.",
            successCriteria: "ROADMAP.md renders from DB.",
            proofLevel: "integration",
            integrationClosure: "Prompts and MCP call the same handler.",
            observabilityImpact: "Executor tests cover output paths.",
          },
        ],
      });
      assert.match((milestoneResult as any).content[0].text as string, /Planned milestone M001/);

      const sliceResult = await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan over MCP.",
        tasks: [
          {
            taskId: "T01",
            title: "Add planning bridge",
            description: "Implement the shared executor path.",
            estimate: "15m",
            files: ["src/resources/extensions/gsd/tools/workflow-tool-executors.ts"],
            verify: "node --test",
            inputs: ["ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md", "T01-PLAN.md"],
          },
        ],
      });
      assert.match((sliceResult as any).content[0].text as string, /Planned slice S01/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md")),
        "slice plan should exist on disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-PLAN.md")),
        "task plan should exist on disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("other workflow tools reject empty required strings at the schema layer", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);

      const expectRejection = async (toolName: string, args: Record<string, unknown>, expectedField: string) => {
        const tool = server.tools.find((t) => t.name === toolName);
        assert.ok(tool, `${toolName} should be registered`);
        let caught: unknown;
        try {
          await tool!.handler(args);
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, `${toolName} should reject empty ${expectedField}`);
        const message = caught instanceof Error ? caught.message : String(caught);
        assert.ok(
          message.includes(expectedField),
          `${toolName} error should mention ${expectedField}, got: ${message}`,
        );
      };

      // Empty sliceId top-level
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "",
        goal: "Persist slice plan.",
        tasks: [],
      }, "sliceId");

      // Empty task verify inside tasks array
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan.",
        tasks: [
          {
            taskId: "T01",
            title: "Add bridge",
            description: "Implement bridge.",
            estimate: "15m",
            files: ["src/x.ts"],
            verify: "",
            inputs: ["ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md"],
          },
        ],
      }, "verify");

      // Empty element inside files[] array
      await expectRejection("gsd_plan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        goal: "Persist slice plan.",
        tasks: [
          {
            taskId: "T01",
            title: "Add bridge",
            description: "Implement bridge.",
            estimate: "15m",
            files: ["src/x.ts", "   "],
            verify: "node --test",
            inputs: ["ROADMAP.md"],
            expectedOutput: ["S01-PLAN.md"],
          },
        ],
      }, "files");

      // Empty milestoneId on gsd_plan_task
      await expectRejection("gsd_plan_task", {
        projectDir: base,
        milestoneId: "",
        sliceId: "S01",
        taskId: "T01",
        title: "t",
        description: "d",
        estimate: "1m",
        files: [],
        verify: "v",
        inputs: [],
        expectedOutput: [],
      }, "milestoneId");

      // Empty observabilityImpact explicitly rejected (optional-but-non-empty)
      await expectRejection("gsd_plan_task", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T01",
        title: "t",
        description: "d",
        estimate: "1m",
        files: [],
        verify: "v",
        inputs: [],
        expectedOutput: [],
        observabilityImpact: "   ",
      }, "observabilityImpact");

      // Empty assessment on gsd_reassess_roadmap
      await expectRejection("gsd_reassess_roadmap", {
        projectDir: base,
        milestoneId: "M001",
        completedSliceId: "S01",
        verdict: "roadmap-confirmed",
        assessment: "",
        sliceChanges: { modified: [], added: [], removed: [] },
      }, "assessment");

      // Empty keyRisks[i].risk on gsd_plan_milestone top-level arrays
      await expectRejection("gsd_plan_milestone", {
        projectDir: base,
        milestoneId: "M001",
        title: "T",
        vision: "V",
        slices: [],
        keyRisks: [{ risk: "", whyItMatters: "because." }],
      }, "risk");

      // Empty blockerDescription on gsd_replan_slice
      await expectRejection("gsd_replan_slice", {
        projectDir: base,
        milestoneId: "M001",
        sliceId: "S01",
        blockerTaskId: "T01",
        blockerDescription: "",
        whatChanged: "x",
        updatedTasks: [],
        removedTaskIds: [],
      }, "blockerDescription");

      // Empty milestoneId on gsd_task_complete
      await expectRejection("gsd_task_complete", {
        projectDir: base,
        taskId: "T01",
        sliceId: "S01",
        milestoneId: "",
        oneLiner: "ol",
        narrative: "n",
        verification: "v",
      }, "milestoneId");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone rejects empty slice fields up front with all violations", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");

      let caught: unknown;
      try {
        await milestoneTool!.handler({
          projectDir: base,
          milestoneId: "M001",
          title: "Workflow MCP planning",
          vision: "Plan milestone over MCP.",
          slices: [
            {
              sliceId: "S01",
              title: "Bridge planning",
              risk: "medium",
              depends: [],
              demo: "Milestone plan persists through MCP.",
              goal: "Persist roadmap state.",
              successCriteria: "",
              proofLevel: "",
              integrationClosure: "   ",
              observabilityImpact: "",
            },
          ],
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "empty slice fields should be rejected");
      const message = caught instanceof Error ? caught.message : String(caught);
      for (const field of ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"]) {
        assert.ok(
          message.includes(field),
          `parse error should mention ${field}, got: ${message}`,
        );
      }
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone rejects a full slice with missing heavy fields via a behavioral round-trip", async () => {
    // Behavioral guard for the full-vs-sketch conditional. The original
    // regression (invisible "required unless isSketch" requirement) is
    // surfaced to users through two distinct runtime channels:
    //   1. A parse-time rejection when the tool is called with empty heavy
    //      fields on a non-sketch slice (no isSketch=true).
    //   2. An acceptance when isSketch=true + sketchScope is supplied and
    //      heavy fields are omitted.
    // Both arms are exercised below against the live handler — any schema
    // refactor that preserves the user-observable contract (rejection +
    // acceptance) passes, and any refactor that breaks the contract
    // fails, regardless of whether internal `.describe()` prose changes.
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");

      // Arm 1: full slice (isSketch omitted) with the heavy fields missing
      // must reject and name ALL four fields so the agent can self-correct.
      let fullError: unknown;
      try {
        await milestoneTool!.handler({
          projectDir: base,
          milestoneId: "M001",
          title: "Full slice path",
          vision: "Behavioral test for isSketch conditional.",
          slices: [
            {
              sliceId: "S01",
              title: "Heavy slice",
              risk: "medium",
              depends: [],
              demo: "Demo.",
              goal: "Goal.",
              // heavy fields intentionally omitted
            },
          ],
        });
      } catch (err) {
        fullError = err;
      }
      assert.ok(fullError, "a non-sketch slice without heavy fields must reject");
      const fullMsg = fullError instanceof Error ? fullError.message : String(fullError);
      for (const field of ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"]) {
        assert.ok(
          fullMsg.includes(field),
          `rejection must name ${field} so agents can recover without a second round-trip; got: ${fullMsg}`,
        );
      }

      // Arm 2: sketch slice (isSketch=true + sketchScope) with heavy fields
      // omitted must be accepted — proving the conditional is live. Assert
      // success directly rather than just checking a thrown message omits
      // the heavy-field names: a generic failure would otherwise silently
      // pass this arm.
      const sketchResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M002",
        title: "Sketch slice path",
        vision: "Behavioral test for isSketch conditional.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "medium",
            depends: [],
            demo: "Demo.",
            goal: "Goal.",
            isSketch: true,
            sketchScope: "Two-sentence scope. Boundary defined.",
          },
        ],
      });
      assert.match(
        (sketchResult as any).content[0].text as string,
        /Planned milestone M002/,
        "sketch slice with isSketch=true must be accepted by the handler",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_milestone requires sketchScope when isSketch=true and skips heavy fields", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      assert.ok(milestoneTool, "milestone planning tool should be registered");

      let caught: unknown;
      try {
        await milestoneTool!.handler({
          projectDir: base,
          milestoneId: "M001",
          title: "Sketch milestone",
          vision: "Sketch first, refine later.",
          slices: [
            {
              sliceId: "S01",
              title: "Sketch slice",
              risk: "low",
              depends: [],
              demo: "Stub demo.",
              goal: "Stub goal.",
              isSketch: true,
              sketchScope: "",
            },
          ],
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, "empty sketchScope should be rejected when isSketch=true");
      const message = caught instanceof Error ? caught.message : String(caught);
      assert.ok(message.includes("sketchScope"), `expected sketchScope error, got: ${message}`);

      const sketchResult = await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M001",
        title: "Sketch milestone",
        vision: "Sketch first, refine later.",
        slices: [
          {
            sliceId: "S01",
            title: "Sketch slice",
            risk: "low",
            depends: [],
            demo: "Stub demo.",
            goal: "Stub goal.",
            isSketch: true,
            sketchScope: "Defer heavy planning fields until refine-slice.",
          },
        ],
      });
      assert.match((sketchResult as any).content[0].text as string, /Planned milestone M001/);
    } finally {
      cleanup(base);
    }
  });

  it("gsd_requirement_save opens the DB before inline requirement writes", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const requirementTool = server.tools.find((t) => t.name === "gsd_requirement_save");
      assert.ok(requirementTool, "requirement tool should be registered");

      closeDatabase();

      const result = await requirementTool!.handler({
        projectDir: base,
        class: "operability",
        description: "Inline MCP requirement save regression",
        why: "Reproduce missing ensureDbOpen in workflow-tools",
        source: "user",
        status: "active",
        primary_owner: "M010/S10",
        validation: "n/a",
      });

      assert.match((result as any).content[0].text as string, /Saved requirement R\d+/);
      assert.ok(existsSync(join(base, ".gsd", "REQUIREMENTS.md")), "REQUIREMENTS.md should be written to disk");
      const row = _getAdapter()!
        .prepare("SELECT id, class, description FROM requirements WHERE description = ?")
        .get("Inline MCP requirement save regression") as Record<string, unknown> | undefined;
      assert.ok(row, "requirement should be written to the database");
      assert.equal(row["class"], "operability");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_plan_task reopens the DB before inline task planning writes", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_plan_task");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task planning tool should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M010",
        title: "Inline task planning DB reopen",
        vision: "Seed a slice, close the DB, then plan another task inline.",
        slices: [
          {
            sliceId: "S10",
            title: "Inline task planning",
            risk: "medium",
            depends: [],
            demo: "Inline gsd_plan_task reopens the DB after it was closed.",
            goal: "Preserve MCP task planning after the DB adapter is closed.",
            successCriteria: "The second task plan persists after a closed DB is reopened.",
            proofLevel: "integration",
            integrationClosure: "The inline MCP handler reopens the DB before planning.",
            observabilityImpact: "workflow-tools MCP tests cover the inline reopen path.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M010",
        sliceId: "S10",
        goal: "Create the initial slice plan before closing the DB.",
        tasks: [
          {
            taskId: "T10",
            title: "Seed existing task",
            description: "Create the initial task plan before closing the DB.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M010-ROADMAP.md"],
            expectedOutput: ["T10-PLAN.md"],
          },
        ],
      });

      closeDatabase();

      const result = await taskTool!.handler({
        projectDir: base,
        milestoneId: "M010",
        sliceId: "S10",
        taskId: "T11",
        title: "Reopen and plan",
        description: "Exercise the inline plan-task path after the DB was closed.",
        estimate: "5m",
        files: ["packages/mcp-server/src/workflow-tools.ts"],
        verify: "node --test",
        inputs: ["M010-ROADMAP.md", "S10-PLAN.md"],
        expectedOutput: ["T11-PLAN.md"],
      });

      assert.match((result as any).content[0].text as string, /Planned task T11/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M010", "slices", "S10", "tasks", "T11-PLAN.md")),
        "T11 plan should be written after reopening the DB",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_replan_slice and gsd_slice_replan work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const canonicalTool = server.tools.find((t) => t.name === "gsd_replan_slice");
      const aliasTool = server.tools.find((t) => t.name === "gsd_slice_replan");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(canonicalTool, "slice replanning tool should be registered");
      assert.ok(aliasTool, "slice replanning alias should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        title: "Slice replanning",
        vision: "Drive replan parity over MCP.",
        slices: [
          {
            sliceId: "S09",
            title: "Replan slice",
            risk: "medium",
            depends: [],
            demo: "Slice replans after a blocker task completes.",
            goal: "Prepare replan state.",
            successCriteria: "Plan and replan artifacts update over MCP.",
            proofLevel: "integration",
            integrationClosure: "Replan uses the shared executor path.",
            observabilityImpact: "Tests cover replan artifacts.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        goal: "Plan a slice that will be replanned.",
        tasks: [
          {
            taskId: "T09",
            title: "Blocker task",
            description: "Finish the blocker-discovery task.",
            estimate: "5m",
            files: ["src/blocker.ts"],
            verify: "node --test",
            inputs: ["M099-ROADMAP.md"],
            expectedOutput: ["T09-SUMMARY.md"],
          },
          {
            taskId: "T10",
            title: "Pending task",
            description: "Original follow-up task.",
            estimate: "10m",
            files: ["src/pending.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"],
          },
        ],
      });
      await taskTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        taskId: "T09",
        oneLiner: "Completed blocker task",
        narrative: "Prepared the slice for replanning.",
        verification: "node --test",
      });

      const canonicalResult = await canonicalTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        blockerTaskId: "T09",
        blockerDescription: "Original approach is no longer viable.",
        whatChanged: "Updated the remaining task and added remediation work.",
        updatedTasks: [
          {
            taskId: "T10",
            title: "Pending task (updated)",
            description: "Updated follow-up task after replanning.",
            estimate: "15m",
            files: ["src/pending.ts", "src/replanned.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"],
          },
          {
            taskId: "T11",
            title: "Remediation task",
            description: "New task introduced by the replan.",
            estimate: "20m",
            files: ["src/remediation.ts"],
            verify: "node --test",
            inputs: ["S09-REPLAN.md"],
            expectedOutput: ["Remediation patch"],
          },
        ],
        removedTaskIds: [],
      });
      assert.match((canonicalResult as any).content[0].text as string, /Replanned slice S09/);

      const aliasResult = await aliasTool!.handler({
        projectDir: base,
        milestoneId: "M099",
        sliceId: "S09",
        blockerTaskId: "T09",
        blockerDescription: "Alias path confirms the same replan flow.",
        whatChanged: "Removed the remediation task after the alias check.",
        updatedTasks: [
          {
            taskId: "T10",
            title: "Pending task (updated again)",
            description: "Alias adjusted the remaining pending task.",
            estimate: "12m",
            files: ["src/pending.ts"],
            verify: "node --test",
            inputs: ["S09-PLAN.md"],
            expectedOutput: ["Updated plan"],
          },
        ],
        removedTaskIds: ["T11"],
      });
      assert.match((aliasResult as any).content[0].text as string, /Replanned slice S09/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M099", "slices", "S09", "S09-REPLAN.md")),
        "replan artifact should exist on disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M099", "slices", "S09", "S09-PLAN.md")),
        "updated plan should exist on disk",
      );
      const removedTask = _getAdapter()!.prepare(
        "SELECT id FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
      ).get("M099", "S09", "T11");
      assert.equal(removedTask, undefined, "alias should remove the replanned task");
    } finally {
      cleanup(base);
    }
  });

  it("gsd_slice_complete and gsd_complete_slice work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const canonicalTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const aliasTool = server.tools.find((t) => t.name === "gsd_complete_slice");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(canonicalTool, "slice completion tool should be registered");
      assert.ok(aliasTool, "slice completion alias should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M003",
        title: "Demo milestone",
        vision: "Prepare canonical slice completion state.",
        slices: [
          {
            sliceId: "S03",
            title: "Demo Slice",
            risk: "medium",
            depends: [],
            demo: "Canonical slice completes through MCP.",
            goal: "Seed workflow state.",
            successCriteria: "Slice summary and UAT files are written.",
            proofLevel: "integration",
            integrationClosure: "Planning and completion share the MCP bridge.",
            observabilityImpact: "Workflow tests cover canonical completion.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        goal: "Complete canonical slice over MCP.",
        tasks: [
          {
            taskId: "T03",
            title: "Canonical task",
            description: "Seed a completed task for slice completion.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M003-ROADMAP.md"],
            expectedOutput: ["S03-SUMMARY.md", "S03-UAT.md"],
          },
        ],
      });
      await taskTool!.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        taskId: "T03",
        oneLiner: "Completed canonical task",
        narrative: "Prepared the canonical slice for completion.",
        verification: "node --test",
      });

      const canonicalResult = await canonicalTool!.handler({
        projectDir: base,
        milestoneId: "M003",
        sliceId: "S03",
        sliceTitle: "Demo Slice",
        oneLiner: "Completed canonical slice",
        narrative: "Did the slice work",
        verification: "npm test",
        uatContent: "## UAT\n\nPASS",
      });
      assert.match((canonicalResult as any).content[0].text as string, /Completed slice S03/);

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M004",
        title: "Alias milestone",
        vision: "Prepare alias slice completion state.",
        slices: [
          {
            sliceId: "S04",
            title: "Alias Slice",
            risk: "medium",
            depends: [],
            demo: "Alias slice completes through MCP.",
            goal: "Seed alias workflow state.",
            successCriteria: "Alias summary and UAT files are written.",
            proofLevel: "integration",
            integrationClosure: "Alias reaches the shared slice executor.",
            observabilityImpact: "Workflow tests cover alias completion.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        goal: "Complete alias slice over MCP.",
        tasks: [
          {
            taskId: "T04",
            title: "Alias task",
            description: "Seed a completed task for alias slice completion.",
            estimate: "5m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M004-ROADMAP.md"],
            expectedOutput: ["S04-SUMMARY.md", "S04-UAT.md"],
          },
        ],
      });
      await taskTool!.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        taskId: "T04",
        oneLiner: "Completed alias task",
        narrative: "Prepared the alias slice for completion.",
        verification: "node --test",
      });

      const aliasResult = await aliasTool!.handler({
        projectDir: base,
        milestoneId: "M004",
        sliceId: "S04",
        sliceTitle: "Alias Slice",
        oneLiner: "Completed alias slice",
        narrative: "Did the slice work via alias",
        verification: "npm test",
        uatContent: "## UAT\n\nPASS",
      });
      assert.match((aliasResult as any).content[0].text as string, /Completed slice S04/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M004", "slices", "S04", "S04-SUMMARY.md")),
        "alias should write slice summary to disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M004", "slices", "S04", "S04-UAT.md")),
        "alias should write slice UAT to disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_validate_milestone and gsd_milestone_complete work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const completeSliceTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const validateTool = server.tools.find((t) => t.name === "gsd_validate_milestone");
      const completeMilestoneAlias = server.tools.find((t) => t.name === "gsd_milestone_complete");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(completeSliceTool, "slice completion tool should be registered");
      assert.ok(validateTool, "milestone validation tool should be registered");
      assert.ok(completeMilestoneAlias, "milestone completion alias should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        title: "Milestone lifecycle",
        vision: "Drive validation and completion over MCP.",
        slices: [
          {
            sliceId: "S05",
            title: "Lifecycle slice",
            risk: "medium",
            depends: [],
            demo: "Milestone can validate and complete.",
            goal: "Seed milestone completion state.",
            successCriteria: "Summary and validation artifacts are written.",
            proofLevel: "integration",
            integrationClosure: "Lifecycle tools share the MCP bridge.",
            observabilityImpact: "Tests cover milestone end-to-end behavior.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        goal: "Prepare a complete milestone.",
        tasks: [
          {
            taskId: "T05",
            title: "Lifecycle task",
            description: "Seed a fully completed slice.",
            estimate: "10m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M005-ROADMAP.md"],
            expectedOutput: ["M005-VALIDATION.md", "M005-SUMMARY.md"],
          },
        ],
      });
      await taskTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        taskId: "T05",
        oneLiner: "Completed lifecycle task",
        narrative: "Prepared the milestone for closure.",
        verification: "node --test",
      });
      await completeSliceTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        sliceId: "S05",
        sliceTitle: "Lifecycle Slice",
        oneLiner: "Completed lifecycle slice",
        narrative: "Closed the milestone slice.",
        verification: "node --test",
        uatContent: "## UAT\n\nPASS",
      });

      const validationResult = await validateTool!.handler({
        projectDir: base,
        milestoneId: "M005",
        verdict: "pass",
        remediationRound: 0,
        successCriteriaChecklist: "- [x] Lifecycle verified",
        sliceDeliveryAudit: "| Slice | Verdict |\n| --- | --- |\n| S05 | pass |",
        crossSliceIntegration: "No cross-slice mismatches found.",
        requirementCoverage: "No requirement gaps remain.",
        verdictRationale: "The milestone delivered its scope.",
      });
      assert.match((validationResult as any).content[0].text as string, /Validated milestone M005/);

      const completionResult = await completeMilestoneAlias!.handler({
        projectDir: base,
        milestoneId: "M005",
        title: "Milestone lifecycle",
        oneLiner: "Milestone closed successfully",
        narrative: "Validation passed and all slices were complete.",
        verificationPassed: true,
      });
      assert.match((completionResult as any).content[0].text as string, /Completed milestone M005/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M005", "M005-VALIDATION.md")),
        "validation artifact should exist on disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M005", "M005-SUMMARY.md")),
        "milestone summary should exist on disk",
      );
    } finally {
      cleanup(base);
    }
  });

  it("gsd_reassess_roadmap, gsd_roadmap_reassess, and gsd_save_gate_result work end-to-end", async () => {
    const base = makeTmpBase();
    try {
      const server = makeMockServer();
      registerWorkflowTools(server as any);
      const milestoneTool = server.tools.find((t) => t.name === "gsd_plan_milestone");
      const sliceTool = server.tools.find((t) => t.name === "gsd_plan_slice");
      const taskTool = server.tools.find((t) => t.name === "gsd_task_complete");
      const completeSliceTool = server.tools.find((t) => t.name === "gsd_slice_complete");
      const reassessTool = server.tools.find((t) => t.name === "gsd_reassess_roadmap");
      const reassessAlias = server.tools.find((t) => t.name === "gsd_roadmap_reassess");
      const gateTool = server.tools.find((t) => t.name === "gsd_save_gate_result");
      assert.ok(milestoneTool, "milestone planning tool should be registered");
      assert.ok(sliceTool, "slice planning tool should be registered");
      assert.ok(taskTool, "task completion tool should be registered");
      assert.ok(completeSliceTool, "slice completion tool should be registered");
      assert.ok(reassessTool, "roadmap reassessment tool should be registered");
      assert.ok(reassessAlias, "roadmap reassessment alias should be registered");
      assert.ok(gateTool, "gate result tool should be registered");

      await milestoneTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        title: "Roadmap reassessment",
        vision: "Drive gate results and reassessment over MCP.",
        slices: [
          {
            sliceId: "S06",
            title: "Completed slice",
            risk: "medium",
            depends: [],
            demo: "Completed slice triggers reassessment.",
            goal: "Seed reassessment state.",
            successCriteria: "Assessment and roadmap artifacts are written.",
            proofLevel: "integration",
            integrationClosure: "Roadmap updates share the MCP bridge.",
            observabilityImpact: "Tests cover reassessment behavior.",
          },
          {
            sliceId: "S07",
            title: "Follow-up slice",
            risk: "low",
            depends: ["S06"],
            demo: "Follow-up slice remains pending.",
            goal: "Leave room for roadmap edits.",
            successCriteria: "Roadmap mutation succeeds.",
            proofLevel: "integration",
            integrationClosure: "Pending slice can be modified after reassessment.",
            observabilityImpact: "Tests observe roadmap mutation output.",
          },
        ],
      });
      await sliceTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        goal: "Complete the first slice.",
        tasks: [
          {
            taskId: "T06",
            title: "Seed completed slice",
            description: "Prepare gate and reassessment state.",
            estimate: "10m",
            files: ["packages/mcp-server/src/workflow-tools.ts"],
            verify: "node --test",
            inputs: ["M006-ROADMAP.md"],
            expectedOutput: ["S06-ASSESSMENT.md", "M006-ROADMAP.md"],
          },
        ],
      });

      const gateResult = await gateTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        gateId: "Q3",
        verdict: "pass",
        rationale: "Threat surface is covered.",
        findings: "No new attack surface was introduced.",
      });
      assert.match((gateResult as any).content[0].text as string, /Gate Q3 result saved/);
      // #4472: executor `details` must be adapted to MCP `structuredContent`
      // so it survives the protocol transport intact. Asserting property
      // *absence* rather than `=== undefined` so a future regression that
      // explicitly sets `details: undefined` (rather than removing it) still
      // fails this contract test.
      assert.equal(
        Object.prototype.hasOwnProperty.call(gateResult, "details"),
        false,
        "executor `details` field must be stripped from MCP tool result",
      );
      assert.deepEqual(
        (gateResult as any).structuredContent,
        { operation: "save_gate_result", gateId: "Q3", verdict: "pass" },
        "executor details must be forwarded on the MCP `structuredContent` channel",
      );
      const gateRows = _getAdapter()!.prepare(
        "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ?",
      ).all("M006", "S06", "Q3") as Array<Record<string, unknown>>;
      assert.equal(gateRows.length, 1);
      assert.equal(gateRows[0]["status"], "complete");
      assert.equal(gateRows[0]["verdict"], "pass");

      await taskTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        taskId: "T06",
        oneLiner: "Completed reassessment task",
        narrative: "Prepared the slice for reassessment.",
        verification: "node --test",
      });
      await completeSliceTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        sliceId: "S06",
        sliceTitle: "Completed slice",
        oneLiner: "Completed reassessment slice",
        narrative: "Closed the completed slice before reassessment.",
        verification: "node --test",
        uatContent: "## UAT\n\nPASS",
      });

      const reassessResult = await reassessTool!.handler({
        projectDir: base,
        milestoneId: "M006",
        completedSliceId: "S06",
        verdict: "roadmap-adjusted",
        assessment: "Insert remediation work after the completed slice.",
        sliceChanges: {
          modified: [
            {
              sliceId: "S07",
              title: "Follow-up slice (adjusted)",
              risk: "medium",
              depends: ["S06"],
              demo: "Adjusted demo",
            },
          ],
          added: [
            {
              sliceId: "S08",
              title: "Remediation slice",
              risk: "high",
              depends: ["S07"],
              demo: "Remediation demo",
            },
          ],
          removed: [],
        },
      });
      assert.match((reassessResult as any).content[0].text as string, /Reassessed roadmap for milestone M006 after S06/);

      const reassessAliasResult = await reassessAlias!.handler({
        projectDir: base,
        milestoneId: "M006",
        completedSliceId: "S06",
        verdict: "roadmap-confirmed",
        assessment: "No further changes needed after the first reassessment.",
        sliceChanges: {
          modified: [],
          added: [],
          removed: [],
        },
      });
      assert.match((reassessAliasResult as any).content[0].text as string, /Reassessed roadmap for milestone M006 after S06/);
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M006", "slices", "S06", "S06-ASSESSMENT.md")),
        "assessment artifact should exist on disk",
      );
      assert.ok(
        existsSync(join(base, ".gsd", "milestones", "M006", "M006-ROADMAP.md")),
        "roadmap artifact should exist on disk",
      );
    } finally {
      cleanup(base);
    }
  });
});

describe("URL scheme regex — Windows drive letter safety", () => {
  // This is the regex used in getWriteGateModuleCandidates() and
  // getWorkflowExecutorModuleCandidates() to reject non-file URL schemes.
  // It must NOT match single-letter Windows drive prefixes (C:, D:, etc.).
  const urlSchemeRegex = /^[a-z]{2,}:/i;

  it("rejects multi-letter URL schemes", () => {
    assert.ok(urlSchemeRegex.test("http://example.com"), "http: should match");
    assert.ok(urlSchemeRegex.test("https://example.com"), "https: should match");
    assert.ok(urlSchemeRegex.test("ftp://files.example.com"), "ftp: should match");
    assert.ok(urlSchemeRegex.test("file:///C:/Users"), "file: should match");
    assert.ok(urlSchemeRegex.test("node:fs"), "node: should match");
  });

  it("allows single-letter Windows drive prefixes", () => {
    assert.ok(!urlSchemeRegex.test("C:\\Users\\user\\project"), "C:\\ should not match");
    assert.ok(!urlSchemeRegex.test("D:\\other\\path"), "D:\\ should not match");
    assert.ok(!urlSchemeRegex.test("c:\\lowercase\\drive"), "c:\\ should not match");
    assert.ok(!urlSchemeRegex.test("E:/forward/slash/path"), "E:/ should not match");
  });

  it("allows bare filesystem paths", () => {
    assert.ok(!urlSchemeRegex.test("/usr/local/lib/module.js"), "unix absolute path should not match");
    assert.ok(!urlSchemeRegex.test("./relative/path.js"), "relative path should not match");
    assert.ok(!urlSchemeRegex.test("../parent/path.js"), "parent relative path should not match");
  });
});

// ---------------------------------------------------------------------------
// validateProjectDir — symlink containment hardening (#4476)
// ---------------------------------------------------------------------------
//
// The regression: a symlink inside the allowed root could point outside it,
// and a lexical-only containment check would happily admit the path. The fix
// realpath()s the candidate (and the allowed root) before checking
// containment, falling back to the lexical path only when the candidate
// itself does not exist (a legitimate brand-new-worktree case).

describe("validateProjectDir", () => {
  it("rejects a symlink inside the allowed root that points outside it", () => {
    const allowedRoot = makeTmpBase();
    const outside = makeTmpBase();
    const linkInside = join(allowedRoot, "escape-link");
    symlinkSync(outside, linkInside, "dir");

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      assert.throws(
        () => validateProjectDir(linkInside),
        /configured workflow project root/,
        "symlink-to-outside must not bypass the containment check",
      );
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
      cleanup(outside);
    }
  });

  it("accepts a non-existent path inside the allowed root (new worktree case)", () => {
    const allowedRoot = makeTmpBase();
    // Use the realpath form so that on platforms where /tmp resolves through a
    // symlink (macOS /var → /private/var) the lexical fallback for ENOENT
    // candidates still lines up with the allowed root.
    const canonicalRoot = realpathSync(allowedRoot);
    const futureWorktree = join(canonicalRoot, "worktrees", "M999-not-yet-created");

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = canonicalRoot;
      const result = validateProjectDir(futureWorktree);
      assert.equal(result, futureWorktree, "ENOENT should fall back to the lexical path, not throw");
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
    }
  });

  it("accepts a real directory inside the allowed root", () => {
    const allowedRoot = makeTmpBase();
    const child = join(allowedRoot, "child");
    mkdirSync(child, { recursive: true });

    const prevRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    try {
      process.env.GSD_WORKFLOW_PROJECT_ROOT = allowedRoot;
      const result = validateProjectDir(child);
      // realpath may canonicalize macOS /var → /private/var; assert it ends with our child segment.
      assert.ok(result.endsWith("child"), `expected resolved path to end with 'child', got ${result}`);
    } finally {
      if (prevRoot === undefined) {
        delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      } else {
        process.env.GSD_WORKFLOW_PROJECT_ROOT = prevRoot;
      }
      cleanup(allowedRoot);
    }
  });

  it("rejects relative paths", () => {
    assert.throws(
      () => validateProjectDir("relative/path"),
      /must be an absolute path/,
    );
  });
});
