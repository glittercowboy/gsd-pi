/**
 * Contract tests for dashboard port UX — Enter triggers port, Escape detaches.
 *
 * Covers: Enter on worker detail triggers onPort callback with correct milestoneId,
 * Enter on overview is a no-op, Escape during active port triggers onDetach,
 * Escape priority (filter mode > port > close), backward compatibility when
 * no port callbacks are provided.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/parallel-dashboard-port.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Module-level mocks (K005 — must be set up BEFORE dynamic import) ──────

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
 * Create a dashboard overlay instance with optional port callbacks.
 * The 4th argument is the portOpts object.
 */
function createOverlay(
  portOpts?: {
    onPort?: (workerId: string) => Promise<void>;
    onDetach?: () => Promise<void>;
    isPortActive?: () => boolean;
    getPortedWorkerId?: () => string | null;
  },
  onClose?: () => void,
) {
  const tui = makeMockTui();
  const theme = makeMockTheme();
  const close = onClose ?? (() => {});
  const overlay = new GSDDashboardOverlay(tui, theme, close, portOpts);
  return { overlay, tui, theme };
}

async function waitForRefresh(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Track overlays for cleanup (K006 — prevents test hangs from lingering timers)
let activeOverlays: any[] = [];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("dashboard port UX: Enter triggers port", () => {
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
    ];
    mockGetOrchestratorState = () => ({
      active: true, workers: new Map(), config: {}, totalCost: 0.5, startedAt: Date.now() - 60_000,
    });
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("Enter on worker detail triggers onPort with correct milestoneId and disposes dashboard", async () => {
    const onPort = mock.fn(async (_wid: string) => {});
    const { overlay } = createOverlay({ onPort });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab to first worker (M001)
    overlay.handleInput("\t");
    await waitForRefresh();

    // Press Enter
    overlay.handleInput("\r");

    assert.equal(onPort.mock.calls.length, 1, "onPort should be called once");
    assert.equal(onPort.mock.calls[0].arguments[0], "M001", "onPort should receive M001");
  });

  it("Enter on overview does NOT trigger onPort", async () => {
    const onPort = mock.fn(async (_wid: string) => {});
    const { overlay } = createOverlay({ onPort });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Stay on overview (activeWorkerTab === -1)
    overlay.handleInput("\r");

    assert.equal(onPort.mock.calls.length, 0, "onPort should NOT be called on overview");
  });

  it("Enter when no onPort callback is a no-op — does not crash", async () => {
    const { overlay } = createOverlay(); // no portOpts at all
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab to worker detail
    overlay.handleInput("\t");
    await waitForRefresh();

    // Press Enter — should not crash
    overlay.handleInput("\r");

    // Verify overlay still renders fine
    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Overlay should still render after Enter with no onPort");
  });

  it("onPort receives correct milestoneId when second worker is selected", async () => {
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
      makeWorkerInfo({ milestoneId: "M002" }),
      makeWorkerInfo({ milestoneId: "M003" }),
    ];

    const onPort = mock.fn(async (_wid: string) => {});
    const { overlay } = createOverlay({ onPort });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab to first worker, then Tab to second
    overlay.handleInput("\t");
    await waitForRefresh();
    overlay.handleInput("\t");
    await waitForRefresh();

    overlay.handleInput("\r");

    assert.equal(onPort.mock.calls.length, 1, "onPort should be called once");
    assert.equal(onPort.mock.calls[0].arguments[0], "M002", "onPort should receive M002 (second worker)");
  });

  it("Enter on a non-running worker does NOT trigger onPort", async () => {
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001", state: "paused" }),
    ];

    const onPort = mock.fn(async (_wid: string) => {});
    const { overlay } = createOverlay({ onPort });
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\t");
    await waitForRefresh();

    overlay.handleInput("\r");

    assert.equal(onPort.mock.calls.length, 0, "onPort should NOT be called for paused worker");
  });
});

