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
const commandRoute = await import("../../../web/app/api/session/command/route.ts");
const manageRoute = await import("../../../web/app/api/session/manage/route.ts");
const eventsRoute = await import("../../../web/app/api/session/events/route.ts");
const liveStateRoute = await import("../../../web/app/api/live-state/route.ts");

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
  const root = mkdtempSync(join(tmpdir(), "gsd-web-live-state-"));
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

function createSessionFile(
  projectCwd: string,
  sessionsDir: string,
  sessionId: string,
  name: string,
  timestamp: string,
): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionPath = join(sessionsDir, `${safeTimestamp}_${sessionId}.jsonl`);
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp,
        cwd: projectCwd,
      }),
      JSON.stringify({
        type: "session_info",
        id: `${sessionId}-info`,
        parentId: null,
        timestamp,
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
    active: true,
    paused: false,
    stepMode: false,
    startTime: 111,
    elapsed: 222,
    currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 333 },
    completedUnits: [],
    basePath: "/tmp/demo",
    totalCost: 4.5,
    totalTokens: 678,
  };
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

function fakeSessionState(sessionId: string, sessionPath: string) {
  return {
    sessionId,
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
  };
}

function fakeBootPayload(sessionPath: string) {
  return {
    project: {
      cwd: "/tmp/demo-project",
      sessionsDir: "/tmp/demo-project/.gsd/sessions",
      packageRoot: repoRoot,
    },
    workspace: fakeWorkspaceIndex(),
    auto: fakeAutoDashboardData(),
    onboarding: {
      status: "ready",
      locked: false,
      lockReason: null,
      required: {
        blocking: true,
        skippable: false,
        satisfied: true,
        satisfiedBy: { providerId: "anthropic", source: "auth_file" },
        providers: [],
      },
      optional: {
        blocking: false,
        skippable: true,
        sections: [],
      },
      lastValidation: null,
      activeFlow: null,
      bridgeAuthRefresh: {
        phase: "idle",
        strategy: null,
        startedAt: null,
        completedAt: null,
        error: null,
      },
    },
    onboardingNeeded: false,
    resumableSessions: [
      {
        id: "sess-live",
        path: sessionPath,
        cwd: "/tmp/demo-project",
        name: "Live Session",
        createdAt: "2026-03-15T03:30:00.000Z",
        modifiedAt: "2026-03-15T03:30:00.000Z",
        messageCount: 2,
        isActive: true,
      },
    ],
    bridge: {
      phase: "ready",
      projectCwd: "/tmp/demo-project",
      projectSessionsDir: "/tmp/demo-project/.gsd/sessions",
      packageRoot: repoRoot,
      startedAt: "2026-03-15T03:30:00.000Z",
      updatedAt: "2026-03-15T03:30:01.000Z",
      connectionCount: 0,
      lastCommandType: "get_state",
      activeSessionId: "sess-live",
      activeSessionFile: sessionPath,
      sessionState: fakeSessionState("sess-live", sessionPath),
      lastError: null,
    },
  };
}

function createHarness(onCommand: (command: any, harness: ReturnType<typeof createHarness>) => void) {
  let child: FakeRpcChild | null = null;
  const commands: any[] = [];

  const harness = {
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
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
    get commands() {
      return commands;
    },
  };

  return harness;
}

function setupBridge(
  harness: ReturnType<typeof createHarness>,
  fixture: { projectCwd: string; sessionsDir: string },
  overrides: Record<string, unknown> = {},
): void {
  onboarding.configureOnboardingServiceForTests({
    authStorage: AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "sk-test-live-state" },
    } as any),
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
    ...overrides,
  });
}

async function readSseEventsUntil(
  response: Response,
  predicate: (events: any[]) => boolean,
  timeoutMs = 2_000,
): Promise<any[]> {
  const reader = response.body?.getReader();
  assert.ok(reader, "SSE response has a body reader");
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out reading SSE events")), remaining)),
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
      if (predicate(events)) {
        await reader.cancel();
        return events;
      }
    }
  }

  await reader.cancel();
  throw new Error("Timed out waiting for the expected SSE contract events");
}

