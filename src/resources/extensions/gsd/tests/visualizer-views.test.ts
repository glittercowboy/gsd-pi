// Tests for GSD visualizer view renderers.
// Tests the pure view functions with mock data — no file I/O.

import {
  renderProgressView,
  renderDepsView,
  renderMetricsView,
  renderTimelineView,
  renderAgentView,
  renderChangelogView,
  renderExportView,
} from "../visualizer-views.js";
import type { VisualizerData } from "../visualizer-data.js";
import { createTestContext } from "./test-helpers.ts";

const { assertEq, assertTrue, report } = createTestContext();

// ─── Mock theme ─────────────────────────────────────────────────────────────

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

// ─── Test data factories ────────────────────────────────────────────────────

function makeVisualizerData(overrides: Partial<VisualizerData> = {}): VisualizerData {
  return {
    milestones: [],
    phase: "executing",
    totals: null,
    byPhase: [],
    bySlice: [],
    byModel: [],
    units: [],
    criticalPath: {
      milestonePath: [],
      slicePath: [],
      milestoneSlack: new Map(),
      sliceSlack: new Map(),
    },
    remainingSliceCount: 0,
    agentActivity: null,
    changelog: { entries: [] },
    ...overrides,
  };
}

// ─── renderProgressView ─────────────────────────────────────────────────────

console.log("\n=== renderProgressView ===");

{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "First Milestone",
        status: "active",
        dependsOn: [],
        slices: [
          {
            id: "S01",
            title: "Core Types",
            done: true,
            active: false,
            risk: "low",
            depends: [],
            tasks: [],
          },
          {
            id: "S02",
            title: "State Engine",
            done: false,
            active: true,
            risk: "high",
            depends: ["S01"],
            tasks: [
              { id: "T01", title: "Dispatch Loop", done: false, active: true },
              { id: "T02", title: "Session Mgmt", done: true, active: false },
            ],
          },
          {
            id: "S03",
            title: "Dashboard",
            done: false,
            active: false,
            risk: "medium",
            depends: ["S02"],
            tasks: [],
          },
        ],
      },
      {
        id: "M002",
        title: "Plugin Arch",
        status: "pending",
        dependsOn: ["M001"],
        slices: [],
      },
    ],
  });

  const lines = renderProgressView(data, mockTheme, 80);
  assertTrue(lines.length > 0, "progress view produces output");
  assertTrue(lines.some(l => l.includes("M001")), "shows milestone M001");
  assertTrue(lines.some(l => l.includes("S01")), "shows slice S01");
  assertTrue(lines.some(l => l.includes("T01")), "shows task T01 for active slice");
  assertTrue(lines.some(l => l.includes("M002")), "shows milestone M002");
  assertTrue(lines.some(l => l.includes("depends on M001")), "shows dependency note");
}

{
  const data = makeVisualizerData({ milestones: [] });
  const lines = renderProgressView(data, mockTheme, 80);
  assertEq(lines.length, 0, "empty milestones produce no lines");
}

// ─── Risk Heatmap ───────────────────────────────────────────────────────────

console.log("\n=== Risk Heatmap ===");

{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "First",
        status: "active",
        dependsOn: [],
        slices: [
          { id: "S01", title: "A", done: true, active: false, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "B", done: false, active: true, risk: "high", depends: [], tasks: [] },
          { id: "S03", title: "C", done: false, active: false, risk: "medium", depends: [], tasks: [] },
          { id: "S04", title: "D", done: false, active: false, risk: "high", depends: [], tasks: [] },
        ],
      },
    ],
  });

  const lines = renderProgressView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("Risk Heatmap")), "heatmap header present");
  assertTrue(lines.some(l => l.includes("██")), "heatmap has colored blocks");
  assertTrue(lines.some(l => l.includes("low") && l.includes("med") && l.includes("high")), "heatmap legend present");
  assertTrue(lines.some(l => l.includes("1 low, 1 med, 2 high")), "risk summary counts");
  assertTrue(lines.some(l => l.includes("1 high-risk not started")), "high-risk not started warning");
}

// ─── Search/Filter ──────────────────────────────────────────────────────────

console.log("\n=== Search/Filter ===");

{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "Auth",
        status: "active",
        dependsOn: [],
        slices: [
          { id: "S01", title: "JWT", done: false, active: false, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "OAuth", done: false, active: false, risk: "high", depends: [], tasks: [] },
        ],
      },
      {
        id: "M002",
        title: "Dashboard",
        status: "pending",
        dependsOn: ["M001"],
        slices: [],
      },
    ],
  });

  // Filter by keyword "auth"
  const filtered = renderProgressView(data, mockTheme, 80, { text: "auth", field: "all" });
  assertTrue(filtered.some(l => l.includes("M001")), "filter shows matching milestone");
  assertTrue(filtered.some(l => l.includes("Filter (all): auth")), "filter indicator present");

  // Filter by risk "high"
  const riskFiltered = renderProgressView(data, mockTheme, 80, { text: "high", field: "risk" });
  assertTrue(riskFiltered.some(l => l.includes("M001")), "risk filter shows milestone with high-risk slice");
}

