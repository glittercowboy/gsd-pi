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
  renderKnowledgeView,
  renderCapturesView,
  renderHealthView,
} from "../visualizer-views.js";
import type { VisualizerData } from "../visualizer-data.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';


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
    byTier: [],
    tierSavingsLine: "",
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
    sliceVerifications: [],
    knowledge: { rules: [], patterns: [], lessons: [], exists: false },
    captures: { entries: [], pendingCount: 0, totalCount: 0 },
    health: {
      budgetCeiling: undefined,
      tokenProfile: "standard",
      truncationRate: 0,
      continueHereRate: 0,
      tierBreakdown: [],
      tierSavingsLine: "",
      toolCalls: 0,
      assistantMessages: 0,
      userMessages: 0,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: [],
    },
    discussion: [],
    stats: {
      missingCount: 0,
      missingSlices: [],
      updatedCount: 0,
      updatedSlices: [],
      recentEntries: [],
    },
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
              { id: "T01", title: "Dispatch Loop", done: false, active: true, estimate: "30m" },
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
    sliceVerifications: [
      {
        milestoneId: "M001",
        sliceId: "S01",
        verificationResult: "passed",
        blockerDiscovered: false,
        keyDecisions: [],
        patternsEstablished: [],
        provides: ["core-types"],
        requires: [],
      },
    ],
    stats: {
      missingCount: 2,
      missingSlices: [
        { milestoneId: "M001", sliceId: "S02", title: "State Engine" },
        { milestoneId: "M001", sliceId: "S03", title: "Dashboard" },
      ],
      updatedCount: 1,
      updatedSlices: [
        { milestoneId: "M001", sliceId: "S01", title: "Core Types", completedAt: "2026-03-15T14:30:00Z" },
      ],
      recentEntries: [
        {
          milestoneId: "M001",
          sliceId: "S01",
          title: "Core Types Infrastructure",
          oneLiner: "Core structures assembled",
          filesModified: [],
          completedAt: "2026-03-15T14:30:00Z",
        },
      ],
    },
  });

  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "progress view produces output");
  assert.ok(lines.some(l => l.includes("M001")), "shows milestone M001");
  assert.ok(lines.some(l => l.includes("S01")), "shows slice S01");
  assert.ok(lines.some(l => l.includes("T01")), "shows task T01 for active slice");
  assert.ok(lines.some(l => l.includes("M002")), "shows milestone M002");
  assert.ok(lines.some(l => l.includes("depends on M001")), "shows dependency note");
  assert.ok(lines.some(l => l.includes("30m")), "shows task estimate");
  assert.ok(lines.some(l => l.includes("Feature Snapshot")), "shows stats header");
  assert.ok(lines.some(l => l.includes("Missing slices")), "shows missing slices count");
  assert.ok(lines.some(l => l.includes("State Engine")), "shows missing slice preview");
  assert.ok(lines.some(l => l.includes("Updated (last 7 days)")), "shows updated count");
  assert.ok(lines.some(l => l.includes("Recent completions")), "shows recent completions section");
  assert.ok(lines.some(l => l.includes("Core structures assembled")), "shows recent one-liner entry");
}

{
  const data = makeVisualizerData({
    discussion: [
      {
        milestoneId: "M001",
        title: "First Milestone",
        state: "discussed",
        hasContext: true,
        hasDraft: false,
        lastUpdated: "2026-03-15T14:30:00Z",
      },
      {
        milestoneId: "M002",
        title: "Plugin Arch",
        state: "draft",
        hasContext: false,
        hasDraft: true,
        lastUpdated: "2026-03-16T09:00:00Z",
      },
      {
        milestoneId: "M003",
        title: "Next Batch",
        state: "undiscussed",
        hasContext: false,
        hasDraft: false,
        lastUpdated: null,
      },
    ],
  });

  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("Discussion Status")), "shows discussion section");
  assert.ok(lines.some(l => l.includes("Discussed: 1")), "counts discussed milestones");
  assert.ok(lines.some(l => l.includes("Draft")), "shows draft badge");
  assert.ok(lines.some(l => l.includes("Pending")), "shows pending badge");
}

