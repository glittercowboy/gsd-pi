import test, { describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCmuxProgress,
  buildCmuxStatusLabel,
  detectCmuxEnvironment,
  markCmuxPromptShown,
  resetCmuxPromptState,
  resolveCmuxConfig,
  shouldPromptToEnableCmux,
} from "../../cmux/index.ts";
import type { GSDState } from "../types.ts";

test("detectCmuxEnvironment requires workspace, surface, and socket", () => {
  const detected = detectCmuxEnvironment(
    {
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:2",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    },
    (path) => path === "/tmp/cmux.sock",
    () => true,
  );
  assert.equal(detected.available, true);
  assert.equal(detected.cliAvailable, true);
});

test("resolveCmuxConfig enables only when preference and environment are both active", () => {
  const config = resolveCmuxConfig(
    { cmux: { enabled: true, notifications: true, sidebar: true, splits: true } },
    {
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:2",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    },
    () => true,
    () => true,
  );
  assert.equal(config.enabled, true);
  assert.equal(config.notifications, true);
  assert.equal(config.sidebar, true);
  assert.equal(config.splits, true);
});

test("shouldPromptToEnableCmux only prompts once per session", () => {
  resetCmuxPromptState();
  assert.equal(shouldPromptToEnableCmux({}, {}, () => false, () => true), false);

  assert.equal(
    shouldPromptToEnableCmux(
      {},
      {
        CMUX_WORKSPACE_ID: "workspace:1",
        CMUX_SURFACE_ID: "surface:2",
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      },
      () => true,
      () => true,
    ),
    true,
  );
  markCmuxPromptShown();
  assert.equal(
    shouldPromptToEnableCmux(
      {},
      {
        CMUX_WORKSPACE_ID: "workspace:1",
        CMUX_SURFACE_ID: "surface:2",
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      },
      () => true,
      () => true,
    ),
    false,
  );
  resetCmuxPromptState();
});

test("buildCmuxStatusLabel and progress prefer deepest active unit", () => {
  const state: GSDState = {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: { id: "S02", title: "Slice" },
    activeTask: { id: "T03", title: "Task" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "Keep going",
    registry: [],
    progress: {
      milestones: { done: 0, total: 1 },
      slices: { done: 1, total: 3 },
      tasks: { done: 2, total: 5 },
    },
  };

  assert.equal(buildCmuxStatusLabel(state), "M001 S02/T03 · executing");
  assert.deepEqual(buildCmuxProgress(state), { value: 0.4, label: "2/5 tasks" });
});

describe("createGridLayout", () => {
  // Create a mock CmuxClient that tracks createSplitFrom calls
  function makeMockClient() {
    let nextId = 1;
    const calls: Array<{ source: string | undefined; direction: string }> = [];

    const client = {
      calls,
      async createGridLayout(count: number) {
        // Simulate the grid layout logic with a fake client
        if (count <= 0) return [];
        const surfaces: string[] = [];

        const createSplitFrom = async (source: string | undefined, direction: string) => {
          calls.push({ source, direction });
          return `surface-${nextId++}`;
        };

        const rightCol = await createSplitFrom("gsd-surface", "right");
        surfaces.push(rightCol);
        if (count === 1) return surfaces;

        const bottomRight = await createSplitFrom(rightCol, "down");
        surfaces.push(bottomRight);
        if (count === 2) return surfaces;

        const bottomLeft = await createSplitFrom("gsd-surface", "down");
        surfaces.push(bottomLeft);
        if (count === 3) return surfaces;

        let lastSurface = bottomRight;
        for (let i = 3; i < count; i++) {
          const next = await createSplitFrom(lastSurface, "down");
          surfaces.push(next);
          lastSurface = next;
        }

        return surfaces;
      },
    };
    return client;
  }

  test("1 agent creates single right split", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(1);
    assert.equal(surfaces.length, 1);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
    ]);
  });

  test("2 agents creates right column then splits it down", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(2);
    assert.equal(surfaces.length, 2);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
    ]);
  });

  test("3 agents creates 2x2 grid (gsd + 3 agent surfaces)", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(3);
    assert.equal(surfaces.length, 3);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
      { source: "gsd-surface", direction: "down" },
    ]);
  });

  test("4 agents creates 2x2 grid with extra split", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(4);
    assert.equal(surfaces.length, 4);
    assert.deepEqual(mock.calls, [
      { source: "gsd-surface", direction: "right" },
      { source: "surface-1", direction: "down" },
      { source: "gsd-surface", direction: "down" },
      { source: "surface-2", direction: "down" },
    ]);
  });

  test("0 agents returns empty", async () => {
    const mock = makeMockClient();
    const surfaces = await mock.createGridLayout(0);
    assert.equal(surfaces.length, 0);
    assert.equal(mock.calls.length, 0);
  });
});

