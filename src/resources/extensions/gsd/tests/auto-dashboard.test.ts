import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  unitVerb,
  unitPhaseLabel,
  describeNextUnit,
  formatAutoElapsed,
  formatWidgetTokens,
  estimateTimeRemaining,
  extractUatSliceId,
} from "../auto-dashboard.ts";

const autoSource = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "auto.ts"), "utf-8");
const dashboardSource = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "auto-dashboard.ts"), "utf-8");

// ─── unitVerb ─────────────────────────────────────────────────────────────

test("unitVerb maps known unit types to verbs", () => {
  assert.equal(unitVerb("research-milestone"), "researching");
  assert.equal(unitVerb("research-slice"), "researching");
  assert.equal(unitVerb("plan-milestone"), "planning");
  assert.equal(unitVerb("plan-slice"), "planning");
  assert.equal(unitVerb("execute-task"), "executing");
  assert.equal(unitVerb("complete-slice"), "completing");
  assert.equal(unitVerb("replan-slice"), "replanning");
  assert.equal(unitVerb("reassess-roadmap"), "reassessing");
  assert.equal(unitVerb("run-uat"), "running UAT");
});

test("unitVerb returns raw type for unknown types", () => {
  assert.equal(unitVerb("custom-thing"), "custom-thing");
});

test("unitVerb handles hook types", () => {
  assert.equal(unitVerb("hook/verify-code"), "hook: verify-code");
  assert.equal(unitVerb("hook/"), "hook: ");
});

// ─── unitPhaseLabel ───────────────────────────────────────────────────────

test("unitPhaseLabel maps known types to labels", () => {
  assert.equal(unitPhaseLabel("research-milestone"), "RESEARCH");
  assert.equal(unitPhaseLabel("research-slice"), "RESEARCH");
  assert.equal(unitPhaseLabel("plan-milestone"), "PLAN");
  assert.equal(unitPhaseLabel("plan-slice"), "PLAN");
  assert.equal(unitPhaseLabel("execute-task"), "EXECUTE");
  assert.equal(unitPhaseLabel("complete-slice"), "COMPLETE");
  assert.equal(unitPhaseLabel("replan-slice"), "REPLAN");
  assert.equal(unitPhaseLabel("reassess-roadmap"), "REASSESS");
  assert.equal(unitPhaseLabel("run-uat"), "UAT");
});

test("unitPhaseLabel uppercases unknown types", () => {
  assert.equal(unitPhaseLabel("custom-thing"), "CUSTOM-THING");
});

test("unitPhaseLabel returns HOOK for hook types", () => {
  assert.equal(unitPhaseLabel("hook/verify"), "HOOK");
});

// ─── describeNextUnit ─────────────────────────────────────────────────────

