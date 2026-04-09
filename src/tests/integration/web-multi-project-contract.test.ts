import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const repoRoot = process.cwd();
const bridge = await import("../../web/bridge-service.ts");

// ---------------------------------------------------------------------------
// Helpers (same shape as web-bridge-contract.test.ts)
// ---------------------------------------------------------------------------

class FakeRpcChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode === null) {
      this.exitCode = 0;
    }
    queueMicrotask(() => {
      this.emit("exit", this.exitCode, signal);
    });
    return true;
  }
}

function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function attachJsonLineReader(stream: PassThrough, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });
}

function makeWorkspaceFixture(label: string): { projectCwd: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `gsd-multi-project-${label}-`));
  const projectCwd = join(root, "project");
  const sessionsDir = join(root, "sessions");
  const milestoneDir = join(projectCwd, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    `# M001: Demo Milestone\n\n## Slices\n- [ ] **S01: Demo Slice** \`risk:low\` \`depends:[]\`\n  > After this: demo works\n`,
  );
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    `# S01: Demo Slice\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Must-Haves\n- real bridge\n\n## Tasks\n- [ ] **T01: Wire boot** \`est:10m\`\n  Do the work.\n`,
  );
  writeFileSync(
    join(tasksDir, "T01-PLAN.md"),
    `# T01: Wire boot\n\n## Steps\n- do it\n`,
  );

  return {
    projectCwd,
    sessionsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createSessionFile(projectCwd: string, sessionsDir: string, sessionId: string, name: string): string {
  const sessionPath = join(sessionsDir, `2026-03-14T18-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-03-14T18:00:00.000Z",
        cwd: projectCwd,
      }),
      JSON.stringify({
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-14T18:00:01.000Z",
        name,
      }),
    ].join("\n") + "\n",
  );
  return sessionPath;
}

function fakeWorkspaceIndex() {
  return {
    milestones: [
      {
        id: "M001",
        title: "Demo Milestone",
        roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
        slices: [
          {
            id: "S01",
            title: "Demo Slice",
            done: false,
            planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
            tasksDir: ".gsd/milestones/M001/slices/S01/tasks",
            tasks: [
              {
                id: "T01",
                title: "Wire boot",
                done: false,
                planPath: ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md",
              },
            ],
          },
        ],
      },
    ],
    active: {
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      phase: "executing",
    },
    scopes: [
      { scope: "project", label: "project", kind: "project" },
      { scope: "M001", label: "M001: Demo Milestone", kind: "milestone" },
      { scope: "M001/S01", label: "M001/S01: Demo Slice", kind: "slice" },
      { scope: "M001/S01/T01", label: "M001/S01/T01: Wire boot", kind: "task" },
    ],
    validationIssues: [],
  };
}

function fakeAutoDashboardData() {
  return {
    active: false,
    paused: false,
    stepMode: false,
    startTime: 0,
    elapsed: 0,
    currentUnit: null,
    completedUnits: [],
    basePath: "",
    totalCost: 0,
    totalTokens: 0,
  };
}

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(sessionId: string) {
  let spawnCalls = 0;
  let child: FakeRpcChild | null = null;
  const commands: any[] = [];

  const harness = {
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      spawnCalls += 1;
      child = new FakeRpcChild();
      attachJsonLineReader(child.stdin, (line) => {
        const parsed = JSON.parse(line);
        commands.push(parsed);
        if (parsed.type === "get_state") {
          harness.emit({
            id: parsed.id,
            type: "response",
            command: "get_state",
            success: true,
            data: {
              sessionId,
              sessionFile: `/tmp/fake-session-${sessionId}.jsonl`,
              thinkingLevel: "off",
              isStreaming: false,
              isCompacting: false,
              steeringMode: "all",
              followUpMode: "all",
              autoCompactionEnabled: false,
              autoRetryEnabled: false,
              retryInProgress: false,
              retryAttempt: 0,
              messageCount: 0,
              pendingMessageCount: 0,
            },
          });
        }
      });
      void command;
      void args;
      void options;
      return child as any;
    },
    emit(payload: unknown) {
      if (!child) throw new Error("fake child not started");
      child.stdout.write(serializeJsonLine(payload));
    },
    get spawnCalls() {
      return spawnCalls;
    },
    get commands() {
      return commands;
    },
    get child() {
      return child;
    },
  };

  return harness;
}

// ---------------------------------------------------------------------------
// Tests — multi-project bridge coexistence
// ---------------------------------------------------------------------------

test("multi-project: getProjectBridgeServiceForCwd returns distinct instances for different project paths", async (t) => {
  const fixtureA = makeWorkspaceFixture("A");
  const fixtureB = makeWorkspaceFixture("B");

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixtureA.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixtureA.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: createHarness("unused").spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixtureA.cleanup();
    fixtureB.cleanup();
  });

  const bridgeA = bridge.getProjectBridgeServiceForCwd(fixtureA.projectCwd);
  const bridgeB = bridge.getProjectBridgeServiceForCwd(fixtureB.projectCwd);
  assert.notStrictEqual(bridgeA, bridgeB, "bridges for different paths must be distinct instances");

  const snapA = bridgeA.getSnapshot();
  const snapB = bridgeB.getSnapshot();
  assert.equal(snapA.projectCwd, fixtureA.projectCwd);
  assert.equal(snapB.projectCwd, fixtureB.projectCwd);
});

test("multi-project: getProjectBridgeServiceForCwd returns same instance for same path", async (t) => {
  const fixtureA = makeWorkspaceFixture("idempotent");

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixtureA.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixtureA.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: createHarness("unused").spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixtureA.cleanup();
  });

  const first = bridge.getProjectBridgeServiceForCwd(fixtureA.projectCwd);
  const second = bridge.getProjectBridgeServiceForCwd(fixtureA.projectCwd);
  assert.strictEqual(first, second, "same path must return the same instance");
});

test("multi-project: each bridge receives commands independently", async (t) => {
  const fixtureA = makeWorkspaceFixture("cmd-A");
  const fixtureB = makeWorkspaceFixture("cmd-B");
  const sessionPathA = createSessionFile(fixtureA.projectCwd, fixtureA.sessionsDir, "sess-A", "Session A");
  const sessionPathB = createSessionFile(fixtureB.projectCwd, fixtureB.sessionsDir, "sess-B", "Session B");

  const harnessA = createHarness("sess-A");
  const harnessB = createHarness("sess-B");

  // Track which harness was used for which project path
  const spawnRouter = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    const cwd = (options as any).cwd as string;
    if (cwd === fixtureA.projectCwd) return harnessA.spawn(command, args, options);
    if (cwd === fixtureB.projectCwd) return harnessB.spawn(command, args, options);
    // Fallback — use A for the default env-based project
    return harnessA.spawn(command, args, options);
  };

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixtureA.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixtureA.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: spawnRouter as any,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixtureA.cleanup();
    fixtureB.cleanup();
  });

  const bridgeA = bridge.getProjectBridgeServiceForCwd(fixtureA.projectCwd);
  const bridgeB = bridge.getProjectBridgeServiceForCwd(fixtureB.projectCwd);

  // Start both bridges
  await bridgeA.ensureStarted();
  await bridgeB.ensureStarted();

  // Send get_state to bridge A
  const responseA = await bridgeA.sendInput({ type: "get_state" } as any);
  assert.equal(responseA?.success, true);
  assert.equal((responseA as any).data.sessionId, "sess-A");

  // Send get_state to bridge B
  const responseB = await bridgeB.sendInput({ type: "get_state" } as any);
  assert.equal(responseB?.success, true);
  assert.equal((responseB as any).data.sessionId, "sess-B");

  // Each harness only got its own commands
  assert.ok(harnessA.commands.length >= 1, "harness A received commands");
  assert.ok(harnessB.commands.length >= 1, "harness B received commands");
  assert.ok(
    harnessA.commands.every((c: any) => c.type === "get_state"),
    "harness A only got get_state commands",
  );
  assert.ok(
    harnessB.commands.every((c: any) => c.type === "get_state"),
    "harness B only got get_state commands",
  );
});

test("multi-project: SSE subscribers are isolated per bridge", async (t) => {
  const fixtureA = makeWorkspaceFixture("sse-A");
  const fixtureB = makeWorkspaceFixture("sse-B");

  const harnessA = createHarness("sess-sse-A");

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixtureA.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixtureA.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: harnessA.spawn as any,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixtureA.cleanup();
    fixtureB.cleanup();
  });

  const bridgeA = bridge.getProjectBridgeServiceForCwd(fixtureA.projectCwd);
  const bridgeB = bridge.getProjectBridgeServiceForCwd(fixtureB.projectCwd);

  const eventsA: any[] = [];
  const eventsB: any[] = [];

  const unsubA = bridgeA.subscribe((event) => eventsA.push(event));
  const unsubB = bridgeB.subscribe((event) => eventsB.push(event));

  // Subscribe fires an initial bridge_status event for each
  const initialA = eventsA.length;
  const initialB = eventsB.length;

  // Start bridge A so it has a child process
  await bridgeA.ensureStarted();
  await waitForMicrotasks();

  // Filter to only non-bridge_status events that we emit manually
  const agentEventsA: any[] = [];
  const agentEventsB: any[] = [];

  const unsubA2 = bridgeA.subscribe((event) => {
    if (event.type !== "bridge_status") agentEventsA.push(event);
  });
  const unsubB2 = bridgeB.subscribe((event) => {
    if (event.type !== "bridge_status") agentEventsB.push(event);
  });

  // Emit an agent event on bridge A's child process
  harnessA.emit({ type: "agent_start" });
  await waitForMicrotasks();

  // Bridge A's subscriber should see it; bridge B's should not
  assert.ok(agentEventsA.length > 0, "bridge A subscriber should see agent_start");
  assert.equal(agentEventsB.length, 0, "bridge B subscriber should NOT see events from bridge A");

  unsubA();
  unsubB();
  unsubA2();
  unsubB2();
});

test("multi-project: resolveProjectCwd reads ?project= from request URL", () => {
  const result = bridge.resolveProjectCwd(
    new Request("http://localhost/api/boot?project=%2Ftmp%2Fmy-project"),
  );
  assert.equal(result, "/tmp/my-project");
});

test("multi-project: resolveProjectCwd falls back to GSD_WEB_PROJECT_CWD when no ?project= present", (t) => {
  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: "/fallback/path",
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: createHarness("unused").spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  t.after(() => { bridge.configureBridgeServiceForTests(null); });

  const result = bridge.resolveProjectCwd(
    new Request("http://localhost/api/boot"),
  );
  assert.equal(result, "/fallback/path");
});

test("multi-project: getProjectBridgeService backward compat shim works", async (t) => {
  const fixture = makeWorkspaceFixture("compat");
  const harness = createHarness("sess-compat");

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: harness.spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const service = bridge.getProjectBridgeService();
  assert.ok(service, "getProjectBridgeService() should return a BridgeService");
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.projectCwd, fixture.projectCwd, "backward compat shim should use env-resolved projectCwd");
  assert.equal(snapshot.phase, "idle");

  // Same instance as getProjectBridgeServiceForCwd with the same path
  const directService = bridge.getProjectBridgeServiceForCwd(fixture.projectCwd);
  assert.strictEqual(service, directService, "backward compat shim should return same instance as direct lookup");
});

test("multi-project: resetBridgeServiceForTests clears all registry entries", async (t) => {
  const fixtureA = makeWorkspaceFixture("reset-A");
  const fixtureB = makeWorkspaceFixture("reset-B");

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixtureA.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixtureA.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: createHarness("unused").spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixtureA.cleanup();
    fixtureB.cleanup();
  });

  // Create two bridge instances
  const beforeA = bridge.getProjectBridgeServiceForCwd(fixtureA.projectCwd);
  const beforeB = bridge.getProjectBridgeServiceForCwd(fixtureB.projectCwd);
  assert.notStrictEqual(beforeA, beforeB);

  // Reset clears the registry
  await bridge.resetBridgeServiceForTests();

  // Re-configure after reset (reset clears overrides too)
  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixtureA.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixtureA.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: createHarness("unused").spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  // Should get new instances
  const afterA = bridge.getProjectBridgeServiceForCwd(fixtureA.projectCwd);
  const afterB = bridge.getProjectBridgeServiceForCwd(fixtureB.projectCwd);
  assert.notStrictEqual(afterA, beforeA, "reset must create fresh instances for path A");
  assert.notStrictEqual(afterB, beforeB, "reset must create fresh instances for path B");
  assert.notStrictEqual(afterA, afterB, "new instances should still be distinct");
});