// ─── renderDepsView ─────────────────────────────────────────────────────────

console.log("\n=== renderDepsView ===");

{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001",
        title: "First",
        status: "active",
        dependsOn: [],
        slices: [
          { id: "S01", title: "A", done: false, active: true, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "B", done: false, active: false, risk: "low", depends: ["S01"], tasks: [] },
        ],
      },
      {
        id: "M002",
        title: "Second",
        status: "pending",
        dependsOn: ["M001"],
        slices: [],
      },
    ],
    criticalPath: {
      milestonePath: ["M001", "M002"],
      slicePath: ["S01", "S02"],
      milestoneSlack: new Map([["M001", 0], ["M002", 0]]),
      sliceSlack: new Map([["S01", 0], ["S02", 0]]),
    },
  });

  const lines = renderDepsView(data, mockTheme, 80);
  assertTrue(lines.length > 0, "deps view produces output");
  assertTrue(lines.some(l => l.includes("M001") && l.includes("M002")), "shows milestone dep edge");
  assertTrue(lines.some(l => l.includes("S01") && l.includes("S02")), "shows slice dep edge");
  assertTrue(lines.some(l => l.includes("Critical Path")), "shows critical path section");
  assertTrue(lines.some(l => l.includes("[CRITICAL]")), "shows CRITICAL badge");
}

{
  const data = makeVisualizerData({
    milestones: [
      { id: "M001", title: "Only", status: "active", dependsOn: [], slices: [] },
    ],
  });

  const lines = renderDepsView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("No milestone dependencies")), "shows no-deps message");
}

// ─── renderMetricsView ──────────────────────────────────────────────────────

console.log("\n=== renderMetricsView ===");

{
  const data = makeVisualizerData({
    totals: {
      units: 5,
      tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
      cost: 2.50,
      duration: 60000,
      toolCalls: 15,
      assistantMessages: 10,
      userMessages: 5,
    },
    byPhase: [
      {
        phase: "execution",
        units: 3,
        tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 },
        cost: 1.50,
        duration: 40000,
      },
      {
        phase: "planning",
        units: 2,
        tokens: { input: 400, output: 200, cacheRead: 100, cacheWrite: 50, total: 750 },
        cost: 1.00,
        duration: 20000,
      },
    ],
    byModel: [
      {
        model: "claude-opus-4-6",
        units: 5,
        tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, total: 1800 },
        cost: 2.50,
      },
    ],
    bySlice: [
      { sliceId: "M001/S01", units: 3, tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 }, cost: 1.50, duration: 40000 },
      { sliceId: "M001/S02", units: 2, tokens: { input: 400, output: 200, cacheRead: 100, cacheWrite: 50, total: 750 }, cost: 1.00, duration: 20000 },
    ],
    remainingSliceCount: 3,
  });

  const lines = renderMetricsView(data, mockTheme, 80);
  assertTrue(lines.length > 0, "metrics view produces output");
  assertTrue(lines.some(l => l.includes("$2.50")), "shows total cost");
  assertTrue(lines.some(l => l.includes("execution")), "shows phase name");
  assertTrue(lines.some(l => l.includes("claude-opus-4-6")), "shows model name");
  assertTrue(lines.some(l => l.includes("Projections")), "shows projections section");
  assertTrue(lines.some(l => l.includes("Avg cost/slice")), "shows avg cost per slice");
  assertTrue(lines.some(l => l.includes("Projected remaining")), "shows projected remaining");
  assertTrue(lines.some(l => l.includes("Burn rate")), "shows burn rate");
  assertTrue(lines.some(l => l.includes("Cost trend")), "shows sparkline");
}

{
  const data = makeVisualizerData({ totals: null });
  const lines = renderMetricsView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("No metrics data")), "shows no-data message");
}

// ─── renderTimelineView ─────────────────────────────────────────────────────

console.log("\n=== renderTimelineView ===");

{
  const now = Date.now();
  const data = makeVisualizerData({
    units: [
      {
        type: "execute-task",
        id: "M001/S01/T01",
        model: "claude-opus-4-6",
        startedAt: now - 120000,
        finishedAt: now - 60000,
        tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50, total: 850 },
        cost: 0.42,
        toolCalls: 5,
        assistantMessages: 3,
        userMessages: 1,
      },
      {
        type: "plan-slice",
        id: "M001/S02",
        model: "claude-opus-4-6",
        startedAt: now - 60000,
        finishedAt: now - 30000,
        tokens: { input: 300, output: 150, cacheRead: 50, cacheWrite: 25, total: 525 },
        cost: 0.18,
        toolCalls: 2,
        assistantMessages: 2,
        userMessages: 1,
      },
    ],
  });

  // Wide terminal — Gantt view
  const ganttLines = renderTimelineView(data, mockTheme, 120);
  assertTrue(ganttLines.length >= 2, "gantt view produces lines for each unit");

  // Narrow terminal — list view
  const listLines = renderTimelineView(data, mockTheme, 80);
  assertTrue(listLines.length >= 2, "list view produces lines for each unit");
  assertTrue(listLines.some(l => l.includes("execute-task")), "shows unit type");
  assertTrue(listLines.some(l => l.includes("M001/S01/T01")), "shows unit id");
  assertTrue(listLines.some(l => l.includes("$0.42")), "shows unit cost");
}