test("/api/session/events exposes explicit live_state_invalidation events for agent and auto recovery boundaries", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(
    fixture.projectCwd,
    fixture.sessionsDir,
    "sess-live",
    "Live Session",
    "2026-03-15T03:30:00.000Z",
  );
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-live", sessionPath),
      });
      return;
    }

    assert.fail(`unexpected command: ${command.type}`);
  });

  setupBridge(harness, fixture);

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  const controller = new AbortController();
  const response = await eventsRoute.GET(
    new Request("http://localhost/api/session/events", { signal: controller.signal }),
  );

  harness.emit({ type: "agent_end" });
  harness.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 250, errorMessage: "retry me" });
  harness.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "still failing" });
  harness.emit({ type: "auto_compaction_start", reason: "threshold" });
  harness.emit({ type: "auto_compaction_end", result: undefined, aborted: false, willRetry: false });
  harness.emit({ type: "turn_end" });

  const events = await readSseEventsUntil(
    response,
    (seen) => seen.filter((event) => event.type === "live_state_invalidation").length >= 6,
  );
  const invalidations = events.filter((event) => event.type === "live_state_invalidation");

  assert.deepEqual(
    invalidations.map((event) => ({
      reason: event.reason,
      source: event.source,
      workspaceIndexCacheInvalidated: event.workspaceIndexCacheInvalidated,
    })),
    [
      { reason: "agent_end", source: "bridge_event", workspaceIndexCacheInvalidated: true },
      { reason: "auto_retry_start", source: "bridge_event", workspaceIndexCacheInvalidated: false },
      { reason: "auto_retry_end", source: "bridge_event", workspaceIndexCacheInvalidated: false },
      { reason: "auto_compaction_start", source: "bridge_event", workspaceIndexCacheInvalidated: false },
      { reason: "auto_compaction_end", source: "bridge_event", workspaceIndexCacheInvalidated: false },
      { reason: "turn_end", source: "bridge_event", workspaceIndexCacheInvalidated: true },
    ],
    "live_state_invalidation reasons/sources should stay inspectable on /api/session/events",
  );
  assert.deepEqual(invalidations[0].domains, ["auto", "workspace", "recovery"]);
  assert.deepEqual(invalidations[1].domains, ["auto", "recovery"]);
  assert.deepEqual(invalidations[2].domains, ["auto", "recovery"]);
  assert.deepEqual(invalidations[3].domains, ["auto", "recovery"]);
  assert.deepEqual(invalidations[4].domains, ["auto", "recovery"]);
  assert.deepEqual(invalidations[5].domains, ["workspace"]);

  controller.abort();
  await waitForMicrotasks();
});