// Verification badges
{
  const data = makeVisualizerData({
    milestones: [
      {
        id: "M001", title: "Test", status: "active", dependsOn: [],
        slices: [
          { id: "S01", title: "Done Slice", done: true, active: false, risk: "low", depends: [], tasks: [] },
        ],
      },
    ],
    sliceVerifications: [
      {
        milestoneId: "M001", sliceId: "S01",
        verificationResult: "passed", blockerDiscovered: true,
        keyDecisions: [], patternsEstablished: [], provides: [], requires: [],
      },
    ],
  });

  const lines = renderProgressView(data, mockTheme, 80);
  // The verification badge should show check mark and warning
  assert.ok(lines.some(l => l.includes("S01")), "shows slice with verification");
}

{
  const data = makeVisualizerData({ milestones: [] });
  const lines = renderProgressView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("Feature Snapshot")), "shows stats snapshot even when no milestones");
  assert.ok(lines.some(l => l.includes("Missing slices")), "reports missing slices count");
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
  assert.ok(lines.some(l => l.includes("Risk Heatmap")), "heatmap header present");
  assert.ok(lines.some(l => l.includes("1 low, 1 med, 2 high")), "risk summary counts");
  assert.ok(lines.some(l => l.includes("1 high-risk not started")), "high-risk not started warning");
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

  const filtered = renderProgressView(data, mockTheme, 80, { text: "auth", field: "all" });
  assert.ok(filtered.some(l => l.includes("M001")), "filter shows matching milestone");
  assert.ok(filtered.some(l => l.includes("Filter (all): auth")), "filter indicator present");

  const riskFiltered = renderProgressView(data, mockTheme, 80, { text: "high", field: "risk" });
  assert.ok(riskFiltered.some(l => l.includes("M001")), "risk filter shows milestone with high-risk slice");
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
    sliceVerifications: [
      {
        milestoneId: "M001", sliceId: "S01",
        verificationResult: "passed", blockerDiscovered: false,
        keyDecisions: [], patternsEstablished: [],
        provides: ["api-types"], requires: [],
      },
    ],
  });

  const lines = renderDepsView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "deps view produces output");
  assert.ok(lines.some(l => l.includes("M001") && l.includes("M002")), "shows milestone dep edge");
  assert.ok(lines.some(l => l.includes("S01") && l.includes("S02")), "shows slice dep edge");
  assert.ok(lines.some(l => l.includes("Critical Path")), "shows critical path section");
  assert.ok(lines.some(l => l.includes("[CRITICAL]")), "shows CRITICAL badge");
  assert.ok(lines.some(l => l.includes("Data Flow")), "shows data flow section");
  assert.ok(lines.some(l => l.includes("api-types")), "shows provides artifact");
}

{
  const data = makeVisualizerData({
    milestones: [
      { id: "M001", title: "Only", status: "active", dependsOn: [], slices: [] },
    ],
  });

  const lines = renderDepsView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No milestone dependencies")), "shows no-deps message");
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
      totalTruncationSections: 0,
      continueHereFiredCount: 0,
      apiRequests: 5,
    },
    byPhase: [
      {
        phase: "execution",
        units: 3,
        tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 },
        cost: 1.50,
        duration: 40000,
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
    byTier: [
      { tier: "standard", units: 3, tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 }, cost: 1.50, downgraded: 0 },
      { tier: "light", units: 2, tokens: { input: 400, output: 200, cacheRead: 100, cacheWrite: 50, total: 750 }, cost: 1.00, downgraded: 1 },
    ],
    tierSavingsLine: "Dynamic routing: 1/5 units downgraded (20%), cost: $1.00",
    bySlice: [
      { sliceId: "M001/S01", units: 3, tokens: { input: 600, output: 300, cacheRead: 100, cacheWrite: 50, total: 1050 }, cost: 1.50, duration: 40000 },
      { sliceId: "M001/S02", units: 2, tokens: { input: 400, output: 200, cacheRead: 100, cacheWrite: 50, total: 750 }, cost: 1.00, duration: 20000 },
    ],
    remainingSliceCount: 3,
  });

  const lines = renderMetricsView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "metrics view produces output");
  assert.ok(lines.some(l => l.includes("$2.50")), "shows total cost");
  assert.ok(lines.some(l => l.includes("execution")), "shows phase name");
  assert.ok(lines.some(l => l.includes("claude-opus-4-6")), "shows model name");
  assert.ok(lines.some(l => l.includes("By Tier")), "shows tier breakdown section");
  assert.ok(lines.some(l => l.includes("standard")), "shows tier name");
  assert.ok(lines.some(l => l.includes("Dynamic routing")), "shows tier savings line");
  assert.ok(lines.some(l => l.includes("Tools: 15")), "shows tool call count");
  assert.ok(lines.some(l => l.includes("10") && l.includes("sent")), "shows message counts");
}