describe("dashboard port UX: Escape triggers detach", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    activeOverlays = [];

    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true, workers: new Map(), config: {}, totalCost: 0, startedAt: Date.now() - 60_000,
    });
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("Escape during active port triggers onDetach", async () => {
    const onDetach = mock.fn(async () => {});
    let closed = false;
    const { overlay } = createOverlay(
      { onDetach, isPortActive: () => true },
      () => { closed = true; },
    );
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Press Escape
    overlay.handleInput("\x1b");

    assert.equal(onDetach.mock.calls.length, 1, "onDetach should be called once");
    assert.equal(closed, false, "onClose should NOT be called when port is active — detach instead");
  });

  it("Escape with no active port closes overlay normally", async () => {
    let closed = false;
    const { overlay } = createOverlay(
      { isPortActive: () => false },
      () => { closed = true; },
    );
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("\x1b");

    assert.equal(closed, true, "Overlay should be closed when port is NOT active");
  });

  it("Escape priority — filter mode beats port (K008)", async () => {
    const onDetach = mock.fn(async () => {});
    let closed = false;
    const { overlay } = createOverlay(
      { onDetach, isPortActive: () => true },
      () => { closed = true; },
    );
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Enter filter mode
    overlay.handleInput("/");
    overlay.handleInput("t");
    overlay.handleInput("e");
    overlay.handleInput("s");

    // Now Escape — should clear filter, NOT detach
    overlay.handleInput("\x1b");

    assert.equal(onDetach.mock.calls.length, 0, "onDetach should NOT be called — filter mode takes priority");
    assert.equal(closed, false, "Overlay should NOT be closed — filter mode Esc exits filter");

    // Verify filter mode exited
    const lines = overlay.render(120);
    const content = lines.join("\n");
    assert.ok(!content.includes("Filter:"), "Filter indicator should be cleared");

    // Second Escape — now should trigger detach (port is still active)
    overlay.handleInput("\x1b");
    assert.equal(onDetach.mock.calls.length, 1, "Second Escape should trigger detach");
  });

  it("Ctrl+C closes overlay even when port is active (emergency exit)", async () => {
    const onDetach = mock.fn(async () => {});
    let closed = false;
    const { overlay } = createOverlay(
      { onDetach, isPortActive: () => true },
      () => { closed = true; },
    );
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Ctrl+C should close regardless
    overlay.handleInput("\x03");

    assert.equal(closed, true, "Ctrl+C should close overlay even during active port");
    assert.equal(onDetach.mock.calls.length, 0, "onDetach should NOT be called on Ctrl+C");
  });
});

describe("dashboard port UX: backward compatibility", () => {
  beforeEach(() => {
    mockPauseWorker = mock.fn((_bp: string, _mid: string) => {});
    mockResumeWorker = mock.fn((_bp: string, _mid: string) => {});
    mockStopParallel = mock.fn(async (_bp: string, _mid: string) => {});
    mockDeriveState = mock.fn(async (_path: string) => makeGSDState());
    activeOverlays = [];

    mockIsParallelActive = () => true;
    mockGetWorkerStatuses = () => [
      makeWorkerInfo({ milestoneId: "M001" }),
    ];
    mockGetOrchestratorState = () => ({
      active: true, workers: new Map(), config: {}, totalCost: 0, startedAt: Date.now() - 60_000,
    });
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("dashboard works without any port callbacks — old 3-arg constructor still works", async () => {
    // Use the import directly with 3 args (no portOpts)
    const tui = makeMockTui();
    const theme = makeMockTheme();
    let closed = false;
    const overlay = new GSDDashboardOverlay(tui, theme, () => { closed = true; });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab to worker, press Enter — should not crash
    overlay.handleInput("\t");
    await waitForRefresh();
    overlay.handleInput("\r");

    // Escape — should close normally
    overlay.handleInput("\x1b");
    assert.equal(closed, true, "Should close normally without port callbacks");
  });

  it("existing parallel dashboard features still work with port callbacks", async () => {
    const onPort = mock.fn(async (_wid: string) => {});
    const { overlay } = createOverlay({ onPort, isPortActive: () => false });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab cycling still works
    overlay.handleInput("\t");
    await waitForRefresh();
    const lines = overlay.render(120);
    assert.ok(lines.join("\n").includes("PID"), "Worker detail should render with port callbacks present");

    // Pause/resume still work
    overlay.handleInput("p");
    assert.equal(mockPauseWorker.mock.calls.length, 1, "pauseWorker should still work");
  });
});

// NOTE: Port indicator widget management (setWidget/removeWidget) is the
// integration code's responsibility, NOT the dashboard's. The dashboard only
// fires onPort/onDetach callbacks. The integration code (parallel-orchestrator
// or auto.ts) calls ctx.ui.setWidget("gsd-port-indicator", ...) after
// portIntoWorker succeeds and ctx.ui.removeWidget() after detachFromWorker.
// This is by design (D056 — dashboard stays decoupled).