{
  const data = makeVisualizerData({ units: [] });
  const lines = renderTimelineView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("No execution history")), "shows empty message");
}

// ─── renderAgentView ────────────────────────────────────────────────────────

console.log("\n=== renderAgentView ===");

{
  const now = Date.now();
  const data = makeVisualizerData({
    agentActivity: {
      currentUnit: { type: "execute-task", id: "M001/S02/T03", startedAt: now - 60000 },
      elapsed: 60000,
      completedUnits: 8,
      totalSlices: 15,
      completionRate: 2.4,
      active: true,
      sessionCost: 1.23,
      sessionTokens: 45200,
    },
    units: [
      {
        type: "execute-task", id: "M001/S01/T01", model: "claude-opus-4-6",
        startedAt: now - 300000, finishedAt: now - 240000,
        tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50, total: 850 },
        cost: 0.12, toolCalls: 5, assistantMessages: 3, userMessages: 1,
      },
    ],
  });

  const lines = renderAgentView(data, mockTheme, 80);
  assertTrue(lines.length > 0, "agent view produces output");
  assertTrue(lines.some(l => l.includes("ACTIVE")), "shows active status");
  assertTrue(lines.some(l => l.includes("M001/S02/T03")), "shows current unit");
  assertTrue(lines.some(l => l.includes("8/15")), "shows progress fraction");
  assertTrue(lines.some(l => l.includes("2.4 units/hr")), "shows completion rate");
  assertTrue(lines.some(l => l.includes("$1.23")), "shows session cost");
}

{
  const data = makeVisualizerData({ agentActivity: null });
  const lines = renderAgentView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("No agent activity")), "shows no-activity message");
}

{
  const data = makeVisualizerData({
    agentActivity: {
      currentUnit: null,
      elapsed: 0,
      completedUnits: 5,
      totalSlices: 10,
      completionRate: 1.5,
      active: false,
      sessionCost: 0.50,
      sessionTokens: 20000,
    },
  });

  const lines = renderAgentView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("IDLE")), "shows idle status");
  assertTrue(lines.some(l => l.includes("Not in auto mode")), "shows not-in-auto message");
}

// ─── renderChangelogView ────────────────────────────────────────────────────

console.log("\n=== renderChangelogView ===");

{
  const data = makeVisualizerData({
    changelog: {
      entries: [
        {
          milestoneId: "M001",
          sliceId: "S01",
          title: "Core Authentication Setup",
          oneLiner: "Added JWT-based auth with refresh token rotation",
          filesModified: [
            { path: "src/auth/jwt.ts", description: "JWT token generation and validation" },
            { path: "src/auth/middleware.ts", description: "Express middleware for auth checks" },
          ],
          completedAt: "2026-03-15T14:30:00Z",
        },
      ],
    },
  });

  const lines = renderChangelogView(data, mockTheme, 80);
  assertTrue(lines.length > 0, "changelog view produces output");
  assertTrue(lines.some(l => l.includes("M001/S01")), "shows slice reference");
  assertTrue(lines.some(l => l.includes("Core Authentication Setup")), "shows entry title");
  assertTrue(lines.some(l => l.includes("JWT-based auth")), "shows one-liner");
  assertTrue(lines.some(l => l.includes("src/auth/jwt.ts")), "shows modified file");
  assertTrue(lines.some(l => l.includes("2026-03-15")), "shows completed date");
}

{
  const data = makeVisualizerData({ changelog: { entries: [] } });
  const lines = renderChangelogView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("No completed slices")), "shows empty state");
}

// ─── renderExportView ───────────────────────────────────────────────────────

console.log("\n=== renderExportView ===");

{
  const data = makeVisualizerData();
  const lines = renderExportView(data, mockTheme, 80);
  assertTrue(lines.some(l => l.includes("Export Options")), "shows export header");
  assertTrue(lines.some(l => l.includes("[m]")), "shows markdown option");
  assertTrue(lines.some(l => l.includes("[j]")), "shows json option");
  assertTrue(lines.some(l => l.includes("[s]")), "shows snapshot option");
}

{
  const data = makeVisualizerData();
  const lines = renderExportView(data, mockTheme, 80, "/tmp/export-2026.md");
  assertTrue(lines.some(l => l.includes("Last export:")), "shows last export path");
  assertTrue(lines.some(l => l.includes("/tmp/export-2026.md")), "shows specific export path");
}

// ─── Report ─────────────────────────────────────────────────────────────────

report();
