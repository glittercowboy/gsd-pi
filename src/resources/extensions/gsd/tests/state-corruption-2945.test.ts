/**
 * Regression tests for issue #2945: State corruption in milestone/slice completion workflow.
 *
 * Covers all 4 sub-bugs:
 *   Bug 1: ROADMAP corrupted by inline UAT content in table rows
 *   Bug 2: complete-milestone event replay bypasses task validation
 *   Bug 3: Worktree directory not cleaned up after mergeAndExit
 *   Bug 4: Quality gate records not written by validate-milestone
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getMilestoneSlices,
  getSliceTasks,
  getGateResults,
} from "../gsd-db.ts";
import { renderRoadmapContent } from "../workflow-projections.ts";
import type { MilestoneRow, SliceRow } from "../gsd-db.ts";
import type { AutoSession } from "../auto/session.ts";

// ─── Fixture helpers ────────────────────────────────────────────────────────

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-2945-"));
  return join(dir, "test.db");
}

function cleanupDb(dbPath: string): void {
  closeDatabase();
  try {
    const dir = join(dbPath, "..");
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function createTempProject(): { basePath: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-2945-project-"));
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  return { basePath };
}

function makeMilestoneRow(overrides: Partial<MilestoneRow> = {}): MilestoneRow {
  return {
    id: "M001",
    title: "Test Milestone",
    vision: "Build a test milestone",
    status: "active",
    depends_on: [],
    created_at: new Date().toISOString(),
    completed_at: null,
    success_criteria: ["SC1", "SC2"],
    key_risks: [],
    proof_strategy: [],
    verification_contract: "",
    verification_integration: "",
    verification_operational: "",
    verification_uat: "",
    definition_of_done: [],
    requirement_coverage: "",
    boundary_map_markdown: "",
    ...overrides,
  };
}

function makeSliceRow(id: string, overrides: Partial<SliceRow> = {}): SliceRow {
  return {
    id,
    milestone_id: "M001",
    title: `Slice ${id}`,
    goal: `Goal for ${id}`,
    demo: `Demo for ${id}`,
    risk: "medium",
    status: "pending",
    sequence: parseInt(id.replace("S", ""), 10) || 0,
    depends: [],
    created_at: new Date().toISOString(),
    completed_at: null,
    full_summary_md: "",
    full_uat_md: "",
    success_criteria: "",
    proof_level: "",
    integration_closure: "",
    observability_impact: "",
    replan_triggered_at: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 1: ROADMAP corrupted by inline UAT content
// ═══════════════════════════════════════════════════════════════════════════════

describe("#2945 Bug 1: ROADMAP table cell corruption by UAT content", () => {

  test("renderRoadmapContent does NOT inject full_uat_md into table rows when demo is empty", () => {
    const milestone = makeMilestoneRow();

    const longUatContent = `### Preconditions
- Database initialized
- Service running

### Steps
1. Open the application
2. Navigate to settings
3. Enable dark mode

### Expected
- Theme changes to dark
- All components update`;

    const slices: SliceRow[] = [
      makeSliceRow("S01", {
        status: "complete",
        demo: "",                     // empty demo
        full_uat_md: longUatContent,  // full UAT content in DB
      }),
      makeSliceRow("S02", {
        status: "pending",
        demo: "Advanced stuff works",
      }),
    ];

    const content = renderRoadmapContent(milestone, slices);

    // The roadmap table row for S01 should NOT contain UAT content
    assert.ok(
      !content.includes("Preconditions"),
      "roadmap table row must not contain UAT preconditions",
    );
    assert.ok(
      !content.includes("Navigate to settings"),
      "roadmap table row must not contain UAT steps",
    );

    // Each table row should be a reasonable length (under 200 chars)
    const lines = content.split("\n");
    const s01Row = lines.find(l => l.includes("| S01 |"));
    assert.ok(s01Row, "S01 should appear as a table row");
    assert.ok(
      s01Row!.length < 200,
      `S01 row should be under 200 chars, got ${s01Row!.length}: ${s01Row!.slice(0, 100)}...`,
    );

    // S02 should still be visible
    assert.ok(content.includes("| S02 |"), "S02 must still be visible in roadmap table");
  });

  test("renderRoadmapContent uses 'TBD' fallback when demo is empty, not full_uat_md", () => {
    const milestone = makeMilestoneRow();
    const slices: SliceRow[] = [
      makeSliceRow("S01", { demo: "", full_uat_md: "Long UAT content here" }),
    ];

    const content = renderRoadmapContent(milestone, slices);
    assert.ok(
      content.includes("TBD"),
      "empty demo should fallback to 'TBD', not full_uat_md",
    );
    assert.ok(
      !content.includes("Long UAT content here"),
      "full_uat_md should never appear in roadmap table",
    );
  });

  test("renderRoadmapContent preserves demo field when present", () => {
    const milestone = makeMilestoneRow();
    const slices: SliceRow[] = [
      makeSliceRow("S01", { demo: "Basic functionality works", full_uat_md: "Full UAT" }),
    ];

    const content = renderRoadmapContent(milestone, slices);
    assert.ok(
      content.includes("Basic functionality works"),
      "demo field should be used when present",
    );
    assert.ok(
      !content.includes("Full UAT"),
      "full_uat_md should not be used when demo is present",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 2: complete-milestone event replay bypasses task validation
// ═══════════════════════════════════════════════════════════════════════════════

describe("#2945 Bug 2: workflow-reconcile bypasses task validation for complete_slice", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    openDatabase(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  test("replaySliceComplete must not mark slice done when tasks are pending", async () => {
    // Set up: M001 with S01 that has 2 tasks, one pending
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", title: "Done task" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "pending", title: "Pending task" });

    // Import and call replaySliceComplete directly
    const { replaySliceComplete } = await import("../workflow-reconcile.ts");
    replaySliceComplete("M001", "S01", new Date().toISOString());

    // The slice should NOT be marked done because T02 is still pending
    const slices = getMilestoneSlices("M001");
    const s01 = slices.find(s => s.id === "S01");
    assert.ok(s01, "S01 should exist");
    assert.notStrictEqual(
      s01!.status,
      "done",
      "replaySliceComplete must not mark slice as done when tasks are pending",
    );
    assert.notStrictEqual(
      s01!.status,
      "complete",
      "replaySliceComplete must not mark slice as complete when tasks are pending",
    );
  });

  test("replaySliceComplete marks slice done when all tasks are complete", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", title: "Done task" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", status: "done", title: "Also done" });

    const { replaySliceComplete } = await import("../workflow-reconcile.ts");
    replaySliceComplete("M001", "S01", new Date().toISOString());

    const slices = getMilestoneSlices("M001");
    const s01 = slices.find(s => s.id === "S01");
    assert.ok(s01, "S01 should exist");
    assert.strictEqual(
      s01!.status,
      "done",
      "replaySliceComplete should mark slice as done when all tasks are complete",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 3: Worktree directory not cleaned up after mergeAndExit
// ═══════════════════════════════════════════════════════════════════════════════

describe("#2945 Bug 3: mergeAndExit must teardown worktree after successful merge", () => {

  test("_mergeWorktreeMode calls teardownAutoWorktree after successful merge", async () => {
    // Test the WorktreeResolver to verify teardown is called after merge.
    // We use a mock-based approach since actual worktrees require a git repo.
    let teardownCalled = false;
    let teardownMilestoneId = "";

    const mockSession = {
      basePath: "/mock/worktree/M001",
      originalBasePath: "/mock/project",
      isolationDegraded: false,
      gitService: {} as unknown,
    } as unknown as AutoSession;

    const mockDeps = {
      isInAutoWorktree: () => true,
      shouldUseWorktreeIsolation: () => true,
      getIsolationMode: () => "worktree" as const,
      mergeMilestoneToMain: () => ({ pushed: false, codeFilesChanged: true }),
      syncWorktreeStateBack: () => ({ synced: [] }),
      teardownAutoWorktree: (basePath: string, mid: string) => {
        teardownCalled = true;
        teardownMilestoneId = mid;
      },
      createAutoWorktree: () => "",
      enterAutoWorktree: () => "",
      getAutoWorktreePath: () => null,
      autoCommitCurrentBranch: () => {},
      getCurrentBranch: () => "main",
      autoWorktreeBranch: () => "gsd/M001",
      resolveMilestoneFile: () => "/mock/roadmap.md",
      readFileSync: () => "# Roadmap content",
      GitServiceImpl: class {} as unknown as new (p: string, c: unknown) => unknown,
      loadEffectiveGSDPreferences: () => undefined,
      invalidateAllCaches: () => {},
      captureIntegrationBranch: () => {},
    };

    // Import and create resolver
    // We test the behavior contract: after a successful merge, teardown must be called
    const { WorktreeResolver } = await import("../worktree-resolver.ts");
    const resolver = new WorktreeResolver(mockSession, mockDeps);

    const ctx = { notify: () => {} };
    resolver.mergeAndExit("M001", ctx);

    assert.ok(
      teardownCalled,
      "teardownAutoWorktree must be called after successful merge in worktree mode",
    );
    assert.strictEqual(
      teardownMilestoneId,
      "M001",
      "teardown must be called with the correct milestone ID",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug 4: Quality gate records not written by validate-milestone
// ═══════════════════════════════════════════════════════════════════════════════

describe("#2945 Bug 4: validate-milestone must persist quality_gates records", () => {
  let dbPath: string;
  let basePath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    openDatabase(dbPath);
    const proj = createTempProject();
    basePath = proj.basePath;
  });

  afterEach(() => {
    cleanupDb(dbPath);
    try { rmSync(basePath, { recursive: true, force: true }); } catch {}
  });

  test("handleValidateMilestone persists quality_gates records in DB", async () => {
    // Set up milestone with slices
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const { handleValidateMilestone } = await import("../tools/validate-milestone.ts");

    const result = await handleValidateMilestone({
      milestoneId: "M001",
      verdict: "pass",
      remediationRound: 0,
      successCriteriaChecklist: "- [x] SC1 met\n- [x] SC2 met",
      sliceDeliveryAudit: "All slices delivered",
      crossSliceIntegration: "Integration verified",
      requirementCoverage: "100% coverage",
      verdictRationale: "All checks pass",
    }, basePath);

    assert.ok(!("error" in result), `handler should succeed, got: ${JSON.stringify(result)}`);

    // Quality gate records should exist in DB for this milestone
    // Use a wildcard slice_id since milestone-level gates use a sentinel
    const adapter = (await import("../gsd-db.ts"))._getAdapter()!;
    const gates = adapter.prepare(
      "SELECT * FROM quality_gates WHERE milestone_id = 'M001'"
    ).all();

    assert.ok(
      gates.length > 0,
      `validate-milestone must persist quality_gates records in DB, found ${gates.length}`,
    );
  });

  test("handleValidateMilestone records verdict correctly in quality_gates", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });

    const { handleValidateMilestone } = await import("../tools/validate-milestone.ts");

    await handleValidateMilestone({
      milestoneId: "M001",
      verdict: "needs-remediation",
      remediationRound: 1,
      successCriteriaChecklist: "- [ ] SC1 not met",
      sliceDeliveryAudit: "S01 incomplete",
      crossSliceIntegration: "Not tested",
      requirementCoverage: "50% coverage",
      verdictRationale: "Needs work",
      remediationPlan: "Fix S01",
    }, basePath);

    const adapter = (await import("../gsd-db.ts"))._getAdapter()!;
    const gates = adapter.prepare(
      "SELECT * FROM quality_gates WHERE milestone_id = 'M001'"
    ).all();

    assert.ok(gates.length > 0, "quality_gates records must exist");

    // At least one gate should have a non-empty verdict
    const withVerdict = gates.filter((g: Record<string, unknown>) => g["verdict"] && g["verdict"] !== "");
    assert.ok(
      withVerdict.length > 0,
      "at least one quality_gate should have a recorded verdict",
    );
  });
});