{
  const data = makeVisualizerData({ totals: null });
  const lines = renderMetricsView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No metrics data")), "shows no-data message");
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
        tier: "standard",
      },
    ],
  });

  const listLines = renderTimelineView(data, mockTheme, 80);
  assert.ok(listLines.length >= 1, "list view produces lines");
  assert.ok(listLines.some(l => l.includes("execute-task")), "shows unit type");
  assert.ok(listLines.some(l => l.includes("[standard]")), "shows tier in timeline");
  assert.ok(listLines.some(l => l.includes("opus-4-6")), "shows shortened model");
}

{
  const data = makeVisualizerData({ units: [] });
  const lines = renderTimelineView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No execution history")), "shows empty message");
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
    health: {
      budgetCeiling: 10, tokenProfile: "standard",
      truncationRate: 15.5, continueHereRate: 5.0,
      tierBreakdown: [], tierSavingsLine: "",
      toolCalls: 20, assistantMessages: 15, userMessages: 8,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: [],
    },
    captures: { entries: [], pendingCount: 3, totalCount: 5 },
  });

  const lines = renderAgentView(data, mockTheme, 80);
  assert.ok(lines.length > 0, "agent view produces output");
  assert.ok(lines.some(l => l.includes("ACTIVE")), "shows active status");
  assert.ok(lines.some(l => l.includes("Pressure")), "shows pressure section");
  assert.ok(lines.some(l => l.includes("15.5%")), "shows truncation rate");
  assert.ok(lines.some(l => l.includes("Pending captures: 3")), "shows pending captures");
}

{
  const data = makeVisualizerData({ agentActivity: null });
  const lines = renderAgentView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No agent activity")), "shows no-activity message");
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
          ],
          completedAt: "2026-03-15T14:30:00Z",
        },
      ],
    },
    sliceVerifications: [
      {
        milestoneId: "M001", sliceId: "S01",
        verificationResult: "passed", blockerDiscovered: false,
        keyDecisions: ["Use RS256 for JWT signing"],
        patternsEstablished: ["Repository pattern for data access"],
        provides: [], requires: [],
      },
    ],
  });

  const lines = renderChangelogView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("M001/S01")), "shows slice reference");
  assert.ok(lines.some(l => l.includes("Decisions:")), "shows decisions section");
  assert.ok(lines.some(l => l.includes("RS256")), "shows decision content");
  assert.ok(lines.some(l => l.includes("Patterns:")), "shows patterns section");
  assert.ok(lines.some(l => l.includes("Repository pattern")), "shows pattern content");
}

{
  const data = makeVisualizerData({ changelog: { entries: [] } });
  const lines = renderChangelogView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No completed slices")), "shows empty state");
}

// ─── renderExportView ───────────────────────────────────────────────────────

console.log("\n=== renderExportView ===");

{
  const data = makeVisualizerData();
  const lines = renderExportView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("Export Options")), "shows export header");
  assert.ok(lines.some(l => l.includes("[m]")), "shows markdown option");
  assert.ok(lines.some(l => l.includes("[j]")), "shows json option");
  assert.ok(lines.some(l => l.includes("[s]")), "shows snapshot option");
}

// ─── renderKnowledgeView ────────────────────────────────────────────────────

console.log("\n=== renderKnowledgeView ===");

{
  const data = makeVisualizerData({
    knowledge: {
      exists: true,
      rules: [{ id: "K001", scope: "global", content: "Always use transactions" }],
      patterns: [{ id: "P001", content: "Repository pattern for DB access" }],
      lessons: [{ id: "L001", content: "Cache invalidation needs TTL" }],
    },
  });

  const lines = renderKnowledgeView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("Rules")), "shows rules section");
  assert.ok(lines.some(l => l.includes("K001")), "shows rule ID");
  assert.ok(lines.some(l => l.includes("Always use transactions")), "shows rule content");
  assert.ok(lines.some(l => l.includes("Patterns")), "shows patterns section");
  assert.ok(lines.some(l => l.includes("P001")), "shows pattern ID");
  assert.ok(lines.some(l => l.includes("Lessons Learned")), "shows lessons section");
  assert.ok(lines.some(l => l.includes("L001")), "shows lesson ID");
}

{
  const data = makeVisualizerData({
    knowledge: { exists: false, rules: [], patterns: [], lessons: [] },
  });
  const lines = renderKnowledgeView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No KNOWLEDGE.md found")), "shows no-knowledge message");
}

