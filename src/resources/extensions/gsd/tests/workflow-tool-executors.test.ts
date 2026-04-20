import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertGateRow,
} from "../gsd-db.ts";
import { markDepthVerified, clearDiscussionFlowState, loadWriteGateSnapshot } from "../bootstrap/write-gate.ts";
import {
  executeCompleteMilestone,
  executePlanMilestone,
  executePlanSlice,
  executeReplanSlice,
  executeReassessRoadmap,
  executeSaveGateResult,
  executeSummarySave,
  executeTaskComplete,
  executeMilestoneStatus,
  executeSliceComplete,
  executeValidateMilestone,
} from "../tools/workflow-tool-executors.ts";

function makeTmpBase(): string {
  const base = join(tmpdir(), `gsd-workflow-executors-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* swallow */ }
}

function openTestDb(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
}

async function inProjectDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

function seedMilestone(milestoneId: string, title: string, status = "active"): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO milestones (id, title, status, created_at) VALUES (?, ?, ?, ?)",
  ).run(milestoneId, title, status, new Date().toISOString());
}

function seedSlice(milestoneId: string, sliceId: string, status: string): void {
  const db = _getAdapter();
  if (!db) throw new Error("DB not open");
  db.prepare(
    "INSERT OR REPLACE INTO slices (milestone_id, id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(milestoneId, sliceId, `Slice ${sliceId}`, status, new Date().toISOString());
}

function writeRoadmap(base: string, milestoneId: string, sliceIds: string[]): void {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  const lines = [
    `# ${milestoneId}: Workflow MCP planning`,
    "",
    "## Slices",
    "",
    ...sliceIds.map((sliceId) => `- [ ] **${sliceId}: Slice ${sliceId}** \`risk:medium\` \`depends:[]\`\n  - After this: demo`),
    "",
  ];
  writeFileSync(join(milestoneDir, `${milestoneId}-ROADMAP.md`), lines.join("\n"));
}