test("describeNextUnit handles pre-planning phase", () => {
  const result = describeNextUnit({
    phase: "pre-planning",
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.equal(result.label, "Research & plan milestone");
});

test("describeNextUnit handles executing phase", () => {
  const result = describeNextUnit({
    phase: "executing",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: { id: "S01", title: "Slice" },
    activeTask: { id: "T01", title: "Task One" },
  } as any);
  assert.ok(result.label.includes("T01"));
  assert.ok(result.label.includes("Task One"));
});

test("describeNextUnit handles summarizing phase", () => {
  const result = describeNextUnit({
    phase: "summarizing",
    activeMilestone: { id: "M001", title: "Test" },
    activeSlice: { id: "S01", title: "First Slice" },
  } as any);
  assert.ok(result.label.includes("S01"));
});

test("describeNextUnit handles needs-discussion phase", () => {
  const result = describeNextUnit({
    phase: "needs-discussion",
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.ok(
    result.label.toLowerCase().includes("discuss") || result.label.toLowerCase().includes("draft"),
  );
});

test("describeNextUnit handles completing-milestone phase", () => {
  const result = describeNextUnit({
    phase: "completing-milestone",
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.ok(result.label.toLowerCase().includes("milestone"));
});

test("describeNextUnit returns fallback for unknown phase", () => {
  const result = describeNextUnit({
    phase: "some-future-phase" as any,
    activeMilestone: { id: "M001", title: "Test" },
  } as any);
  assert.equal(result.label, "Continue");
});

// ─── formatAutoElapsed ────────────────────────────────────────────────────

test("formatAutoElapsed returns empty for zero startTime", () => {
  assert.equal(formatAutoElapsed(0), "");
});

test("formatAutoElapsed formats seconds", () => {
  const result = formatAutoElapsed(Date.now() - 30_000);
  assert.match(result, /^\d+s$/);
});

test("formatAutoElapsed formats minutes", () => {
  const result = formatAutoElapsed(Date.now() - 180_000); // 3 min
  assert.match(result, /^3m/);
});

test("formatAutoElapsed formats hours", () => {
  const result = formatAutoElapsed(Date.now() - 3_700_000); // ~1h
  assert.match(result, /^1h/);
});

// ─── formatWidgetTokens ──────────────────────────────────────────────────

test("formatWidgetTokens formats small numbers directly", () => {
  assert.equal(formatWidgetTokens(0), "0");
  assert.equal(formatWidgetTokens(500), "500");
  assert.equal(formatWidgetTokens(999), "999");
});

test("formatWidgetTokens formats thousands with k", () => {
  assert.equal(formatWidgetTokens(1000), "1.0k");
  assert.equal(formatWidgetTokens(5500), "5.5k");
  assert.equal(formatWidgetTokens(10000), "10k");
  assert.equal(formatWidgetTokens(99999), "100k");
});

test("formatWidgetTokens formats millions with M", () => {
  assert.equal(formatWidgetTokens(1_000_000), "1.0M");
  assert.equal(formatWidgetTokens(10_000_000), "10M");
  assert.equal(formatWidgetTokens(25_000_000), "25M");
});

// ─── estimateTimeRemaining ──────────────────────────────────────────────

test("estimateTimeRemaining returns null when no ledger data", () => {
  // With no active auto-mode session, ledger is empty
  const result = estimateTimeRemaining();
  assert.equal(result, null);
});

test("estimateTimeRemaining is exported and callable", () => {
  assert.equal(typeof estimateTimeRemaining, "function");
});

// ─── getAutoDashboardData elapsed guard ──────────────────────────────────────
// These tests verify the elapsed time calculation in getAutoDashboardData()
// doesn't produce absurd values when autoStartTime is 0 (uninitialized).
// The actual function is in auto.ts and tested structurally here by verifying
// that formatAutoElapsed properly handles the zero case.

test("formatAutoElapsed returns empty string for negative autoStartTime", () => {
  // A negative value should be treated as invalid — the guard in
  // getAutoDashboardData prevents this, but formatAutoElapsed should also
  // handle it gracefully via its falsy check.
  assert.equal(formatAutoElapsed(-1), "");
  assert.equal(formatAutoElapsed(NaN), "");
});

test("getAutoDashboardData returns RTK savings in the dashboard payload", () => {
  assert.match(autoSource, /const rtkSavings = sessionId && s\.basePath/);
  assert.match(autoSource, /rtkSavings,/);
});

test("auto progress widget renders RTK savings under the footer stats line", () => {
  assert.match(dashboardSource, /formatRtkSavingsLabel/);
  assert.match(dashboardSource, /getRtkSessionSavings\(accessors\.getBasePath\(\), sessionId\)/);
  assert.match(dashboardSource, /lines\.push\(rightAlign\("", theme\.fg\("dim", cachedRtkLabel\), width\)\);/);
});

// ─── extractUatSliceId ───────────────────────────────────────────────────

test("extractUatSliceId extracts slice ID from M001/S01 format", () => {
  assert.equal(extractUatSliceId("M001/S01"), "S01");
  assert.equal(extractUatSliceId("M002/S03"), "S03");
  assert.equal(extractUatSliceId("M001/S12"), "S12");
});

test("extractUatSliceId returns null for invalid formats", () => {
  assert.equal(extractUatSliceId("M001"), null);
  assert.equal(extractUatSliceId(""), null);
  assert.equal(extractUatSliceId("M001/T01"), null);
});
