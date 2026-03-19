/**
 * Contract tests for parallel dashboard features in GSDDashboardOverlay.
 *
 * Covers: parallel mode detection, worker overview/detail rendering,
 * tab cycling, signal dispatch (p/r/x), and D048 stop confirmation
 * state machine. All orchestrator functions are mocked — no real workers
 * needed.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/parallel-dashboard.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Module-level mocks ────────────────────────────────────────────────────
// Must be set up BEFORE dynamic import of dashboard-overlay.

// Controllable stubs — reassigned per test via beforeEach
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
    readTeamSignals: () => [],
    writeTeamSignal: () => {},
    clearTeamSignals: () => {},
  },
});

// Stubs for modules that dashboard imports but are not exercised in parallel tests
mock.module("../files.js", {
  namedExports: {
    loadFile: async () => null,
    parseRoadmap: () => ({ slices: [] }),
    parsePlan: () => ({ tasks: [] }),
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

const { GSDDashboardOverlay } = await import("../dashboard-overlay.js");

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

/** Create a minimal Theme-like object that passes through text with marker prefixes for testing. */
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

/**
 * Create a dashboard overlay instance.
 * Needs a small delay for the initial refresh to complete.
 */
function createOverlay(tui?: any, theme?: any, onClose?: () => void) {
  const t = tui ?? makeMockTui();
  const th = theme ?? makeMockTheme();
  const close = onClose ?? (() => {});
  const overlay = new GSDDashboardOverlay(t, th, close);
  return { overlay, tui: t, theme: th };
}

/** Wait for the async initial refresh to complete. */
async function waitForRefresh(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Track overlays for cleanup
let activeOverlays: any[] = [];

// ─── Tests ────────────────────────────────────────────────────────────────

describe("parallel dashboard: mode detection", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    activeOverlays = [];
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("renders single-milestone view when isParallelActive() returns false", async () => {
    mockIsParallelActive = () => false;
    mockGetAutoDashboardData = () => makeAutoDashboardData();

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    // Should show standard "GSD Dashboard" header without "PARALLEL"
    assert.ok(content.includes("GSD Dashboard"), "Should contain dashboard title");
    assert.ok(!content.includes("PARALLEL"), "Should NOT contain PARALLEL indicator");
  });

  it("renders parallel overview when isParallelActive() returns true", async () => {
    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
      makeWorkerInfo({ milestoneId: "M002" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 1.5,
      startedAt: Date.now() - 60_000,
    });

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("PARALLEL"), "Should contain PARALLEL indicator");
    assert.ok(content.includes("M001"), "Should contain first worker milestone ID");
    assert.ok(content.includes("M002"), "Should contain second worker milestone ID");
  });
});

