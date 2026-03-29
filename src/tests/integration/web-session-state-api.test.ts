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
const stateRoute = await import("../../../web/app/api/session/state/route.ts");

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
  const root = mkdtempSync(join(tmpdir(), "gsd-web-state-"));
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

// ---------------------------------------------------------------------------
// Test 1: GET /api/session/state returns correct shape with idle auto-dashboard state
// ---------------------------------------------------------------------------

test("GET /api/session/state returns correct shape with idle auto-dashboard state", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-state-idle", "Idle State Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-state-idle",
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

  const response = await stateRoute.GET(new Request("http://localhost/api/session/state"));
  assert.equal(response.status, 200);
  assert.ok(
    response.headers.get("Cache-Control")?.includes("no-store"),
    "Cache-Control must include no-store",
  );

  const body = await response.json() as any;
  const requiredFields = ["autoActive", "autoPaused", "bridgePhase", "currentUnit", "isCompacting", "isStreaming", "retryInProgress", "sessionId", "updatedAt"];
  assert.ok(
    requiredFields.every((k) => k in body),
    `Body must contain all required fields. Missing: ${requiredFields.filter((k) => !(k in body)).join(", ")}`,
  );

  assert.equal(body.autoActive, false);
  assert.equal(body.autoPaused, false);
  assert.equal(body.currentUnit, null);
  assert.equal(body.bridgePhase, "ready");
  assert.equal(body.sessionId, "sess-state-idle");
  assert.equal(body.isStreaming, false);
  assert.equal(body.isCompacting, false);
  assert.equal(body.retryInProgress, false);
});

// ---------------------------------------------------------------------------
// Test 2: GET /api/session/state returns autoActive:true and currentUnit when auto-mode is running
// ---------------------------------------------------------------------------

test("GET /api/session/state returns autoActive:true and currentUnit when auto-mode is running", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-state-active", "Active State Session");
  const autoModulePath = writeAutoDashboardModule(fixture.projectCwd, {
    active: true,
    paused: false,
    stepMode: false,
    startTime: 1000,
    elapsed: 500,
    currentUnit: { type: "task", id: "T01", startedAt: 9999 },
    completedUnits: [],
    basePath: "",
    totalCost: 0,
    totalTokens: 0,
  });
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-state-active",
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

  const response = await stateRoute.GET(new Request("http://localhost/api/session/state"));
  assert.equal(response.status, 200);

  const body = await response.json() as any;
  assert.equal(body.autoActive, true);
  assert.equal(body.currentUnit?.id, "T01");
  assert.equal(body.currentUnit?.type, "task");
});

// ---------------------------------------------------------------------------
// Test 3 (placeholder): SSE stream emits session_state event on live_state_invalidation
// ---------------------------------------------------------------------------

test("SSE stream emits session_state event on live_state_invalidation", (t) => {
  t.todo("implemented in plan 05-02");
});