// ─── renderCapturesView ─────────────────────────────────────────────────────

console.log("\n=== renderCapturesView ===");

{
  const data = makeVisualizerData({
    captures: {
      entries: [
        { id: "CAP-abc123", text: "Need to add error handling", timestamp: "2026-03-15T10:00:00Z", status: "pending", classification: "inject" },
        { id: "CAP-def456", text: "Consider caching layer", timestamp: "2026-03-15T11:00:00Z", status: "triaged", classification: "defer" },
        { id: "CAP-ghi789", text: "Fixed typo in config", timestamp: "2026-03-15T12:00:00Z", status: "resolved", classification: "quick-task" },
      ],
      pendingCount: 1,
      totalCount: 3,
    },
  });

  const lines = renderCapturesView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("3") && l.includes("total")), "shows total count");
  assert.ok(lines.some(l => l.includes("1") && l.includes("pending")), "shows pending count");
  assert.ok(lines.some(l => l.includes("CAP-abc123")), "shows capture ID");
  assert.ok(lines.some(l => l.includes("(inject)")), "shows classification badge");
  assert.ok(lines.some(l => l.includes("[pending]")), "shows status badge");
}

{
  const data = makeVisualizerData({
    captures: { entries: [], pendingCount: 0, totalCount: 0 },
  });
  const lines = renderCapturesView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No captures recorded")), "shows empty state");
}

// ─── renderHealthView ───────────────────────────────────────────────────────

console.log("\n=== renderHealthView ===");

{
  const data = makeVisualizerData({
    totals: {
      units: 10, tokens: { input: 5000, output: 2000, cacheRead: 1000, cacheWrite: 500, total: 8500 },
      cost: 5.00, duration: 120000, toolCalls: 50,
      assistantMessages: 30, userMessages: 15,
      totalTruncationSections: 3, continueHereFiredCount: 1, apiRequests: 30,
    },
    health: {
      budgetCeiling: 20.00,
      tokenProfile: "standard",
      truncationRate: 30.0,
      continueHereRate: 10.0,
      tierBreakdown: [
        { tier: "standard", units: 7, tokens: { input: 3500, output: 1400, cacheRead: 700, cacheWrite: 350, total: 5950 }, cost: 3.50, downgraded: 0 },
        { tier: "light", units: 3, tokens: { input: 1500, output: 600, cacheRead: 300, cacheWrite: 150, total: 2550 }, cost: 1.50, downgraded: 2 },
      ],
      tierSavingsLine: "Dynamic routing: 2/10 units downgraded (20%), cost: $1.50",
      toolCalls: 50,
      assistantMessages: 30,
      userMessages: 15,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: [],
    },
  });

  const lines = renderHealthView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("Budget")), "shows budget section");
  assert.ok(lines.some(l => l.includes("Ceiling")), "shows budget ceiling");
  assert.ok(lines.some(l => l.includes("$20.00")), "shows ceiling amount");
  assert.ok(lines.some(l => l.includes("Pressure")), "shows pressure section");
  assert.ok(lines.some(l => l.includes("30.0%")), "shows truncation rate");
  assert.ok(lines.some(l => l.includes("Routing")), "shows routing section");
  assert.ok(lines.some(l => l.includes("standard")), "shows tier name");
  assert.ok(lines.some(l => l.includes("2 downgraded")), "shows downgraded count");
  assert.ok(lines.some(l => l.includes("Dynamic routing")), "shows savings line");
  assert.ok(lines.some(l => l.includes("Session")), "shows session section");
  assert.ok(lines.some(l => l.includes("Tool calls: 50")), "shows tool calls");
}

{
  const data = makeVisualizerData({
    health: {
      budgetCeiling: undefined, tokenProfile: "compact",
      truncationRate: 0, continueHereRate: 0,
      tierBreakdown: [], tierSavingsLine: "",
      toolCalls: 0, assistantMessages: 0, userMessages: 0,
      providers: [],
      skillSummary: { total: 0, warningCount: 0, criticalCount: 0, topIssue: null },
      environmentIssues: [],
    },
  });

  const lines = renderHealthView(data, mockTheme, 80);
  assert.ok(lines.some(l => l.includes("No budget ceiling set")), "shows no-ceiling message");
  assert.ok(lines.some(l => l.includes("compact")), "shows token profile");
}

// ─── Report ─────────────────────────────────────────────────────────────────
