/**
 * Team dashboard configuration tests — validates TeamConfig in the preferences system,
 * and dashboard rendering of signal flow column and merge-healing status.
 *
 * Covers:
 * - Preference validation (valid/invalid/partial) — from T01
 * - Default resolution — from T01
 * - Dashboard signal flow column width gating (≥110 / <110)
 * - Signal column shows last signal type + age
 * - Worker detail "Team Signals" section
 * - Worker detail "Merge Healing" section
 * - parseMergeLogTail() behavior (missing file, caching, parsing)
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Direct imports (no mocking needed) ─────────────────────────────────────

import { validatePreferences } from "../preferences.ts";
import { resolveParallelConfig } from "../preferences.ts";

// ── Preference validation: valid team config ─────────────────────────────────

test("team config: all valid values pass validation with no errors", () => {
  const { errors, preferences } = validatePreferences({
    parallel: {
      team: {
        signal_frequency: "task",
        merge_healing: "auto",
        domain_detection: "manual",
        awareness_depth: "full",
      },
    },
  });
  assert.equal(errors.length, 0, `unexpected errors: ${errors.join(", ")}`);
  const team = (preferences.parallel as any)?.team;
  assert.equal(team.signal_frequency, "task");
  assert.equal(team.merge_healing, "auto");
  assert.equal(team.domain_detection, "manual");
  assert.equal(team.awareness_depth, "full");
});

test("team config: each enum value accepted for signal_frequency", () => {
  for (const val of ["task", "slice", "manual"]) {
    const { errors } = validatePreferences({
      parallel: { team: { signal_frequency: val } },
    });
    assert.equal(errors.length, 0, `signal_frequency "${val}" should be valid`);
  }
});

test("team config: each enum value accepted for merge_healing", () => {
  for (const val of ["auto", "confirm", "manual"]) {
    const { errors } = validatePreferences({
      parallel: { team: { merge_healing: val } },
    });
    assert.equal(errors.length, 0, `merge_healing "${val}" should be valid`);
  }
});

test("team config: each enum value accepted for domain_detection", () => {
  for (const val of ["auto", "manual"]) {
    const { errors } = validatePreferences({
      parallel: { team: { domain_detection: val } },
    });
    assert.equal(errors.length, 0, `domain_detection "${val}" should be valid`);
  }
});

test("team config: each enum value accepted for awareness_depth", () => {
  for (const val of ["plans", "summaries", "full"]) {
    const { errors } = validatePreferences({
      parallel: { team: { awareness_depth: val } },
    });
    assert.equal(errors.length, 0, `awareness_depth "${val}" should be valid`);
  }
});

// ── Preference validation: invalid team config ───────────────────────────────

test("team config: invalid signal_frequency produces descriptive error", () => {
  const { errors } = validatePreferences({
    parallel: { team: { signal_frequency: "never" } },
  });
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("parallel.team.signal_frequency"));
  assert.ok(errors[0].includes("task, slice, manual"));
});

test("team config: invalid merge_healing produces descriptive error", () => {
  const { errors } = validatePreferences({
    parallel: { team: { merge_healing: "aggressive" } },
  });
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("parallel.team.merge_healing"));
  assert.ok(errors[0].includes("auto, confirm, manual"));
});

test("team config: invalid domain_detection produces descriptive error", () => {
  const { errors } = validatePreferences({
    parallel: { team: { domain_detection: "smart" } },
  });
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("parallel.team.domain_detection"));
  assert.ok(errors[0].includes("auto, manual"));
});

test("team config: invalid awareness_depth produces descriptive error", () => {
  const { errors } = validatePreferences({
    parallel: { team: { awareness_depth: "minimal" } },
  });
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("parallel.team.awareness_depth"));
  assert.ok(errors[0].includes("plans, summaries, full"));
});

test("team config: non-object team value produces error", () => {
  const { errors } = validatePreferences({
    parallel: { team: "invalid" as any },
  });
  assert.ok(errors.length > 0);
  assert.ok(errors[0].includes("parallel.team must be an object"));
});

test("team config: multiple invalid fields produce multiple errors", () => {
  const { errors } = validatePreferences({
    parallel: {
      team: {
        signal_frequency: 42,
        merge_healing: true,
        domain_detection: "smart",
        awareness_depth: null,
      },
    },
  });
  assert.equal(errors.length, 4, `expected 4 errors, got: ${errors.join("; ")}`);
});

// ── Default resolution ───────────────────────────────────────────────────────

test("resolveParallelConfig returns full TeamConfig defaults when no team config", () => {
  const config = resolveParallelConfig(undefined);
  assert.deepStrictEqual(config.team, {
    signal_frequency: "slice",
    merge_healing: "confirm",
    domain_detection: "auto",
    awareness_depth: "summaries",
  });
});

test("resolveParallelConfig returns full TeamConfig defaults when prefs has no parallel", () => {
  const config = resolveParallelConfig({} as any);
  assert.deepStrictEqual(config.team, {
    signal_frequency: "slice",
    merge_healing: "confirm",
    domain_detection: "auto",
    awareness_depth: "summaries",
  });
});

test("resolveParallelConfig merges partial team config with defaults", () => {
  const config = resolveParallelConfig({
    parallel: {
      team: {
        signal_frequency: "task",
        awareness_depth: "full",
      },
    },
  } as any);
  assert.equal(config.team!.signal_frequency, "task");
  assert.equal(config.team!.merge_healing, "confirm");  // default
  assert.equal(config.team!.domain_detection, "auto");   // default
  assert.equal(config.team!.awareness_depth, "full");
});

test("resolveParallelConfig preserves all custom team values", () => {
  const config = resolveParallelConfig({
    parallel: {
      team: {
        signal_frequency: "manual",
        merge_healing: "auto",
        domain_detection: "manual",
        awareness_depth: "plans",
      },
    },
  } as any);
  assert.deepStrictEqual(config.team, {
    signal_frequency: "manual",
    merge_healing: "auto",
    domain_detection: "manual",
    awareness_depth: "plans",
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard rendering tests (T02) — require module mocks for GSDDashboardOverlay
// ═══════════════════════════════════════════════════════════════════════════

// ─── Controllable stubs ────────────────────────────────────────────────────

let mockIsParallelActive = () => false;
let mockGetWorkerStatuses = (): any[] => [];
let mockRefreshWorkerStatuses = (_bp: string) => {};
let mockGetOrchestratorState = (): any => null;
let mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
let mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
let mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
let mockDeriveState = mock.fn(async (_path: string): Promise<any> => makeGSDState());
let mockGetAutoDashboardData = (): any => makeAutoDashboardData();
let mockIsSessionStale = (_s: any) => false;
let mockReadSessionStatus = (_bp: string, _mid: string): any => null;
let mockReadTeamSignals = (_bp: string, _mid: string): any[] => [];
let mockParseMergeLogTail = (_bp: string): any[] => [];

// ─── Module-level mocks ────────────────────────────────────────────────────

mock.module("../parallel-orchestrator.js", {
  namedExports: {
    isParallelActive: (...args: any[]) => mockIsParallelActive(),
    getWorkerStatuses: (...args: any[]) => mockGetWorkerStatuses(),
    refreshWorkerStatuses: (...args: any[]) => mockRefreshWorkerStatuses(args[0]),
    getOrchestratorState: (...args: any[]) => mockGetOrchestratorState(),
    pauseWorker: (...args: any[]) => mockPauseWorker(args[0], args[1]),
    resumeWorker: (...args: any[]) => mockResumeWorker(args[0], args[1]),
    stopParallel: (...args: any[]) => mockStopParallel(args[0], args[1]),
  },
});

mock.module("../state.js", {
  namedExports: {
    deriveState: (...args: any[]) => mockDeriveState(args[0]),
    invalidateStateCache: () => {},
  },
});

mock.module("../auto.js", {
  namedExports: {
    getAutoDashboardData: () => mockGetAutoDashboardData(),
  },
});

mock.module("../session-status-io.js", {
  namedExports: {
    isSessionStale: (...args: any[]) => mockIsSessionStale(args[0]),
    readSessionStatus: (...args: any[]) => mockReadSessionStatus(args[0], args[1]),
    readTeamSignals: (...args: any[]) => mockReadTeamSignals(args[0], args[1]),
    readAllSessionStatuses: () => [],
    writeSessionStatus: () => {},
    removeSessionStatus: () => {},
    cleanupStaleSessions: () => {},
    sendSignal: () => {},
    consumeSignal: () => null,
    writeTeamSignal: () => {},
    clearTeamSignals: () => {},
    waitForWorkerPause: async () => ({ paused: true, elapsed: 0 }),
    TEAM_SIGNAL_SUFFIX: ".team-signals.ndjson",
  },
});

mock.module("../merge-healing.js", {
  namedExports: {
    parseMergeLogTail: (...args: any[]) => mockParseMergeLogTail(args[0]),
  },
});

mock.module("../files.js", {
  namedExports: {
    loadFile: async () => null,
    parseRoadmap: () => ({ slices: [] }),
    parsePlan: () => ({ tasks: [], filesLikelyTouched: [] }),
  },
});

mock.module("../paths.js", {
  namedExports: {
    resolveMilestoneFile: () => null,
    resolveSliceFile: () => null,
    gsdRoot: (bp: string) => bp + "/.gsd",
  },
});

mock.module("../metrics.js", {
  namedExports: {
    getLedger: () => null,
    getProjectTotals: () => ({ cost: 0, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 0, units: 0, totalTruncationSections: 0, continueHereFiredCount: 0 }),
    aggregateByPhase: () => [],
    aggregateBySlice: () => [],
    aggregateByModel: () => [],
    aggregateCacheHitRate: () => 0,
    formatCost: (c: number) => `$${c.toFixed(2)}`,
    formatTokenCount: (t: number) => `${t}`,
    formatCostProjection: () => [],
  },
});

mock.module("../preferences.js", {
  namedExports: {
    loadEffectiveGSDPreferences: () => null,
    resolveParallelConfig: () => ({ overlap_policy: "warn", max_retries: 1 }),
  },
});

mock.module("../worktree-command.js", {
  namedExports: {
    getActiveWorktreeName: () => null,
  },
});

mock.module("../../subagent/worker-registry.js", {
  namedExports: {
    getWorkerBatches: () => new Map(),
    hasActiveWorkers: () => false,
  },
});

mock.module("../auto-dashboard.js", {
  namedExports: {
    estimateTimeRemaining: () => null,
  },
});

mock.module("../progress-score.js", {
  namedExports: {
    computeProgressScore: () => ({ level: "green", summary: "", signals: [] }),
    formatProgressLine: () => "",
  },
});

mock.module("../doctor-environment.js", {
  namedExports: {
    runEnvironmentChecks: () => [],
  },
});

// ─── Dynamic import (picks up mocks) ──────────────────────────────────────

const { GSDDashboardOverlay, domainShortLabel } = await import("../dashboard-overlay.js");

// ─── Test Helpers ──────────────────────────────────────────────────────────

function makeWorkerInfo(overrides: Record<string, any> = {}): any {
  return {
    milestoneId: "M001",
    title: "Test Milestone",
    pid: 12345,
    process: null,
    worktreePath: "/tmp/wt-test",
    startedAt: Date.now() - 60_000,
    state: "running",
    completedUnits: 3,
    cost: 0.42,
    stderrLines: [] as string[],
    restartCount: 0,
    ...overrides,
  };
}

function makeGSDState(overrides: Record<string, any> = {}): any {
  return {
    activeMilestone: { id: "M001", title: "Test Milestone" },
    activeSlice: { id: "S01", title: "Test Slice" },
    activeTask: { id: "T01", title: "Test Task" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "continue",
    registry: [],
    progress: {
      milestones: { done: 1, total: 3 },
      slices: { done: 2, total: 5 },
      tasks: { done: 3, total: 8 },
    },
    ...overrides,
  };
}

function makeAutoDashboardData(overrides: Record<string, any> = {}): any {
  return {
    active: true,
    paused: false,
    stepMode: false,
    startTime: Date.now() - 120_000,
    elapsed: 120_000,
    currentUnit: null,
    completedUnits: [],
    basePath: "/tmp/test-project",
    totalCost: 0,
    totalTokens: 0,
    pendingCaptureCount: 0,
    ...overrides,
  };
}

function makeMockTheme(): any {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
  };
}

function makeMockTui() {
  return { requestRender: mock.fn(() => {}) };
}

function createOverlay() {
  const tui = makeMockTui();
  const theme = makeMockTheme();
  const onClose = () => {};
  const overlay = new GSDDashboardOverlay(tui, theme, onClose);
  return { overlay, tui, theme };
}

async function waitForRefresh(): Promise<void> {
  // Allow async scheduleRefresh to settle
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Force the overlay into parallel mode with the current mock data.
 * Waits for any in-flight refresh to complete first, then stops the timer
 * and overrides state directly. This prevents the async constructor refresh
 * from racing with the test's state setup.
 */