test("executeSummarySave persists artifact and returns computed path", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S01",
      artifact_type: "SUMMARY",
      content: "# Summary\n\ncontent",
    }, base));

    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.path, "milestones/M001/slices/S01/S01-SUMMARY.md");

    const filePath = join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-SUMMARY.md");
    assert.ok(existsSync(filePath), "summary artifact should be written to disk");
    assert.match(readFileSync(filePath, "utf-8"), /# Summary/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeTaskComplete coerces string verificationEvidence entries", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    const planDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "S01-PLAN.md"), "# S01\n\n- [ ] **T01: Demo** `est:5m`\n");

    const result = await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      oneLiner: "Completed task",
      narrative: "Did the work",
      verification: "npm test",
      verificationEvidence: ["npm test"],
    }, base));

    assert.equal(result.details.operation, "complete_task");
    assert.equal(result.details.taskId, "T01");

    const db = _getAdapter();
    assert.ok(db, "DB should be open");
    const rows = db!.prepare(
      "SELECT command, exit_code, verdict, duration_ms FROM verification_evidence WHERE milestone_id = ? AND slice_id = ? AND task_id = ?",
    ).all("M001", "S01", "T01") as Array<Record<string, unknown>>;

    assert.equal(rows.length, 1, "one coerced verification evidence row should be inserted");
    assert.equal(rows[0]["command"], "npm test");
    assert.equal(rows[0]["exit_code"], -1);
    assert.match(String(rows[0]["verdict"]), /coerced from string/);

    const summaryPath = String(result.details.summaryPath);
    assert.ok(existsSync(summaryPath), "task summary should be written to disk");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeMilestoneStatus returns milestone metadata and slice counts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "active");
    const db = _getAdapter();
    db!.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
    ).run("M001", "S01", "T01", "Task T01", "pending");

    const result = await inProjectDir(base, () => executeMilestoneStatus({ milestoneId: "M001" }, base));
    const parsed = JSON.parse(result.content[0].text);

    assert.equal(parsed.milestoneId, "M001");
    assert.equal(parsed.title, "Milestone One");
    assert.equal(parsed.sliceCount, 1);
    assert.equal(parsed.slices[0].id, "S01");
    assert.equal(parsed.slices[0].taskCounts.pending, 1);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanMilestone writes roadmap state and rendered roadmap path", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const result = await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M001",
      title: "Workflow MCP planning",
      vision: "Plan milestone over shared executors.",
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
    }, base));

    assert.equal(result.details.operation, "plan_milestone");
    assert.equal(result.details.milestoneId, "M001");
    const roadmapPath = String(result.details.roadmapPath);
    assert.ok(existsSync(roadmapPath), "roadmap should be rendered to disk");
    assert.match(readFileSync(roadmapPath, "utf-8"), /Workflow MCP planning/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanSlice writes task planning state and rendered plan artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M001",
      title: "Workflow MCP planning",
      vision: "Plan milestone over shared executors.",
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
    }, base));

    const result = await inProjectDir(base, () => executePlanSlice({
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
    }, base));

    assert.equal(result.details.operation, "plan_slice");
    assert.equal(result.details.sliceId, "S01");
    const planPath = String(result.details.planPath);
    assert.ok(existsSync(planPath), "slice plan should be rendered to disk");
    assert.match(readFileSync(planPath, "utf-8"), /Persist slice plan over MCP/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executePlanSlice marks validation failures with isError", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const result = await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M001",
      sliceId: "S01",
      goal: "Trigger validation failure for empty tasks.",
      tasks: [],
    }, base));

    assert.equal(result.isError, true);
    assert.equal(result.details.operation, "plan_slice");
    assert.match(String(result.details.error), /validation failed: tasks must be a non-empty array/);
    assert.match(result.content[0].text, /Error planning slice:/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSliceComplete coerces string enrichment entries and writes summary/UAT artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M001", "Milestone One");
    seedSlice("M001", "S01", "pending");
    writeRoadmap(base, "M001", ["S01"]);
    const db = _getAdapter();
    db!.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
    ).run("M001", "S01", "T01", "Task T01", "complete");

    const rawParams = {
      milestoneId: "M001",
      sliceId: "S01",
      sliceTitle: "Slice S01",
      oneLiner: "Completed slice",
      narrative: "Implemented the slice",
      verification: "node --test",
      uatContent: "## UAT\n\nPASS",
      provides: "shared executor path",
      requirementsAdvanced: ["R001 - added slice completion support"],
      filesModified: ["src/file.ts - updated logic"],
      requires: ["S00 - upstream context"],
    } as unknown as Parameters<typeof executeSliceComplete>[0];

    const result = await inProjectDir(base, () => executeSliceComplete(rawParams, base));

    assert.equal(result.details.operation, "complete_slice");
    const summaryPath = String(result.details.summaryPath);
    const uatPath = String(result.details.uatPath);
    assert.ok(existsSync(summaryPath), "slice summary should be written to disk");
    assert.ok(existsSync(uatPath), "slice UAT should be written to disk");
    assert.match(readFileSync(summaryPath, "utf-8"), /shared executor path/);
    assert.match(readFileSync(summaryPath, "utf-8"), /R001/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeValidateMilestone persists validation artifact and gate records", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M002", "Milestone Two");
    seedSlice("M002", "S02", "complete");

    const result = await inProjectDir(base, () => executeValidateMilestone({
      milestoneId: "M002",
      verdict: "pass",
      remediationRound: 0,
      successCriteriaChecklist: "- [x] Works",
      sliceDeliveryAudit: "| Slice | Result |\n| --- | --- |\n| S02 | pass |",
      crossSliceIntegration: "No cross-slice issues.",
      requirementCoverage: "All requirements covered.",
      verdictRationale: "Everything passed.",
    }, base));

    assert.equal(result.details.operation, "validate_milestone");
    const validationPath = String(result.details.validationPath);
    assert.ok(existsSync(validationPath), "validation file should be written to disk");

    const db = _getAdapter();
    const gates = db!.prepare(
      "SELECT gate_id, verdict FROM quality_gates WHERE milestone_id = ? ORDER BY gate_id",
    ).all("M002") as Array<Record<string, unknown>>;
    assert.ok(gates.length > 0, "validation should seed milestone quality gates");
    assert.equal(gates[0]["verdict"], "pass");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeCompleteMilestone sanitizes raw params and writes milestone summary", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M003", "Milestone Three");
    seedSlice("M003", "S03", "complete");
    writeRoadmap(base, "M003", ["S03"]);
    const db = _getAdapter();
    db!.prepare(
      "INSERT OR REPLACE INTO tasks (milestone_id, slice_id, id, title, status) VALUES (?, ?, ?, ?, ?)",
    ).run("M003", "S03", "T03", "Task T03", "complete");

    const rawParams = {
      milestoneId: "M003",
      title: "Milestone Three",
      oneLiner: "Completed milestone",
      narrative: "Everything shipped.",
      verificationPassed: "true",
      keyDecisions: ["shared executor path"],
      lessonsLearned: ["MCP transport stays generic"],
    } as unknown as Parameters<typeof executeCompleteMilestone>[0];

    const result = await inProjectDir(base, () => executeCompleteMilestone(rawParams, base));

    assert.equal(result.details.operation, "complete_milestone");
    const summaryPath = String(result.details.summaryPath);
    assert.ok(existsSync(summaryPath), "milestone summary should be written to disk");
    assert.match(readFileSync(summaryPath, "utf-8"), /shared executor path/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeReassessRoadmap writes assessment and updates roadmap projection", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M004",
      title: "Milestone Four",
      vision: "Exercise roadmap reassessment.",
      slices: [
        {
          sliceId: "S04",
          title: "Completed slice",
          risk: "medium",
          depends: [],
          demo: "Completed slice works",
          goal: "Complete the first slice.",
          successCriteria: "S04 is complete.",
          proofLevel: "integration",
          integrationClosure: "Baseline flow is wired.",
          observabilityImpact: "Executor test covers reassessment.",
        },
        {
          sliceId: "S05",
          title: "Follow-up slice",
          risk: "medium",
          depends: ["S04"],
          demo: "Follow-up slice is adjusted",
          goal: "Handle the follow-up work.",
          successCriteria: "Roadmap gets updated.",
          proofLevel: "integration",
          integrationClosure: "Downstream work stays aligned.",
          observabilityImpact: "Assessment artifact is rendered.",
        },
      ],
    }, base));
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M004",
      sliceId: "S04",
      goal: "Complete the first slice.",
      tasks: [
        {
          taskId: "T04",
          title: "Finish slice",
          description: "Close the completed slice.",
          estimate: "5m",
          files: ["src/file.ts"],
          verify: "node --test",
          inputs: ["M004-ROADMAP.md"],
          expectedOutput: ["S04-SUMMARY.md", "S04-UAT.md"],
        },
      ],
    }, base));
    await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M004",
      sliceId: "S04",
      taskId: "T04",
      oneLiner: "Completed task",
      narrative: "Task finished.",
      verification: "node --test",
    }, base));
    await inProjectDir(base, () => executeSliceComplete({
      milestoneId: "M004",
      sliceId: "S04",
      sliceTitle: "Completed slice",
      oneLiner: "Completed slice",
      narrative: "Slice finished.",
      verification: "node --test",
      uatContent: "## UAT\n\nPASS",
    }, base));

    const result = await inProjectDir(base, () => executeReassessRoadmap({
      milestoneId: "M004",
      completedSliceId: "S04",
      verdict: "roadmap-adjusted",
      assessment: "Added a remediation slice.",
      sliceChanges: {
        modified: [
          {
            sliceId: "S05",
            title: "Adjusted follow-up slice",
            risk: "high",
            depends: ["S04"],
            demo: "Adjusted follow-up demo",
          },
        ],
        added: [
          {
            sliceId: "S06",
            title: "Remediation slice",
            risk: "medium",
            depends: ["S05"],
            demo: "Remediation slice demo",
          },
        ],
        removed: [],
      },
    }, base));

    assert.equal(result.details.operation, "reassess_roadmap");
    const assessmentPath = String(result.details.assessmentPath);
    const roadmapPath = String(result.details.roadmapPath);
    assert.ok(existsSync(assessmentPath), "assessment file should be written");
    assert.ok(existsSync(roadmapPath), "roadmap should be re-rendered");
    assert.match(readFileSync(roadmapPath, "utf-8"), /S06/);
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSaveGateResult validates inputs and persists verdicts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    seedMilestone("M005", "Milestone Five");
    seedSlice("M005", "S05", "pending");
    insertGateRow({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      scope: "slice",
    });

    const result = await inProjectDir(base, () => executeSaveGateResult({
      milestoneId: "M005",
      sliceId: "S05",
      gateId: "Q3",
      verdict: "pass",
      rationale: "Looks good.",
      findings: "No issues found.",
    }, base));

    assert.equal(result.details.operation, "save_gate_result");
    const db = _getAdapter();
    const row = db!.prepare(
      "SELECT status, verdict, rationale FROM quality_gates WHERE milestone_id = ? AND slice_id = ? AND gate_id = ? AND task_id = ''",
    ).get("M005", "S05", "Q3") as Record<string, unknown> | undefined;
    assert.equal(row?.status, "complete");
    assert.equal(row?.verdict, "pass");
    assert.equal(row?.rationale, "Looks good.");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeReplanSlice rewrites pending tasks and renders replan artifacts", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    await inProjectDir(base, () => executePlanMilestone({
      milestoneId: "M006",
      title: "Milestone Six",
      vision: "Exercise slice replanning.",
      slices: [
        {
          sliceId: "S06",
          title: "Replan slice",
          risk: "medium",
          depends: [],
          demo: "Slice can be replanned after a blocker task completes.",
          goal: "Prepare replan state.",
          successCriteria: "PLAN and REPLAN artifacts update.",
          proofLevel: "integration",
          integrationClosure: "Replan shares the workflow executor path.",
          observabilityImpact: "Executor test covers replan output files.",
        },
      ],
    }, base));
    await inProjectDir(base, () => executePlanSlice({
      milestoneId: "M006",
      sliceId: "S06",
      goal: "Plan a slice that will be replanned.",
      tasks: [
        {
          taskId: "T06",
          title: "Blocker task",
          description: "Finish the blocker-discovery task.",
          estimate: "5m",
          files: ["src/blocker.ts"],
          verify: "node --test",
          inputs: ["M006-ROADMAP.md"],
          expectedOutput: ["T06-SUMMARY.md"],
        },
        {
          taskId: "T07",
          title: "Pending task",
          description: "Original follow-up task.",
          estimate: "10m",
          files: ["src/pending.ts"],
          verify: "node --test",
          inputs: ["S06-PLAN.md"],
          expectedOutput: ["Updated plan"],
        },
      ],
    }, base));
    await inProjectDir(base, () => executeTaskComplete({
      milestoneId: "M006",
      sliceId: "S06",
      taskId: "T06",
      oneLiner: "Completed blocker task",
      narrative: "The blocker was identified and documented.",
      verification: "node --test",
    }, base));

    const result = await inProjectDir(base, () => executeReplanSlice({
      milestoneId: "M006",
      sliceId: "S06",
      blockerTaskId: "T06",
      blockerDescription: "Original approach no longer works.",
      whatChanged: "Adjusted the remaining tasks and added a remediation task.",
      updatedTasks: [
        {
          taskId: "T07",
          title: "Pending task (updated)",
          description: "Updated follow-up task after replanning.",
          estimate: "15m",
          files: ["src/pending.ts", "src/replanned.ts"],
          verify: "node --test",
          inputs: ["S06-PLAN.md"],
          expectedOutput: ["Updated plan"],
        },
        {
          taskId: "T08",
          title: "Remediation task",
          description: "New task introduced by the replan.",
          estimate: "20m",
          files: ["src/remediation.ts"],
          verify: "node --test",
          inputs: ["S06-REPLAN.md"],
          expectedOutput: ["Remediation patch"],
        },
      ],
      removedTaskIds: [],
    }, base));

    assert.equal(result.details.operation, "replan_slice");
    const planPath = String(result.details.planPath);
    const replanPath = String(result.details.replanPath);
    assert.ok(existsSync(planPath), "replanned plan should exist on disk");
    assert.ok(existsSync(replanPath), "replan artifact should exist on disk");
    assert.match(readFileSync(planPath, "utf-8"), /T08/);
    assert.match(readFileSync(replanPath, "utf-8"), /Adjusted the remaining tasks/);

    const db = _getAdapter();
    const updatedTask = db!.prepare(
      "SELECT title FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).get("M006", "S06", "T07") as Record<string, unknown> | undefined;
    const insertedTask = db!.prepare(
      "SELECT title FROM tasks WHERE milestone_id = ? AND slice_id = ? AND id = ?",
    ).get("M006", "S06", "T08") as Record<string, unknown> | undefined;
    assert.equal(updatedTask?.title, "Pending task (updated)");
    assert.equal(insertedTask?.title, "Remediation task");
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave removes sibling CONTEXT-DRAFT when writing milestone CONTEXT (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);
    markDepthVerified("M001", base);

    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    const draftPath = join(milestoneDir, "M001-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Draft\n\nincremental notes");
    assert.ok(existsSync(draftPath), "precondition: draft exists");

    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\nfinal discussion output",
    }, base));

    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.artifact_type, "CONTEXT");

    const contextPath = join(milestoneDir, "M001-CONTEXT.md");
    assert.ok(existsSync(contextPath), "CONTEXT.md should be written");
    assert.equal(
      existsSync(draftPath),
      false,
      "CONTEXT-DRAFT.md should be removed after final CONTEXT.md is written",
    );
  } finally {
    clearDiscussionFlowState();
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave removes sibling CONTEXT-DRAFT when writing slice CONTEXT (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
    mkdirSync(sliceDir, { recursive: true });
    const draftPath = join(sliceDir, "S01-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Slice Draft\n\nincremental slice notes");
    assert.ok(existsSync(draftPath), "precondition: slice draft exists");

    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      slice_id: "S01",
      artifact_type: "CONTEXT",
      content: "# Slice Context\n\nfinal slice output",
    }, base));

    assert.equal(result.details.operation, "save_summary");
    assert.equal(result.details.artifact_type, "CONTEXT");

    const contextPath = join(sliceDir, "S01-CONTEXT.md");
    assert.ok(existsSync(contextPath), "slice CONTEXT.md should be written");
    assert.equal(
      existsSync(draftPath),
      false,
      "slice CONTEXT-DRAFT.md should be removed after final CONTEXT.md is written",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave leaves sibling CONTEXT-DRAFT intact for non-CONTEXT artifacts (#4442)", async () => {
  const base = makeTmpBase();
  try {
    openTestDb(base);

    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    const draftPath = join(milestoneDir, "M001-CONTEXT-DRAFT.md");
    writeFileSync(draftPath, "# Draft\n\nstill in progress");

    const result = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "RESEARCH",
      content: "# Research\n\nresearch notes",
    }, base));

    assert.equal(result.details.artifact_type, "RESEARCH");
    assert.ok(
      existsSync(draftPath),
      "CONTEXT-DRAFT.md must survive RESEARCH/SUMMARY/ASSESSMENT writes",
    );
  } finally {
    closeDatabase();
    cleanup(base);
  }
});

