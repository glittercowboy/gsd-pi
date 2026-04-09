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
const onboarding = await import("../../web/onboarding-service.ts");
const { AuthStorage } = await import("@gsd/pi-coding-agent");
const bootRoute = await import("../../../web/app/api/boot/route.ts");
const commandRoute = await import("../../../web/app/api/session/command/route.ts");
const eventsRoute = await import("../../../web/app/api/session/events/route.ts");

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

function makeWorkspaceFixture(): { projectCwd: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-bridge-"));
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

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

function writeAutoDashboardModule(root: string, payload: Record<string, unknown>): string {
  const modulePath = join(root, "fake-auto-dashboard.mjs");
  writeFileSync(
    modulePath,
    `export function getAutoDashboardData() { return ${JSON.stringify(payload)}; }\n`,
  );
  return modulePath;
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

function createHarness(onCommand: (command: any, harness: ReturnType<typeof createHarness>) => void) {
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
        onCommand(parsed, harness);
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
    stderr(text: string) {
      if (!child) throw new Error("fake child not started");
      child.stderr.write(text);
    },
    exit(code = 1, signal: NodeJS.Signals | null = null) {
      if (!child) throw new Error("fake child not started");
      child.exitCode = code;
      queueMicrotask(() => {
        child?.emit("exit", code, signal);
      });
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

async function readSseEvents(response: Response, count: number): Promise<any[]> {
  const reader = response.body?.getReader();
  assert.ok(reader, "SSE response has a body reader");
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = "";

  while (events.length < count) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out reading SSE events")), 1_500)),
    ]);

    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      events.push(JSON.parse(dataLine.slice(6)));
      if (events.length >= count) {
        return events;
      }
    }
  }

  await reader.cancel();
  return events;
}

test("/api/boot returns current-project workspace data, resumable sessions, onboarding seam, and bridge snapshot", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-boot", "Resume Me");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-boot",
          sessionFile: sessionPath,
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
      return;
    }

    assert.fail(`unexpected command during boot: ${command.type}`);
  });

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

  const response = await bootRoute.GET();
  assert.equal(response.status, 200);
  const payload = await response.json() as any;

  assert.equal(payload.project.cwd, fixture.projectCwd);
  assert.equal(payload.project.sessionsDir, fixture.sessionsDir);
  assert.equal(payload.workspace.active.milestoneId, "M001");
  assert.equal(payload.workspace.active.sliceId, "S01");
  assert.equal(payload.workspace.active.taskId, "T01");
  assert.equal(payload.onboardingNeeded, false);
  assert.equal(payload.resumableSessions.length, 1);
  assert.equal(payload.resumableSessions[0].id, "sess-boot");
  assert.equal(payload.resumableSessions[0].path, sessionPath);
  assert.equal(payload.resumableSessions[0].isActive, true);
  assert.equal("firstMessage" in payload.resumableSessions[0], false);
  assert.equal("allMessagesText" in payload.resumableSessions[0], false);
  assert.equal("parentSessionPath" in payload.resumableSessions[0], false);
  assert.equal("depth" in payload.resumableSessions[0], false);
  assert.equal(payload.bridge.phase, "ready");
  assert.equal(payload.bridge.activeSessionId, "sess-boot");
  assert.equal(payload.bridge.sessionState.sessionId, "sess-boot");
  assert.equal(payload.bridge.sessionState.autoRetryEnabled, false);
  assert.equal(payload.bridge.sessionState.retryInProgress, false);
  assert.equal(payload.bridge.sessionState.retryAttempt, 0);
  assert.equal(harness.spawnCalls, 1);
});

test("/api/boot uses the authoritative auto helper by default and stays snapshot-shaped", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-auto", "Authoritative Auto");
  const authoritativeAuto = {
    active: true,
    paused: false,
    stepMode: true,
    startTime: 1_111,
    elapsed: 2_222,
    currentUnit: { type: "execute-task", id: "M002/S03/T01", startedAt: 3_333 },
    completedUnits: [{ type: "plan-slice", id: "M002/S03", startedAt: 444, finishedAt: 555 }],
    basePath: fixture.projectCwd,
    totalCost: 12.34,
    totalTokens: 4_242,
  };
  const autoModulePath = writeAutoDashboardModule(fixture.projectCwd, authoritativeAuto);
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-auto",
          sessionFile: sessionPath,
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
      return;
    }

    assert.fail(`unexpected command during authoritative auto boot: ${command.type}`);
  });

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
      GSD_WEB_TEST_AUTO_DASHBOARD_MODULE: autoModulePath,
    },
    spawn: harness.spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getOnboardingNeeded: () => false,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const response = await bootRoute.GET();
  assert.equal(response.status, 200);
  const payload = await response.json() as any;

  assert.deepEqual(
    Object.keys(payload).sort(),
    ["auto", "bridge", "onboarding", "onboardingNeeded", "project", "projectDetection", "resumableSessions", "workspace"],
    "/api/boot must remain snapshot-shaped while auto truth becomes authoritative",
  );
  assert.deepEqual(payload.auto, authoritativeAuto, "default boot path should read authoritative auto dashboard data");
  assert.notEqual(payload.auto.startTime, 0, "authoritative auto helper must replace the all-zero fallback payload");
  assert.equal("recovery" in payload, false, "/api/boot should not grow a recovery diagnostics payload in T01");
  assert.equal("liveState" in payload, false, "/api/boot should not expose live invalidation payloads directly");
});