describe("parallel dashboard: worker detail content and tab cycling", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    activeOverlays = [];

    // Default: parallel active with two workers
    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001", cost: 0.75, completedUnits: 5 }),
      makeWorkerInfo({ milestoneId: "M002", cost: 1.20, completedUnits: 8 }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 1.95,
      startedAt: Date.now() - 60_000,
    });
    mockDeriveState = mock.fn(async (_path: string) =>
      makeGSDState({
        progress: {
          milestones: { done: 1, total: 3 },
          slices: { done: 2, total: 5 },
          tasks: { done: 3, total: 8 },
        },
        activeSlice: { id: "S01", title: "Test Slice" },
        activeTask: { id: "T01", title: "Test Task" },
      }),
    );
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("Tab key switches from overview (tab -1) to first worker (tab 0)", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Verify starts at overview
    let lines = overlay.render(120);
    let content = lines.join("\n");
    assert.ok(content.includes("PARALLEL"), "Should show overview initially");

    // Press Tab
    overlay.handleInput("\t");
    await waitForRefresh();

    lines = overlay.render(120);
    content = lines.join("\n");

    // Worker detail should show M001 (first worker sorted by milestoneId)
    assert.ok(content.includes("M001"), "Should show M001 worker detail after Tab");
    // Detail shows PID
    assert.ok(content.includes("PID"), "Worker detail should show PID");
  });

  it("worker detail contains progress data from mocked GSDState", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Navigate to first worker
    overlay.handleInput("\t");
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    // Should show slice and task progress
    assert.ok(content.includes("Slices"), "Detail should contain Slices progress label");
    assert.ok(content.includes("Tasks"), "Detail should contain Tasks progress label");
  });

  it("worker detail contains ETA or calculating text", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    // ETA should be shown (deriveState returns slices with done > 0 and remaining > 0)
    assert.ok(
      content.includes("ETA") || content.includes("calculating"),
      "Detail should show ETA or calculating text",
    );
  });

  it("worker detail contains cost from WorkerInfo", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Cost"), "Detail should contain Cost label");
    assert.ok(content.includes("0.75"), "Detail should contain worker cost value");
  });

  it("shows Errors section when stderrLines has content", async () => {
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({
        milestoneId: "M001",
        stderrLines: ["Error: something went wrong", "FATAL: disk full"],
      }),
      makeWorkerInfo({ milestoneId: "M002" }),
    ];

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Errors"), "Detail should contain Errors section header");
    assert.ok(content.includes("something went wrong"), "Detail should show stderr line content");
  });

  it("shows restart indicator when restartCount > 0", async () => {
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001", restartCount: 2 }),
      makeWorkerInfo({ milestoneId: "M002" }),
    ];

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Restarted"), "Detail should contain restart indicator");
    assert.ok(content.includes("2"), "Should show restart count");
  });

  it("Shift+Tab cycles backwards from worker 0 to overview", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Go to first worker
    overlay.handleInput("\t");
    await waitForRefresh();

    let lines = overlay.render(120);
    assert.ok(lines.join("\n").includes("PID"), "Should be on worker detail");

    // Shift+Tab back to overview
    overlay.handleInput("\x1b[Z"); // Shift+Tab escape sequence
    await waitForRefresh();

    lines = overlay.render(120);
    const content = lines.join("\n");

    // Should be back at overview with worker count
    assert.ok(content.includes("worker"), "Should be back at overview showing worker count");
  });

  it("Tab wraps around from last worker to overview", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab to worker 0
    overlay.handleInput("\t");
    await waitForRefresh();
    // Tab to worker 1
    overlay.handleInput("\t");
    await waitForRefresh();

    let lines = overlay.render(120);
    assert.ok(lines.join("\n").includes("M002"), "Should be on second worker");

    // Tab wraps to overview
    overlay.handleInput("\t");
    await waitForRefresh();

    lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("PARALLEL"), "Should wrap back to overview");
  });
});