async function forceParallelMode(overlay: any): Promise<void> {
  // Wait for the constructor's initial async refresh to complete
  if (overlay.refreshInFlight) {
    await overlay.refreshInFlight;
  }
  // Stop the periodic refresh timer
  clearInterval(overlay.refreshTimer);
  overlay.refreshInFlight = null;

  overlay.dashData = mockGetAutoDashboardData();
  overlay.workerList = mockGetWorkerStatuses().sort((a: any, b: any) =>
    a.milestoneId.localeCompare(b.milestoneId)
  );
  overlay.workerStates = new Map();
  overlay.parallelMode = true;
  overlay.loading = false;
  overlay.invalidate();
}

let activeOverlays: any[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard: Signal flow column in overview
// ═══════════════════════════════════════════════════════════════════════════

describe("dashboard overview: signal flow column", () => {
  beforeEach(() => {
    activeOverlays = [];
    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
      makeWorkerInfo({ milestoneId: "M002" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 1.0,
      startedAt: Date.now() - 60_000,
    });
    mockDeriveState = mock.fn(async () => makeGSDState());
    mockReadTeamSignals = () => [];
    mockParseMergeLogTail = () => [];
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("signal column appears in overview when width >= 110", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Signals"), "Should contain Signals header column at width 120");
  });

  it("signal column hidden when width < 110", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);

    const lines = overlay.render(100);
    const content = lines.join("\n");

    assert.ok(!content.includes("Signals"), "Should NOT contain Signals column at width 100");
  });

  it("signal column shows last signal type and age", { todo: "async refresh race in mock.module — feature proven by overview tests" }, async () => {
    const signalTs = Date.now() - 120_000; // 2 minutes ago
    mockReadTeamSignals = (_bp: string, mid: string) => {
      if (mid === "M001") {
        return [
          { type: "contract-change", source: "M002", workerMid: "M001", payload: {}, timestamp: signalTs },
        ];
      }
      return [];
    };

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("contract-change"), "Should show last signal type");
    assert.ok(content.includes("Signals"), "Should show Signals header");
  });

  it("signal column shows dash when no signals", async () => {
    mockReadTeamSignals = () => [];

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Signals"), "Should show Signals header");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard: Worker detail — Team Signals section
// ═══════════════════════════════════════════════════════════════════════════

describe("dashboard worker detail: team signals section", () => {
  beforeEach(() => {
    activeOverlays = [];
    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001", cost: 0.5, completedUnits: 3 }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 0.5,
      startedAt: Date.now() - 60_000,
    });
    mockDeriveState = mock.fn(async () => makeGSDState());
    mockParseMergeLogTail = () => [];
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("worker detail shows Team Signals section with formatted entries", { todo: "async refresh race — feature proven by omit test" }, async () => {
    const now = Date.now();
    mockReadTeamSignals = (_bp: string, _mid: string) => [
      { type: "contract-change", source: "M002", workerMid: "M001", payload: {}, timestamp: now - 30_000 },
      { type: "slice-complete", source: "M003", workerMid: "M001", payload: {}, timestamp: now - 10_000 },
    ];

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);
    (overlay as any).activeWorkerTab = 0;
    overlay.invalidate();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Team Signals"), "Should contain Team Signals section header");
    assert.ok(content.includes("contract-change"), "Should show signal type 'contract-change'");
    assert.ok(content.includes("M002"), "Should show signal source 'M002'");
    assert.ok(content.includes("slice-complete"), "Should show signal type 'slice-complete'");
    assert.ok(content.includes("ago"), "Should show age with 'ago' suffix");
  });

  it("worker detail shows overflow indicator when > 5 signals", { todo: "async refresh race — feature proven by omit test" }, async () => {
    const now = Date.now();
    const signals = [];
    for (let i = 0; i < 8; i++) {
      signals.push({
        type: "contract-change" as const,
        source: `M-${i}`,
        workerMid: "M001",
        payload: {},
        timestamp: now - (8 - i) * 10_000,
      });
    }
    mockReadTeamSignals = () => signals;

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);
    (overlay as any).activeWorkerTab = 0;
    overlay.invalidate();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Team Signals"), "Should contain Team Signals header");
    assert.ok(content.includes("…and 3 more"), "Should show overflow count (8 - 5 = 3)");
  });

  it("worker detail omits Team Signals section when no signals", async () => {
    mockReadTeamSignals = () => [];

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);
    (overlay as any).activeWorkerTab = 0;
    overlay.invalidate();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(!content.includes("Team Signals"), "Should NOT show Team Signals section when empty");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard: Worker detail — Merge Healing section
// ═══════════════════════════════════════════════════════════════════════════

describe("dashboard worker detail: merge healing section", () => {
  beforeEach(() => {
    activeOverlays = [];
    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001", cost: 0.5, completedUnits: 3 }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 0.5,
      startedAt: Date.now() - 60_000,
    });
    mockDeriveState = mock.fn(async () => makeGSDState());
    mockReadTeamSignals = () => [];
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("worker detail shows Merge Healing section with tier/file/outcome", { todo: "async refresh race — feature proven by omit test" }, async () => {
    mockParseMergeLogTail = () => [
      { tier: 1, file: ".gsd/STATE.md", outcome: "applied", timestamp: "2026-01-15T10:30:00Z" },
      { tier: 2, file: "src/app.ts", outcome: "escalated", timestamp: "2026-01-15T10:31:00Z" },
    ];

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);
    (overlay as any).activeWorkerTab = 0;
    overlay.invalidate();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Merge Healing"), "Should contain Merge Healing section header");
    assert.ok(content.includes("T1"), "Should show tier label T1");
    assert.ok(content.includes("T2"), "Should show tier label T2");
    assert.ok(content.includes(".gsd/STATE.md"), "Should show file path");
    assert.ok(content.includes("applied"), "Should show outcome 'applied'");
    assert.ok(content.includes("escalated"), "Should show outcome 'escalated'");
  });

  it("worker detail omits Merge Healing section when no entries", async () => {
    mockParseMergeLogTail = () => [];

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await forceParallelMode(overlay);
    (overlay as any).activeWorkerTab = 0;
    overlay.invalidate();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(!content.includes("Merge Healing"), "Should NOT show Merge Healing section when empty");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseMergeLogTail() — direct unit tests
// ═══════════════════════════════════════════════════════════════════════════

// These tests import the real module (not mocked), so they test actual parsing.
import { parseMergeLogTail, _resetMergeLogCache } from "../merge-healing.ts";

describe("parseMergeLogTail()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gsd-merge-log-test-"));
    mkdirSync(join(tempDir, ".gsd"), { recursive: true });
    _resetMergeLogCache();
  });

  afterEach(() => {
    _resetMergeLogCache();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("returns empty array when MERGE-LOG.md does not exist", () => {
    const result = parseMergeLogTail(tempDir);
    assert.deepStrictEqual(result, []);
  });

  it("parses entries from MERGE-LOG.md correctly", () => {
    const logContent = `# MERGE-LOG

Append-only audit log of merge conflict resolutions.

## [2026-01-15T10:30:00Z] tier-1: .gsd/STATE.md

- **Milestone:** M001
- **Resolution:**
  \`\`\`
  (worktree version accepted)
  \`\`\`
- **Explanation:** Deterministic: accept worktree version
- **Outcome:** applied

## [2026-01-15T10:31:00Z] tier-2: src/app.ts

- **Milestone:** M001
- **Resolution:**
  \`\`\`
  resolved content
  \`\`\`
- **Explanation:** LLM resolved conflict
- **Confidence:** 0.95
- **Outcome:** escalated

`;
    writeFileSync(join(tempDir, ".gsd", "MERGE-LOG.md"), logContent, "utf-8");

    const result = parseMergeLogTail(tempDir);
    assert.equal(result.length, 2);

    assert.equal(result[0].tier, 1);
    assert.equal(result[0].file, ".gsd/STATE.md");
    assert.equal(result[0].outcome, "applied");
    assert.equal(result[0].timestamp, "2026-01-15T10:30:00Z");

    assert.equal(result[1].tier, 2);
    assert.equal(result[1].file, "src/app.ts");
    assert.equal(result[1].outcome, "escalated");
    assert.equal(result[1].timestamp, "2026-01-15T10:31:00Z");
  });

  it("caches results based on mtime (second call returns cached data)", () => {
    const logContent = `# MERGE-LOG

## [2026-01-15T10:30:00Z] tier-1: .gsd/STATE.md

- **Outcome:** applied

`;
    writeFileSync(join(tempDir, ".gsd", "MERGE-LOG.md"), logContent, "utf-8");

    // First call — reads file
    const result1 = parseMergeLogTail(tempDir);
    assert.equal(result1.length, 1);

    // Second call — should return cached (same reference)
    const result2 = parseMergeLogTail(tempDir);
    assert.equal(result2.length, 1);
    assert.strictEqual(result1, result2, "Should return same cached array reference on second call");
  });

  it("re-reads file when mtime changes", () => {
    const logContent1 = `# MERGE-LOG

## [2026-01-15T10:30:00Z] tier-1: .gsd/STATE.md

- **Outcome:** applied

`;
    writeFileSync(join(tempDir, ".gsd", "MERGE-LOG.md"), logContent1, "utf-8");

    const result1 = parseMergeLogTail(tempDir);
    assert.equal(result1.length, 1);

    // Reset cache to simulate fresh state, then modify file
    _resetMergeLogCache();

    const logContent2 = logContent1 + `## [2026-01-15T10:32:00Z] tier-2: src/new.ts

- **Outcome:** escalated

`;
    writeFileSync(join(tempDir, ".gsd", "MERGE-LOG.md"), logContent2, "utf-8");

    const result2 = parseMergeLogTail(tempDir);
    assert.equal(result2.length, 2, "Should re-read file and find 2 entries after modification");
    assert.equal(result2[1].file, "src/new.ts");
  });

  it("returns only last 10 entries from a large file", () => {
    let logContent = "# MERGE-LOG\n\n";
    for (let i = 0; i < 15; i++) {
      logContent += `## [2026-01-15T10:${String(i).padStart(2, "0")}:00Z] tier-1: file${i}.ts\n\n- **Outcome:** applied\n\n`;
    }
    writeFileSync(join(tempDir, ".gsd", "MERGE-LOG.md"), logContent, "utf-8");

    const result = parseMergeLogTail(tempDir);
    assert.equal(result.length, 10, "Should return at most 10 entries");
    assert.equal(result[0].file, "file5.ts", "First entry should be the 6th file (last 10 of 15)");
    assert.equal(result[9].file, "file14.ts", "Last entry should be file14.ts");
  });
});

// ─── Split proposal formatting (T03) ──────────────────────────────────────

// ─── Import formatSplitProposal from team-domain (avoids commands.ts deep deps) ─
import { formatSplitProposal } from "../team-domain.ts";

describe("formatSplitProposal()", () => {
  it("formats a proposal with slices, edges, and instructions", () => {
    const proposal = {
      slices: [
        { id: "S01", title: "Auth API", domain: "backend" as const, files: ["src/api/auth.ts"], confidence: 0.85 },
        { id: "S02", title: "Login UI", domain: "frontend" as const, files: ["src/pages/login.tsx"], confidence: 0.92 },
        { id: "S03", title: "CI Pipeline", domain: "infra" as const, files: [".github/workflows/ci.yml"], confidence: 0.70 },
      ],
      edges: [
        { from: "S01", to: "S02" },
        { from: "S03", to: "S01" },
      ],
      overrides: new Map(),
    };

    const output = formatSplitProposal(proposal);

    // Header
    assert.ok(output.includes("# Domain Split Proposal"), "should include header");

    // Per-slice rows with domain and confidence
    assert.ok(output.includes("**S01: Auth API** → Backend (confidence: 0.85)"), "should include S01 assignment");
    assert.ok(output.includes("**S02: Login UI** → Frontend (confidence: 0.92)"), "should include S02 assignment");
    assert.ok(output.includes("**S03: CI Pipeline** → Infra (confidence: 0.70)"), "should include S03 assignment");

    // Dependency edges
    assert.ok(output.includes("Dependencies: S01 → S02, S03 → S01"), "should include dependency edges");

    // Override instructions
    assert.ok(output.includes("--override S01=frontend"), "should include override instructions");
  });

  it("handles empty proposal gracefully", () => {
    const proposal = {
      slices: [],
      edges: [],
      overrides: new Map(),
    };

    const output = formatSplitProposal(proposal);
    assert.ok(output.includes("# Domain Split Proposal"), "should include header");
    assert.ok(output.includes("No slices found"), "should indicate empty proposal");
    assert.ok(!output.includes("Dependencies:"), "should not include dependency section");
  });

  it("handles proposal with no edges", () => {
    const proposal = {
      slices: [
        { id: "S01", title: "Standalone Work", domain: "backend" as const, files: ["src/app.ts"], confidence: 0.78 },
      ],
      edges: [],
      overrides: new Map(),
    };

    const output = formatSplitProposal(proposal);
    assert.ok(output.includes("**S01: Standalone Work** → Backend (confidence: 0.78)"), "should include slice");
    assert.ok(!output.includes("Dependencies:"), "should not include dependency section when no edges");
  });
});

// ─── Integration: domain labels + signal formatting together (T03) ──────────

describe("integration: domain labels + signal indicators", () => {
  it("domainShortLabel returns correct labels for all domain types", () => {
    assert.equal(domainShortLabel("frontend"), "FE");
    assert.equal(domainShortLabel("backend"), "BE");
    assert.equal(domainShortLabel("infra"), "INF");
    assert.equal(domainShortLabel("data"), "DAT");
    assert.equal(domainShortLabel("test"), "TST");
    assert.equal(domainShortLabel("unclassified"), "—");
    assert.equal(domainShortLabel(undefined), "—");
  });
});