test("bridge service is a singleton for the project runtime and /api/session/command forwards real RPC responses", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-shared", "Shared Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-shared",
          sessionFile: sessionPath,
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
      return;
    }

    assert.fail(`unexpected command: ${command.type}`);
  });

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

  const serviceA = bridge.getProjectBridgeService();
  const serviceB = bridge.getProjectBridgeService();
  assert.strictEqual(serviceA, serviceB);

  const first = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "get_state" }),
    }),
  );
  const firstBody = await first.json() as any;
  assert.equal(first.status, 200);
  assert.equal(firstBody.success, true);
  assert.equal(firstBody.command, "get_state");
  assert.equal(firstBody.data.sessionId, "sess-shared");

  const second = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "get_state" }),
    }),
  );
  const secondBody = await second.json() as any;
  assert.equal(second.status, 200);
  assert.equal(secondBody.data.sessionId, "sess-shared");
  assert.equal(harness.spawnCalls, 1);
});

test("/api/session/events streams bridge status, agent events, and extension_ui_request payloads over SSE", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-events", "Events Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-events",
          sessionFile: sessionPath,
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
      return;
    }

    assert.fail(`unexpected command: ${command.type}`);
  });

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

  const controller = new AbortController();
  const response = await eventsRoute.GET(
    new Request("http://localhost/api/session/events", { signal: controller.signal }),
  );

  harness.emit({ type: "agent_start" });
  harness.emit({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Need approval",
    message: "Continue?",
  });

  const events = await readSseEvents(response, 3);
  assert.equal(events[0].type, "bridge_status");
  assert.equal(events[0].bridge.connectionCount, 1);
  assert.ok(events.some((event) => event.type === "agent_start"));
  assert.ok(events.some((event) => event.type === "extension_ui_request"));

  assert.equal(bridge.getProjectBridgeService().getSnapshot().connectionCount, 1);
  controller.abort();
  await waitForMicrotasks();
  assert.equal(bridge.getProjectBridgeService().getSnapshot().connectionCount, 0);
});

test("bridge command/runtime failures are inspectable and redact secret material", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-failure", "Failure Session");

  onboarding.configureOnboardingServiceForTests({
    authStorage: AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "sk-test-bridge-failure" },
    } as any),
  });

  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-failure",
          sessionFile: sessionPath,
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
      return;
    }

    if (command.type === "bash") {
      current.emit({
        id: command.id,
        type: "response",
        command: "bash",
        success: false,
        error: "authentication failed for sk-test-command-secret-9999",
      });
      return;
    }

    assert.fail(`unexpected command: ${command.type}`);
  });

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
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  const response = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "bash", command: "echo test" }),
    }),
  );
  const body = await response.json() as any;

  assert.equal(response.status, 502);
  assert.equal(body.success, false);
  assert.match(body.error, /authentication failed/i);
  assert.doesNotMatch(body.error, /sk-test-command-secret-9999/);

  harness.stderr("fatal runtime error: sk-after-attach-12345");
  harness.exit(1);
  await waitForMicrotasks();

  const snapshot = bridge.getProjectBridgeService().getSnapshot();
  assert.equal(snapshot.phase, "failed");
  assert.equal(snapshot.lastError?.afterSessionAttachment, true);
  assert.doesNotMatch(snapshot.lastError?.message ?? "", /sk-after-attach-12345|sk-test-command-secret-9999/);
});

// ---------------------------------------------------------------------------
// Bug — readdirSync must be available in bridge-service for session listing
// (Fixes #1936: /api/boot returns 500 when readdirSync is missing)
// ---------------------------------------------------------------------------

test("/api/boot lists sessions from the real filesystem via readdirSync (#1936)", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-fs", "FS Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-fs",
          sessionFile: sessionPath,
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
      return;
    }
    assert.fail(`unexpected command during boot: ${command.type}`);
  });

  // Deliberately omit listSessions so the real listProjectSessions (which
  // calls readdirSync) is exercised. If readdirSync is missing from the
  // bridge-service node:fs import, this test will throw ReferenceError.
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

  const response = await bootRoute.GET();
  assert.equal(response.status, 200, "/api/boot must not return 500 — readdirSync must be available");
  const payload = await response.json() as any;

  // The real listProjectSessions should have found the session file via readdirSync
  assert.ok(
    Array.isArray(payload.resumableSessions),
    "boot payload must include resumableSessions array",
  );
  assert.equal(
    payload.resumableSessions.length,
    1,
    "readdirSync-based session listing must find the test session file",
  );
  assert.equal(payload.resumableSessions[0].id, "sess-fs");
});