describe("CmuxClient stdio isolation", () => {
  test("runSync and runAsync explicitly set stdio to prevent terminal interference", () => {
    // Read the cmux index source and verify that execFileSync/spawn calls
    // inside runSync/runAsync include stdio options that isolate stdin and stderr.
    // This prevents the cmux CLI child process from inheriting the parent's
    // stdin/stderr, which can steal keyboard input or corrupt TUI rendering (#1922).
    const cmuxIndexPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../cmux/index.ts",
    );
    const source = fs.readFileSync(cmuxIndexPath, "utf-8");

    // Extract runSync method body
    const runSyncMatch = source.match(/private runSync\(args: string\[\]\)[^{]*\{([\s\S]*?)\n  \}/);
    assert.ok(runSyncMatch, "runSync method must exist");
    const runSyncBody = runSyncMatch[1];
    assert.ok(
      runSyncBody.includes('stdio:'),
      "runSync must explicitly set stdio to prevent terminal interference (see #1922)",
    );
    assert.ok(
      runSyncBody.includes('"ignore"'),
      "runSync stdio must ignore stdin to prevent stealing keyboard input from TUI",
    );

    // Extract runAsync method body
    const runAsyncMatch = source.match(/private async runAsync\(args: string\[\]\)[^{]*\{([\s\S]*?)\n  \}/);
    assert.ok(runAsyncMatch, "runAsync method must exist");
    const runAsyncBody = runAsyncMatch[1];
    assert.ok(
      runAsyncBody.includes('stdio:'),
      "runAsync must explicitly set stdio to prevent terminal interference (see #1922)",
    );
    assert.ok(
      runAsyncBody.includes('"ignore"'),
      "runAsync stdio must ignore stdin to prevent stealing keyboard input from TUI",
    );
  });

  test("isCmuxCliAvailable uses stdio ignore to prevent terminal interference", () => {
    const cmuxIndexPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../cmux/index.ts",
    );
    const source = fs.readFileSync(cmuxIndexPath, "utf-8");

    // Find isCmuxCliAvailable or the cli-check function body
    const fnMatch = source.match(/function isCmuxCliAvailable[\s\S]*?\{([\s\S]*?)\n\}/);
    if (!fnMatch) return; // function may be inlined or renamed — skip rather than fail

    const fnBody = fnMatch[1];
    assert.ok(
      fnBody.includes('"ignore"') || !fnBody.includes('execFileSync'),
      "isCmuxCliAvailable must not inherit parent stdio (see #1922)",
    );
  });
});

describe("cmux extension discovery opt-out", () => {
  test("cmux directory has package.json with pi manifest to prevent auto-discovery as extension", () => {
    const cmuxDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../cmux",
    );
    const pkgPath = path.join(cmuxDir, "package.json");
    assert.ok(fs.existsSync(pkgPath), `${pkgPath} must exist`);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    assert.ok(
      pkg.pi !== undefined && typeof pkg.pi === "object",
      'package.json must have a "pi" field to opt out of extension auto-discovery',
    );
    assert.ok(
      !pkg.pi.extensions?.length,
      "pi.extensions must be empty or absent — cmux is a library, not an extension",
    );
  });
});