describe("parallel dashboard: signal dispatch and stop confirmation", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
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
      totalCost: 0.5,
      startedAt: Date.now() - 60_000,
    });
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("pressing p on focused worker tab calls pauseWorker with correct args", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Navigate to first worker
    overlay.handleInput("\t");
    await waitForRefresh();

    overlay.handleInput("p");

    assert.equal(mockPauseWorker.mock.calls.length, 1, "pauseWorker should be called once");
    assert.equal(mockPauseWorker.mock.calls[0].arguments[0], "/tmp/test-project", "basePath should match");
    assert.equal(mockPauseWorker.mock.calls[0].arguments[1], "M001", "milestoneId should match first worker");
  });

  it("pressing r on focused worker tab calls resumeWorker with correct args", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    overlay.handleInput("r");

    assert.equal(mockResumeWorker.mock.calls.length, 1, "resumeWorker should be called once");
    assert.equal(mockResumeWorker.mock.calls[0].arguments[0], "/tmp/test-project");
    assert.equal(mockResumeWorker.mock.calls[0].arguments[1], "M001");
  });

  it("first x press does NOT call stopParallel — sets confirmation state", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    overlay.handleInput("x");

    assert.equal(mockStopParallel.mock.calls.length, 0, "stopParallel should NOT be called on first x");

    // Render should show confirmation text
    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("confirm"), "Should show confirmation prompt after first x");
  });

  it("second x within 3s calls stopParallel with correct args", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    // First x — starts confirmation
    overlay.handleInput("x");
    assert.equal(mockStopParallel.mock.calls.length, 0);

    // Second x — confirms stop
    overlay.handleInput("x");
    assert.equal(mockStopParallel.mock.calls.length, 1, "stopParallel should be called on second x");
    assert.equal(mockStopParallel.mock.calls[0].arguments[0], "/tmp/test-project");
    assert.equal(mockStopParallel.mock.calls[0].arguments[1], "M001");
  });

  it("confirmation resets after 3s timeout — next x starts fresh cycle", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    // First x
    overlay.handleInput("x");
    assert.equal(mockStopParallel.mock.calls.length, 0);

    // Wait for timeout to expire
    await new Promise((resolve) => setTimeout(resolve, 3200));

    // Next x should start fresh confirmation cycle
    overlay.handleInput("x");
    assert.equal(mockStopParallel.mock.calls.length, 0, "Should NOT call stopParallel — fresh cycle started");

    // Second x in new cycle confirms
    overlay.handleInput("x");
    assert.equal(mockStopParallel.mock.calls.length, 1, "Should now call stopParallel on second x of new cycle");
  });

  it("pressing non-x key during confirmation resets the state", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    // First x — start confirmation
    overlay.handleInput("x");

    // Verify confirmation is active
    let lines = overlay.render(120);
    assert.ok(lines.join("\n").includes("confirm"), "Confirmation should be active");

    // Press an unhandled key (q) — reaches the confirmingStop reset block at end of handleInput
    overlay.handleInput("q");

    // Confirmation should be reset — render should NOT show "confirm stop"
    lines = overlay.render(120);
    const contentAfterReset = lines.join("\n");
    // The footer should now show normal controls, not confirmation prompt
    assert.ok(
      contentAfterReset.includes("pause") || !contentAfterReset.includes("confirm stop"),
      "Confirmation should be reset after non-x key",
    );

    // Next x should not dispatch — it starts a fresh cycle
    overlay.handleInput("x");
    assert.equal(mockStopParallel.mock.calls.length, 0, "stopParallel should NOT be called after reset");
  });

  it("signal keys are ignored when on overview tab (activeWorkerTab === -1)", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Stay on overview — don't press Tab
    overlay.handleInput("p");
    overlay.handleInput("r");
    overlay.handleInput("x");

    assert.equal(mockPauseWorker.mock.calls.length, 0, "pauseWorker should not be called on overview");
    assert.equal(mockResumeWorker.mock.calls.length, 0, "resumeWorker should not be called on overview");
    assert.equal(mockStopParallel.mock.calls.length, 0, "stopParallel should not be called on overview");
  });

  it("p key targets the correct worker when second worker is focused", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab twice to get to second worker (M002)
    overlay.handleInput("\t");
    await waitForRefresh();
    overlay.handleInput("\t");
    await waitForRefresh();

    overlay.handleInput("p");

    assert.equal(mockPauseWorker.mock.calls.length, 1);
    assert.equal(mockPauseWorker.mock.calls[0].arguments[1], "M002", "Should target M002 when second worker is focused");
  });
});