test("executeSummarySave CONTEXT HARD BLOCK clears after write-gate state file is deleted (#4343)", async () => {
  const base = makeTmpBase();
  const originalEnv = process.env.GSD_PERSIST_WRITE_GATE_STATE;
  process.env.GSD_PERSIST_WRITE_GATE_STATE = "1";
  try {
    openTestDb(base);
    clearDiscussionFlowState();

    // First call: CONTEXT artifact without depth verification → HARD BLOCK
    const blocked = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\ncontent",
    }, base));
    assert.equal(blocked.isError, true, "should be blocked without depth verification");
    assert.match(
      blocked.content[0].text,
      /HARD BLOCK/,
      "blocked result should mention HARD BLOCK",
    );

    // Verify the state file was written (persist mode is active)
    const stateFilePath = join(base, ".gsd", "runtime", "write-gate-state.json");
    // The state file may or may not exist at this point (block doesn't write state).
    // Write a fake state file simulating stale persisted block state.
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify({
      verifiedDepthMilestones: [],
      activeQueuePhase: false,
      pendingGateId: "depth_verification_M001",
    }));

    // User deletes the state file to reset the block
    unlinkSync(stateFilePath);
    assert.ok(!existsSync(stateFilePath), "state file deleted");

    // The snapshot loaded after deletion should be clean (no pending gate, no block)
    const snapshot = loadWriteGateSnapshot(base);
    assert.equal(snapshot.pendingGateId, null, "pendingGateId should be null after file deletion");
    assert.deepEqual(snapshot.verifiedDepthMilestones, [], "verifiedDepthMilestones should be empty after file deletion");

    // Depth-verify and re-attempt: should succeed after deletion clears stale state
    markDepthVerified("M001", base);

    const unblocked = await inProjectDir(base, () => executeSummarySave({
      milestone_id: "M001",
      artifact_type: "CONTEXT",
      content: "# Context\n\nfinal content",
    }, base));
    assert.equal(unblocked.isError, undefined, "should not be blocked after depth verification");
    assert.equal(unblocked.details.operation, "save_summary");
  } finally {
    if (originalEnv === undefined) {
      delete process.env.GSD_PERSIST_WRITE_GATE_STATE;
    } else {
      process.env.GSD_PERSIST_WRITE_GATE_STATE = originalEnv;
    }
    clearDiscussionFlowState();
    closeDatabase();
    cleanup(base);
  }
});
