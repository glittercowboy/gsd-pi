import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  unitVerb,
  unitPhaseLabel,
  describeNextUnit,
  formatAutoElapsed,
  formatWidgetTokens,
  estimateTimeRemaining,
  extractUatSliceId,
  getWidgetMode,
  cycleWidgetMode,
  _resetWidgetModeForTests,
  _resetLastCommitCacheForTests,
  _refreshLastCommitForTests,
  _getLastCommitForTests,
  _getLastCommitFetchedAtForTests,
} from "../auto-dashboard.ts";

const autoSource = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "auto.ts"), "utf-8");
const dashboardSource = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "auto-dashboard.ts"), "utf-8");

function makeTempDir(prefix: string): string {
  return join(
    tmpdir(),
    `gsd-auto-dashboard-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

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

test("last commit refresh backs off cleanly when base path is not a git repo", (t) => {
  const dir = makeTempDir("non-git");
  mkdirSync(dir, { recursive: true });

  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });

  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);

  assert.equal(_getLastCommitForTests(dir), null);
  assert.ok(
    _getLastCommitFetchedAtForTests() > 0,
    "non-git refresh should still advance fetchedAt to avoid render-loop retries",
  );
});

test("last commit refresh still returns commit info for a valid git repo", (t) => {
  const dir = makeTempDir("git");
  mkdirSync(dir, { recursive: true });

  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "GSD Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "gsd@example.com"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "hello\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "test: seed dashboard repo"], { cwd: dir, stdio: "pipe" });

  t.after(() => {
    cleanup(dir);
    _resetLastCommitCacheForTests();
  });

  _resetLastCommitCacheForTests();
  _refreshLastCommitForTests(dir);

  const lastCommit = _getLastCommitForTests(dir);
  assert.ok(lastCommit, "git repo should produce last commit metadata");
  assert.match(lastCommit!.message, /test: seed dashboard repo/);
  assert.ok(lastCommit!.timeAgo.length > 0, "relative time should be populated");
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

test("widget mode respects project preference precedence and persists there", (t) => {
  const homeDir = makeTempDir("home");
  const projectDir = makeTempDir("project");
  const globalPrefsPath = join(homeDir, ".gsd", "preferences.md");
  const projectPrefsPath = join(projectDir, ".gsd", "preferences.md");

  mkdirSync(join(homeDir, ".gsd"), { recursive: true });
  mkdirSync(join(projectDir, ".gsd"), { recursive: true });
  writeFileSync(globalPrefsPath, "---\nversion: 1\nwidget_mode: off\n---\n", "utf-8");
  writeFileSync(projectPrefsPath, "---\nversion: 1\nwidget_mode: small\n---\n", "utf-8");

  t.after(() => {
    cleanup(homeDir);
    cleanup(projectDir);
    _resetWidgetModeForTests();
  });

  _resetWidgetModeForTests();

  assert.equal(getWidgetMode(projectPrefsPath, globalPrefsPath), "small", "project widget_mode overrides global");
  assert.equal(
    cycleWidgetMode(projectPrefsPath, globalPrefsPath),
    "min",
    "cycling advances from the project-owned mode",
  );

  const projectPrefs = readFileSync(projectPrefsPath, "utf-8");
  const globalPrefs = readFileSync(globalPrefsPath, "utf-8");
  assert.match(projectPrefs, /widget_mode:\s*min/);
  assert.match(globalPrefs, /widget_mode:\s*off/);
});