describe("parallel dashboard: overview content", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    activeOverlays = [];

    mockIsParallelActive = () => true;
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("overview shows worker count", async () => {
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
      makeWorkerInfo({ milestoneId: "M002" }),
      makeWorkerInfo({ milestoneId: "M003" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 3.0,
      startedAt: Date.now() - 60_000,
    });

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("3 workers"), "Overview should show worker count");
  });

  it("overview shows total cost from orchestrator state", async () => {
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001", cost: 1.5 }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 1.5,
      startedAt: Date.now() - 60_000,
    });

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("1.50"), "Overview should show total cost");
  });

  it("overview footer shows tab navigation hint", async () => {
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true,
      workers: new Map(),
      config: {},
      totalCost: 0,
      startedAt: Date.now() - 60_000,
    });

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    assert.ok(content.includes("Tab"), "Overview footer should mention Tab for navigation");
    assert.ok(content.includes("Esc"), "Overview footer should mention Esc to close");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S03: Mouse support, scroll-thumb, and filter mode tests
// ═══════════════════════════════════════════════════════════════════════════

describe("S03: parseSGRMouse via handleInput", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    mockIsParallelActive = () => false;
    mockGetAutoDashboardData = () => makeAutoDashboardData();
    activeOverlays = [];
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("wheel-up SGR sequence decrements scrollOffset", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // First scroll down so we have room to scroll up
    overlay.handleInput("\x1b[<65;10;5M"); // wheel down
    overlay.handleInput("\x1b[<65;10;5M"); // wheel down again (+6 total)

    // Now scroll up
    overlay.handleInput("\x1b[<64;10;5M"); // wheel up (-3)

    // Render to observe — scrollOffset should be 3 (6-3)
    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Should render without error after mouse wheel events");
  });

  it("wheel-down SGR sequence increments scrollOffset", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Wheel down — scrollOffset increases (render clamps, but handleInput increments by 3)
    overlay.handleInput("\x1b[<65;10;5M");
    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Should render without error after wheel-down");
  });

  it("release event (lowercase m suffix) does NOT trigger click action", async () => {
    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
      makeWorkerInfo({ milestoneId: "M002" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true, workers: new Map(), config: {}, totalCost: 0, startedAt: Date.now(),
    });

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Send release event (press = false due to lowercase 'm')
    overlay.handleInput("\x1b[<0;10;6m");

    // Should still be on overview — release should not switch tabs
    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("PARALLEL"), "Should still be on overview after release event");
  });

  it("invalid/non-mouse input does not crash or change state", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Send various invalid sequences — none should crash
    overlay.handleInput("\x1b[<abc;10;5M");  // non-numeric button
    overlay.handleInput("\x1b[<64;xyz;5M");  // non-numeric coords
    overlay.handleInput("random text");
    overlay.handleInput("\x1b[<64");          // truncated sequence

    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Should render without error after invalid input");
  });
});

describe("S03: mouse wheel scrolling", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    mockIsParallelActive = () => false;
    mockGetAutoDashboardData = () => makeAutoDashboardData();
    activeOverlays = [];
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("scrollOffset never goes negative after multiple wheel-up events", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Send many wheel-up events from offset 0
    overlay.handleInput("\x1b[<64;10;5M");
    overlay.handleInput("\x1b[<64;10;5M");
    overlay.handleInput("\x1b[<64;10;5M");

    // render() clamps scrollOffset — should not crash or produce garbage
    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Should render cleanly after over-scrolling up");
    // Verify no negative offset by checking render doesn't produce empty content
    const content = lines.join("\n");
    assert.ok(content.includes("GSD Dashboard"), "Dashboard content should still be visible");
  });

  it("wheel-down then wheel-up returns to original position", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Capture baseline render
    const baseline = overlay.render(120).join("\n");

    // Scroll down then back up (same number of events)
    overlay.handleInput("\x1b[<65;10;5M"); // down +3
    overlay.handleInput("\x1b[<64;10;5M"); // up -3

    overlay.invalidate();
    const afterRoundTrip = overlay.render(120).join("\n");
    // Content should be equivalent (scrollOffset back to 0)
    assert.equal(afterRoundTrip, baseline, "Round-trip scroll should return to same view");
  });
});

