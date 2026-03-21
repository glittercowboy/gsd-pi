import test from "node:test";
import assert from "node:assert/strict";
import { generateHtmlReport, type HtmlReportOptions } from "../export-html.js";
import type { VisualizerData } from "../visualizer-data.js";

// ─── Mock Data ──────────────────────────────────────────────────────────────

function mockOpts(overrides: Partial<HtmlReportOptions> = {}): HtmlReportOptions {
  return {
    projectName: "TestProject",
    projectPath: "/tmp/test",
    gsdVersion: "2.28.0",
    ...overrides,
  };
}

function mockTokens(input = 5000, output = 2000, cacheRead = 3000, cacheWrite = 500) {
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function mockUnit(id: string, cost: number, startedAt: number, finishedAt: number, type = "execute-task") {
  return {
    type,
    id,
    model: "claude-sonnet-4-20250514",
    startedAt,
    finishedAt,
    tokens: mockTokens(),
    cost,
    toolCalls: 10,
    assistantMessages: 5,
    userMessages: 3,
  };
}

function mockData(overrides: Partial<VisualizerData> = {}): VisualizerData {
  return {
    milestones: [
      {
        id: "M001",
        title: "First Milestone",
        status: "complete",
        dependsOn: [],
        slices: [
          { id: "S01", title: "Slice One", done: true, active: false, risk: "low", depends: [], tasks: [] },
          { id: "S02", title: "Slice Two", done: true, active: false, risk: "medium", depends: ["S01"], tasks: [] },
        ],
      },
      {
        id: "M002",
        title: "Second Milestone",
        status: "active",
        dependsOn: ["M001"],
        slices: [
          { id: "S01", title: "Active Slice", done: false, active: true, risk: "high", depends: [], tasks: [] },
          { id: "S02", title: "Pending Slice", done: false, active: false, risk: "low", depends: ["S01"], tasks: [] },
        ],
      },
    ],
    phase: "executing",
    totals: {
      units: 4,
      tokens: mockTokens(),
      cost: 2.50,
      duration: 3_600_000,
      toolCalls: 40,
      assistantMessages: 20,
      userMessages: 12,
      totalTruncationSections: 2,
      continueHereFiredCount: 1,
      apiRequests: 20,
      totalInterventions: { blocker: 0, correction: 0, redirect: 0 },
      totalFactChecks: { claimsChecked: 0, verified: 0, refuted: 0, inconclusive: 0, scoutTokens: 0 },
    },
    byPhase: [
      { phase: "execution", units: 4, tokens: mockTokens(), cost: 2.50, duration: 3_600_000 },
    ],
    bySlice: [
      { sliceId: "M001/S01", units: 2, tokens: mockTokens(), cost: 1.20, duration: 1_800_000 },
      { sliceId: "M001/S02", units: 2, tokens: mockTokens(), cost: 1.30, duration: 1_800_000 },
    ],
    byModel: [
      { model: "claude-sonnet-4-20250514", units: 4, tokens: mockTokens(), cost: 2.50 },
    ],
    byTier: [],
    tierSavingsLine: "",
    units: [
      mockUnit("M001/S01/T01", 0.50, Date.now() - 4_000_000, Date.now() - 3_000_000),
      mockUnit("M001/S01/T02", 0.70, Date.now() - 3_000_000, Date.now() - 2_000_000),
      mockUnit("M001/S02/T01", 0.60, Date.now() - 2_000_000, Date.now() - 1_000_000),
      mockUnit("M001/S02/T02", 0.70, Date.now() - 1_000_000, Date.now() - 500_000),
    ],
    criticalPath: {
      milestonePath: ["M001", "M002"],
      slicePath: ["S01", "S02"],
      milestoneSlack: new Map(),
      sliceSlack: new Map(),
    },
    remainingSliceCount: 2,
    agentActivity: {
      currentUnit: { type: "execute-task", id: "M002/S01/T01", startedAt: Date.now() - 30_000 },
      elapsed: 30_000,
      completedUnits: 4,
      totalSlices: 4,
      completionRate: 2.5,
      active: true,
      sessionCost: 2.50,
      sessionTokens: 10_500,
    },
    changelog: { entries: [] },
    sliceVerifications: [],
    knowledge: { rules: [], patterns: [], lessons: [], exists: false },
    captures: { entries: [], pendingCount: 0, totalCount: 0 },
    health: {
      budgetCeiling: undefined,
      tokenProfile: "standard",
      truncationRate: 5.0,
      continueHereRate: 2.0,
      tierBreakdown: [],
      tierSavingsLine: "",
      toolCalls: 40,
      assistantMessages: 20,
      userMessages: 12,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: [],

    },
    discussion: [],
    stats: { missingCount: 0, missingSlices: [], updatedCount: 0, updatedSlices: [], recentEntries: [] },
    ...overrides,
  };
}

// ─── Wave 1: Summary Enhancements ──────────────────────────────────────────

test("Feature 1: executive summary paragraph is rendered", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="exec-summary"'), "should contain exec-summary class");
  assert.ok(html.includes("TestProject is"), "should contain project name in exec summary");
  assert.ok(html.includes("% complete across"), "should contain completion percentage");
  assert.ok(html.includes("milestones"), "should mention milestones");
  assert.ok(html.includes("$2.50 spent"), "should contain cost");
});