test("workspace cache only busts on real boundaries and session mutations emit targeted invalidations", async (t) => {
  const fixture = makeWorkspaceFixture();
  const activeSessionPath = createSessionFile(
    fixture.projectCwd,
    fixture.sessionsDir,
    "sess-active",
    "Active Session",
    "2026-03-15T03:31:00.000Z",
  );
  const otherSessionPath = createSessionFile(
    fixture.projectCwd,
    fixture.sessionsDir,
    "sess-other",
    "Other Session",
    "2026-03-15T03:31:01.000Z",
  );
  let workspaceIndexCalls = 0;

  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-active", activeSessionPath),
      });
      return;
    }

    if (command.type === "switch_session") {
      current.emit({ id: command.id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
      return;
    }

    if (command.type === "new_session") {
      current.emit({ id: command.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
      return;
    }

    if (command.type === "fork") {
      current.emit({ id: command.id, type: "response", command: "fork", success: true, data: { text: "Fork me", cancelled: false } });
      return;
    }

    if (command.type === "set_session_name") {
      current.emit({ id: command.id, type: "response", command: "set_session_name", success: true });
      return;
    }

    assert.fail(`unexpected command: ${command.type}`);
  });

  setupBridge(harness, fixture, {
    indexWorkspace: async () => {
      workspaceIndexCalls += 1;
      return fakeWorkspaceIndex();
    },
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  const service = bridge.getProjectBridgeService();
  await service.ensureStarted();
  const seenEvents: any[] = [];
  const unsubscribe = service.subscribe((event) => {
    seenEvents.push(event);
  });

  await bridge.collectBootPayload();
  await bridge.collectBootPayload();
  assert.equal(workspaceIndexCalls, 1, "boot snapshot should stay cached before any invalidation boundary fires");

  harness.emit({ type: "agent_end" });
  await waitForMicrotasks();
  await bridge.collectBootPayload();
  assert.equal(workspaceIndexCalls, 2, "agent_end should invalidate the cached workspace snapshot");

  harness.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "retry me" });
  await waitForMicrotasks();
  await bridge.collectBootPayload();
  assert.equal(workspaceIndexCalls, 2, "auto_retry_start should not invalidate the workspace snapshot cache");

  harness.emit({ type: "auto_compaction_start", reason: "threshold" });
  await waitForMicrotasks();
  await bridge.collectBootPayload();
  assert.equal(workspaceIndexCalls, 2, "auto_compaction_start should not invalidate the workspace snapshot cache");

  const switchResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "switch_session", sessionPath: otherSessionPath }),
    }),
  );
  assert.equal(switchResponse.status, 200);

  const newSessionResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "new_session" }),
    }),
  );
  assert.equal(newSessionResponse.status, 200);

  const forkResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "fork", entryId: "entry-1" }),
    }),
  );
  assert.equal(forkResponse.status, 200);

  const renameResponse = await manageRoute.POST(
    new Request("http://localhost/api/session/manage", {
      method: "POST",
      body: JSON.stringify({
        action: "rename",
        sessionPath: otherSessionPath,
        name: "Renamed Session",
      }),
    }),
  );
  const renamePayload = await renameResponse.json() as any;
  assert.equal(renameResponse.status, 200);
  assert.equal(renamePayload.success, true);
  assert.equal(renamePayload.mutation, "session_file");

  await waitForMicrotasks();

  const invalidations = seenEvents.filter((event) => event.type === "live_state_invalidation");
  const reasons = invalidations.map((event) => event.reason);
  assert.ok(reasons.includes("agent_end"), "missing agent_end live_state_invalidation trigger");
  assert.ok(reasons.includes("auto_retry_start"), "missing auto_retry_start live_state_invalidation trigger");
  assert.ok(reasons.includes("auto_compaction_start"), "missing auto_compaction_start live_state_invalidation trigger");
  assert.ok(reasons.includes("switch_session"), "missing switch_session live_state_invalidation trigger");
  assert.ok(reasons.includes("new_session"), "missing new_session live_state_invalidation trigger");
  assert.ok(reasons.includes("fork"), "missing fork live_state_invalidation trigger");

  const switchInvalidation = invalidations.find((event) => event.reason === "switch_session");
  assert.ok(switchInvalidation, "switch_session should emit a targeted freshness event");
  assert.deepEqual(switchInvalidation.domains, ["resumable_sessions", "recovery"]);
  assert.equal(switchInvalidation.workspaceIndexCacheInvalidated, false);

  const renameInvalidation = invalidations.find(
    (event) => event.reason === "set_session_name" && event.source === "session_manage",
  );
  assert.ok(renameInvalidation, "inactive rename should emit an inspectable set_session_name invalidation");
  assert.deepEqual(renameInvalidation.domains, ["resumable_sessions"]);
  assert.equal(renameInvalidation.workspaceIndexCacheInvalidated, false);

  unsubscribe();
});

test("turn_end events invalidate workspace so milestones list reflects current state (issue #2706)", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(
    fixture.projectCwd,
    fixture.sessionsDir,
    "sess-turn",
    "Turn Session",
    "2026-03-15T03:32:00.000Z",
  );
  let workspaceIndexCalls = 0;

  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-turn", sessionPath),
      });
      return;
    }

    assert.fail(`unexpected command: ${command.type}`);
  });

  setupBridge(harness, fixture, {
    indexWorkspace: async () => {
      workspaceIndexCalls += 1;
      return fakeWorkspaceIndex();
    },
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  const service = bridge.getProjectBridgeService();
  await service.ensureStarted();
  const seenEvents: any[] = [];
  const unsubscribe = service.subscribe((event) => {
    seenEvents.push(event);
  });

  // Load workspace once to prime cache
  await bridge.collectBootPayload();
  assert.equal(workspaceIndexCalls, 1, "initial boot should call indexWorkspace once");

  // Emit turn_end — this should invalidate the workspace cache so the
  // milestones list picks up state changes that occurred during the turn.
  harness.emit({ type: "turn_end" });
  await waitForMicrotasks();

  // Verify a live_state_invalidation was emitted for turn_end
  const invalidations = seenEvents.filter((event) => event.type === "live_state_invalidation");
  const turnEndInvalidation = invalidations.find((event) => event.reason === "turn_end");
  assert.ok(turnEndInvalidation, "turn_end should emit a live_state_invalidation event");
  assert.ok(
    turnEndInvalidation.domains.includes("workspace"),
    "turn_end invalidation should include the workspace domain",
  );
  assert.equal(
    turnEndInvalidation.workspaceIndexCacheInvalidated,
    true,
    "turn_end should invalidate the workspace index cache",
  );

  // Verify workspace cache was actually busted
  await bridge.collectBootPayload();
  assert.equal(workspaceIndexCalls, 2, "turn_end should bust the workspace index cache so the next fetch re-indexes");

  unsubscribe();
});