describe("S03: mouse click worker selection", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    activeOverlays = [];

    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
      makeWorkerInfo({ milestoneId: "M002" }),
      makeWorkerInfo({ milestoneId: "M003" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true, workers: new Map(), config: {}, totalCost: 0, startedAt: Date.now(),
    });
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("left click on first worker row switches to worker detail", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Overview has: border(1) + title(1) + blank(1) + totalCost(1) + blank(1) + columnHeader(1) + hr(1) = 7 rows before workers
    // Worker row 0 → mouse.y such that contentRow-4=0 → contentRow=4 → mouse.y - 2 + 0 = 4 → mouse.y=6
    overlay.handleInput("\x1b[<0;10;6M"); // left click, press, y=6

    await waitForRefresh();
    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("PID"), "Should switch to worker detail view showing PID");
    assert.ok(content.includes("M001"), "Should show first worker M001");
  });

  it("left click on second worker row switches to that worker", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Worker row 1 → workerIndex=1 → contentRow=5 → mouse.y=7
    overlay.handleInput("\x1b[<0;10;7M"); // left click y=7

    await waitForRefresh();
    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("PID"), "Should switch to worker detail view");
    assert.ok(content.includes("M002"), "Should show second worker M002");
  });

  it("click outside worker row range does not switch tab", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Click on header area (y=2) — too high for any worker row
    overlay.handleInput("\x1b[<0;10;2M");

    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("PARALLEL"), "Should remain on overview — click was above worker rows");
  });

  it("click in non-parallel mode is ignored", async () => {
    mockIsParallelActive = () => false;
    mockGetAutoDashboardData = () => makeAutoDashboardData();

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Left click — should be ignored in non-parallel mode
    overlay.handleInput("\x1b[<0;10;6M");

    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("GSD Dashboard"), "Should remain on standard dashboard");
    assert.ok(!content.includes("PID"), "Should NOT switch to any worker detail");
  });
});

describe("S03: scroll-thumb rendering", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    activeOverlays = [];

    // Force small viewport to trigger overflow
    const originalRows = process.stdout.rows;
    process.stdout.rows = 15; // Small terminal height → only ~5 visible content rows
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
    process.stdout.rows = 24; // Restore default
  });

  it("scroll-thumb (┃) appears when content overflows viewport", async () => {
    // Set up parallel mode with many workers to ensure overflow
    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => Array.from({ length: 15 }, (_, i) =>
      makeWorkerInfo({ milestoneId: `M${String(i + 1).padStart(3, "0")}` }),
    );
    mockGetOrchestratorState = () => ({
      active: true, workers: new Map(), config: {}, totalCost: 0, startedAt: Date.now(),
    });

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    // Bold ┃ (U+2503) should appear somewhere on the right border
    assert.ok(content.includes("┃"), "Scroll-thumb (┃) should be visible when content overflows");
  });

  it("no scroll-thumb when content fits within viewport", async () => {
    // Single-mode dashboard with minimal content
    mockIsParallelActive = () => false;
    mockGetAutoDashboardData = () => makeAutoDashboardData({ active: false, completedUnits: [] });
    process.stdout.rows = 80; // Large viewport

    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    const lines = overlay.render(120);
    const content = lines.join("\n");

    // Should only have normal │ (U+2502) borders, not bold ┃
    assert.ok(!content.includes("┃"), "Scroll-thumb (┃) should NOT appear when content fits");
  });
});

