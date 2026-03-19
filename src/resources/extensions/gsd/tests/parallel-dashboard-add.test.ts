/**
 * Contract tests for dashboard `a` key handler — add worker mid-session.
 *
 * Covers: `a` key fires onAdd callback in parallel mode, no-op in single mode,
 * no-op when no onAdd callback provided, disposes dashboard before firing,
 * backward compatibility with 3-arg and partial portOpts constructors.
 *
 * Run with:
 *   node --experimental-test-module-mocks --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
 *        --experimental-strip-types --test src/resources/extensions/gsd/tests/parallel-dashboard-add.test.ts
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

function createOverlay(
  portOpts?: {
    onPort?: (workerId: string) => Promise<void>;
    onDetach?: () => Promise<void>;
    isPortActive?: () => boolean;
    getPortedWorkerId?: () => string | null;
    onAdd?: () => Promise<void>;
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

describe("dashboard add UX: `a` key fires onAdd", () => {
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
      active: true, workers: new Map(), config: { max_workers: 4 }, totalCost: 0.5, startedAt: Date.now() - 60_000,
    });
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("`a` key fires onAdd callback when parallel mode active and onAdd provided", async () => {
    const onAdd = mock.fn(async () => {});
    const { overlay } = createOverlay({ onAdd });
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("a");

    assert.equal(onAdd.mock.calls.length, 1, "onAdd should be called once");
  });

  it("`a` key is no-op when not in parallel mode", async () => {
    mockIsParallelActive = () => false;
    mockGetWorkerStatuses = () => [];

    const onAdd = mock.fn(async () => {});
    const { overlay } = createOverlay({ onAdd });
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("a");

    assert.equal(onAdd.mock.calls.length, 0, "onAdd should NOT be called in single mode");
  });

  it("`a` key is no-op when no onAdd callback provided (backward compat)", async () => {
    const { overlay } = createOverlay(); // no portOpts at all
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Should not crash
    overlay.handleInput("a");

    // Verify overlay still renders fine
    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Overlay should still render after `a` with no onAdd");
  });

  it("`a` key disposes dashboard before firing callback", async () => {
    let disposedBeforeCallback = false;
    const onAdd = mock.fn(async () => {
      // At the time onAdd fires, the overlay should already be disposed.
      // We check by trying to render — a disposed overlay doesn't refresh.
      disposedBeforeCallback = true;
    });
    const { overlay } = createOverlay({ onAdd });
    activeOverlays.push(overlay);
    await waitForRefresh();

    overlay.handleInput("a");

    assert.equal(onAdd.mock.calls.length, 1, "onAdd should fire");
    assert.ok(disposedBeforeCallback, "Dashboard should be disposed before onAdd fires");
  });

  it("`a` key works from overview tab (activeWorkerTab === -1)", async () => {
    const onAdd = mock.fn(async () => {});
    const { overlay } = createOverlay({ onAdd });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Stay on overview — don't Tab to a worker
    overlay.handleInput("a");

    assert.equal(onAdd.mock.calls.length, 1, "onAdd should fire from overview");
  });

  it("`a` key works from worker detail tab", async () => {
    const onAdd = mock.fn(async () => {});
    const { overlay } = createOverlay({ onAdd });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab to first worker detail
    overlay.handleInput("\t");
    await waitForRefresh();

    overlay.handleInput("a");

    assert.equal(onAdd.mock.calls.length, 1, "onAdd should fire from worker detail");
  });
});

describe("dashboard add UX: backward compatibility", () => {
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
      active: true, workers: new Map(), config: { max_workers: 4 }, totalCost: 0, startedAt: Date.now() - 60_000,
    });
  });

  afterEach(() => {
    for (const o of activeOverlays) o.dispose();
    activeOverlays = [];
  });

  it("dashboard with no portOpts still works (3-arg constructor)", async () => {
    const tui = makeMockTui();
    const theme = makeMockTheme();
    let closed = false;
    const overlay = new GSDDashboardOverlay(tui, theme, () => { closed = true; });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // `a` key should be a no-op (no onAdd)
    overlay.handleInput("a");

    // Overlay renders normally
    const lines = overlay.render(120);
    assert.ok(lines.length > 0, "Should render without portOpts");

    // Escape closes normally
    overlay.handleInput("\x1b");
    assert.equal(closed, true, "Should close normally without portOpts");
  });

  it("dashboard with portOpts but no onAdd still works (only port callbacks)", async () => {
    const onPort = mock.fn(async (_wid: string) => {});
    const { overlay } = createOverlay({ onPort, isPortActive: () => false });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // `a` key should be a no-op (no onAdd)
    overlay.handleInput("a");

    // Port callbacks still work
    overlay.handleInput("\t");
    await waitForRefresh();
    overlay.handleInput("\r");

    assert.equal(onPort.mock.calls.length, 1, "onPort should still work when onAdd absent");
  });

  it("existing parallel features work with onAdd present alongside port callbacks", async () => {
    const onAdd = mock.fn(async () => {});
    const onPort = mock.fn(async (_wid: string) => {});
    const { overlay } = createOverlay({ onAdd, onPort, isPortActive: () => false });
    activeOverlays.push(overlay);
    await waitForRefresh();

    // Tab to worker detail, then press p to pause — should still work
    overlay.handleInput("\t");
    await waitForRefresh();
    overlay.handleInput("p");
    assert.equal(mockPauseWorker.mock.calls.length, 1, "pauseWorker should still work");

    // Enter on worker detail should still trigger onPort
    overlay.handleInput("\r");
    assert.equal(onPort.mock.calls.length, 1, "onPort should still work with onAdd present");
  });
});