test("Feature 1: executive summary includes budget context when set", () => {
  const data = mockData({ health: { ...mockData().health, budgetCeiling: 10.00 } });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("Budget:"), "should include budget line");
  assert.ok(html.includes("ceiling"), "should mention ceiling");
});

test("Feature 2: ETA line is rendered when completion rate > 0", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="eta-line"'), "should contain eta-line class");
  assert.ok(html.includes("ETA:"), "should contain ETA text");
  assert.ok(html.includes("remaining"), "should mention remaining");
  assert.ok(html.includes("2.5/hr"), "should show completion rate");
});

test("Feature 2: ETA line is skipped when rate is 0", () => {
  const data = mockData({
    agentActivity: { ...mockData().agentActivity!, completionRate: 0 },
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="eta-line"'), "should not contain eta-line when rate is 0");
});

test("Feature 2: ETA line is skipped when no remaining slices", () => {
  const data = mockData({ remainingSliceCount: 0 });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="eta-line"'), "should not contain eta-line when no remaining slices");
});

test("Feature 3: cost efficiency metrics shown in KV grid", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("Cost/slice"), "should contain Cost/slice KV");
  assert.ok(html.includes("Tokens/tool"), "should contain Tokens/tool KV");
});

test("Feature 4: cache hit ratio shown in KV grid", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("Cache hit"), "should contain Cache hit KV");
  // 3000 / (5000 + 3000) = 37.5%
  assert.ok(html.includes("37.5%"), "should show correct cache hit percentage");
});

test("Feature 4: cache hit ratio skipped when no input tokens", () => {
  const data = mockData({
    totals: {
      ...mockData().totals!,
      tokens: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, total: 100 },
    },
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes("Cache hit"), "should not contain Cache hit when no input/cacheRead");
});

test("Feature 15: scope shown when milestoneId is set", () => {
  const html = generateHtmlReport(mockData(), mockOpts({ milestoneId: "M001" }));
  assert.ok(html.includes("Scope"), "should contain Scope KV");
  assert.ok(html.includes("M001"), "should show milestone ID");
});

test("Feature 15: scope not shown when no milestoneId", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(!html.includes("Scope"), "should not contain Scope KV without milestoneId");
});

// ─── Wave 2: Metrics Enhancements ──────────────────────────────────────────

test("Feature 5: cost over time chart is rendered", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="cost-svg"'), "should contain cost-svg class");
  assert.ok(html.includes('class="cost-line"'), "should contain cost line path");
  assert.ok(html.includes('class="cost-area"'), "should contain cost area path");
  assert.ok(html.includes("Cost over time"), "should have chart title");
});

test("Feature 5: cost over time chart skipped with < 2 units", () => {
  const data = mockData({ units: [mockUnit("M001/S01/T01", 0.50, 1000, 2000)] });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="cost-svg"'), "should not render cost chart with single unit");
});

test("Feature 6: duration by slice bar chart is rendered", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("Duration by slice"), "should contain duration by slice chart");
});

test("Feature 7: budget burndown rendered when ceiling is set", () => {
  const data = mockData({ health: { ...mockData().health, budgetCeiling: 10.00 } });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes('class="burndown-wrap"'), "should contain burndown-wrap");
  assert.ok(html.includes("Budget burndown"), "should have burndown title");
  assert.ok(html.includes("burndown-spent"), "should show spent bar");
  assert.ok(html.includes("Ceiling:"), "should show ceiling in legend");
});

test("Feature 7: budget burndown skipped without ceiling", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(!html.includes('class="burndown-wrap"'), "should not render burndown without ceiling");
});