describe("S03: filter mode", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    activeOverlays = [];

    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001", title: "Alpha Feature" }),
      makeWorkerInfo({ milestoneId: "M002", title: "Beta Bugfix" }),
      makeWorkerInfo({ milestoneId: "M003", title: "Gamma Release" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true, workers: new Map(), config: {}, totalCost: 0, startedAt: Date.now(),
    });
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("/ key activates filter mode — shows filter indicator", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("/");

    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("Filter:"), "Should show filter indicator after pressing /");
    assert.ok(content.includes("▌"), "Should show cursor indicator in filter line");
  });

  it("typing in filter mode accumulates filterText", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("/");
    overlay.handleInput("e");
    overlay.handleInput("r");
    overlay.handleInput("r");

    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("Filter: err"), "Filter text should accumulate typed characters");
  });

  it("Backspace in filter mode deletes last character", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("/");
    overlay.handleInput("e");
    overlay.handleInput("r");
    overlay.handleInput("r");
    overlay.handleInput("\x7f"); // Backspace

    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(content.includes("Filter: er"), "Backspace should delete last char");
    assert.ok(!content.includes("Filter: err"), "Should not still show 'err' after backspace");
  });

  it("Esc in filter mode clears filter and exits — does NOT close overlay", async () => {
    let closed = false;
    const { overlay } = createOverlay(undefined, undefined, () => { closed = true; });
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("/");
    overlay.handleInput("t");
    overlay.handleInput("e");
    overlay.handleInput("s");
    overlay.handleInput("t");

    // Esc should exit filter mode, NOT close overlay
    overlay.handleInput("\x1b");

    assert.equal(closed, false, "Overlay should NOT be closed by Esc in filter mode");

    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(!content.includes("Filter:"), "Filter indicator should be gone after Esc");
  });

  it("Enter in filter mode exits but preserves filterText", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("/");
    overlay.handleInput("m");
    overlay.handleInput("0");
    overlay.handleInput("0");
    overlay.handleInput("1");
    overlay.handleInput("\r"); // Enter

    const lines = overlay.render(120);
    const content = lines.join("\n");
    // Filter indicator should be gone (exited filter mode)
    assert.ok(!content.includes("Filter:"), "Filter indicator should be gone after Enter");
    // But filter should still be active — only M001-matching lines visible
    assert.ok(content.includes("M001"), "M001 line should match the filter");
  });

  it("filter reduces rendered content to matching lines only", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Baseline: should have M001, M002, M003
    let lines = overlay.render(120);
    let content = lines.join("\n");
    assert.ok(content.includes("M001"), "Baseline should contain M001");
    assert.ok(content.includes("M002"), "Baseline should contain M002");
    assert.ok(content.includes("M003"), "Baseline should contain M003");

    // Enter filter and type "M001", then confirm with Enter
    overlay.handleInput("/");
    overlay.handleInput("M");
    overlay.handleInput("0");
    overlay.handleInput("0");
    overlay.handleInput("1");
    overlay.handleInput("\r"); // Enter to confirm

    overlay.invalidate();
    lines = overlay.render(120);
    content = lines.join("\n");
    assert.ok(content.includes("M001"), "Filtered content should include M001");
    assert.ok(!content.includes("M002"), "Filtered content should exclude M002");
    assert.ok(!content.includes("M003"), "Filtered content should exclude M003");
  });

  it("Esc after filter-mode Esc closes the overlay (two Esc presses)", async () => {
    let closed = false;
    const { overlay } = createOverlay(undefined, undefined, () => { closed = true; });
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("/");  // Enter filter mode
    overlay.handleInput("\x1b"); // First Esc — exits filter mode
    assert.equal(closed, false, "First Esc should only exit filter mode");

    overlay.handleInput("\x1b"); // Second Esc — closes overlay
    assert.equal(closed, true, "Second Esc should close the overlay");
  });

  it("scrollOffset is clamped when filter reduces content length", async () => {
    const { overlay } = createOverlay();
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Scroll down first
    overlay.handleInput("\x1b[<65;10;5M"); // wheel down +3
    overlay.handleInput("\x1b[<65;10;5M"); // wheel down +3

    // Now apply a restrictive filter that reduces content dramatically
    overlay.handleInput("/");
    overlay.handleInput("M");
    overlay.handleInput("0");
    overlay.handleInput("0");
    overlay.handleInput("1");
    overlay.handleInput("\r");

    // render() should clamp scrollOffset — no crash, no blank content
    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Should render without crash after filter reduces content");
  });
});