// ─── Wave 3: Blockers Section ───────────────────────────────────────────────

test("Feature 8: blockers section renders clean state", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('id="blockers"'), "should contain blockers section");
  // M002/S01 is high risk and incomplete
  assert.ok(html.includes("blocker-card"), "should contain high-risk blocker card");
  assert.ok(html.includes("High risk"), "should flag high-risk slice");
});

test("Feature 8: blockers section renders blocker verifications", () => {
  const data = mockData({
    sliceVerifications: [
      {
        milestoneId: "M001",
        sliceId: "S01",
        verificationResult: "Tests failing on CI",
        blockerDiscovered: true,
        keyDecisions: [],
        patternsEstablished: [],
        provides: [],
        requires: [],
      },
    ],
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("Tests failing on CI"), "should show blocker verification text");
  assert.ok(html.includes("M001"), "should show milestone ID in blocker");
});

test("Feature 8: blockers section shows no-blockers message when clean", () => {
  const data = mockData({
    milestones: [
      {
        id: "M001",
        title: "Clean Milestone",
        status: "complete",
        dependsOn: [],
        slices: [
          { id: "S01", title: "Done", done: true, active: false, risk: "low", depends: [], tasks: [] },
        ],
      },
    ],
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("No blockers or high-risk items found"), "should show clean message");
});

test("Feature 8: blockers section in TOC nav", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('href="#blockers"'), "TOC should contain blockers link");
});

// ─── Wave 4: Gantt Chart ──────────────────────────────────────────────────

test("Feature 13: slice Gantt chart is rendered with timing data", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes('class="gantt-wrap"'), "should contain gantt-wrap");
  assert.ok(html.includes('class="gantt-svg"'), "should contain gantt-svg");
  assert.ok(html.includes("Slice timeline"), "should have Gantt title");
  assert.ok(html.includes("gantt-bar-"), "should contain gantt bars");
});

test("Feature 13: Gantt chart skipped with < 2 slices", () => {
  const data = mockData({
    units: [mockUnit("M001/S01/T01", 0.50, 1000, 2000)],
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="gantt-wrap"'), "should not render Gantt with single slice");
});

// ─── Wave 5: Interactive JS Features ────────────────────────────────────────

test("Feature 9: timeline filter JS is included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("tl-filter"), "should contain timeline filter class in JS");
  assert.ok(html.includes("Filter timeline"), "should contain filter placeholder text");
});

test("Feature 10: collapsible sections JS is included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("sec-toggle"), "should contain section toggle class");
  assert.ok(html.includes("gsd-collapsed"), "should reference localStorage key for collapsed state");
});

test("Feature 11: dark/light theme toggle JS is included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("theme-toggle"), "should contain theme toggle class");
  assert.ok(html.includes("gsd-theme"), "should reference localStorage key for theme");
  assert.ok(html.includes("light-theme"), "should reference light-theme class");
});

// ─── Wave 6: Responsive CSS ────────────────────────────────────────────────

test("Feature 12: responsive media queries are included", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("max-width:768px"), "should contain 768px breakpoint");
  assert.ok(html.includes("max-width:480px"), "should contain 480px breakpoint");
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

test("Edge: no totals data renders without crash", () => {
  const data = mockData({ totals: null, units: [], byPhase: [], bySlice: [], byModel: [] });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes('id="summary"'), "should render summary section");
  assert.ok(html.includes('id="metrics"'), "should render metrics section");
  assert.ok(!html.includes("Cost/slice"), "should not show cost/slice without totals");
});

test("Edge: zero completion rate and zero remaining slices", () => {
  const data = mockData({
    agentActivity: null,
    remainingSliceCount: 0,
  });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(!html.includes('class="eta-line"'), "no ETA line with null activity");
  assert.ok(html.includes('id="summary"'), "summary still renders");
});

test("Edge: empty milestones array", () => {
  const data = mockData({ milestones: [] });
  const html = generateHtmlReport(data, mockOpts());
  assert.ok(html.includes("0% complete across 0 milestones"), "should show 0% completion");
});

test("Edge: light theme CSS variables are defined", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  // Verify that light-theme class contains override variables
  assert.ok(html.includes(".light-theme{"), "should include light-theme CSS rule");
  assert.ok(html.includes("--bg-0:#fff"), "should override bg-0 in light theme");
});

test("Edge: print media query still present", () => {
  const html = generateHtmlReport(mockData(), mockOpts());
  assert.ok(html.includes("@media print"), "should still contain print media query");
});
