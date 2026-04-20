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
const bootRoute = await import("../../../web/app/api/boot/route.ts");
const onboardingRoute = await import("../../../web/app/api/onboarding/route.ts");
const recoveryRoute = await import("../../../web/app/api/recovery/route.ts");
const commandRoute = await import("../../../web/app/api/session/command/route.ts");
const eventsRoute = await import("../../../web/app/api/session/events/route.ts");
const {
  dispatchBrowserSlashCommand,
  getBrowserSlashCommandTerminalNotice,
} = await import("../../../web/lib/browser-slash-command-dispatch.ts");
const { AuthStorage } = await import("@gsd/pi-coding-agent");

// ---------------------------------------------------------------------------
// Test infrastructure (shared with web-mode-onboarding.test.ts)
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

function makeWorkspaceFixture(): { projectCwd: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-assembled-"));
  const projectCwd = join(root, "project");
  const sessionsDir = join(root, "sessions");
  const milestoneDir = join(projectCwd, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    `# M001: Demo\n\n## Slices\n- [ ] **S01: Demo** \`risk:low\` \`depends:[]\`\n`,
  );
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    `# S01: Demo\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [ ] **T01: Work** \`est:5m\`\n`,
  );
  writeFileSync(join(tasksDir, "T01-PLAN.md"), `# T01: Work\n\n## Steps\n- do it\n`);

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

function fakeWorkspaceIndex() {
  return {
    milestones: [
      {
        id: "M001",
        title: "Demo",
        roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
        slices: [
          {
            id: "S01",
            title: "Demo",
            done: false,
            planPath: ".gsd/milestones/M001/slices/S01/S01-PLAN.md",
            tasksDir: ".gsd/milestones/M001/slices/S01/tasks",
            tasks: [{ id: "T01", title: "Work", done: false, planPath: ".gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md" }],
          },
        ],
      },
    ],
    active: { milestoneId: "M001", sliceId: "S01", taskId: "T01", phase: "executing" },
    scopes: [{ scope: "project", label: "project", kind: "project" }],
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

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Read SSE events from a Response stream, collecting up to `count` events.
 * Returns early (without throwing) if no new data arrives within `perReadTimeoutMs`.
 * This allows tests to request a generous count without failing on exact event counts.
 */
async function readSseEvents(response: Response, count: number, perReadTimeoutMs = 3_000): Promise<any[]> {
  const reader = response.body?.getReader();
  assert.ok(reader, "SSE response has a body reader");
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = "";

  while (events.length < count) {
    let timedOut = false;
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve({ done: true, value: undefined });
        }, perReadTimeoutMs);
      }),
    ]);

    if (timedOut || result.done) break;
    buffer += decoder.decode(result.value as Uint8Array, { stream: true });

    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      events.push(JSON.parse(dataLine.slice(6)));
    }
  }

  await reader.cancel();
  return events;
}

// ---------------------------------------------------------------------------
// Assembled lifecycle test
// ---------------------------------------------------------------------------

test("assembled lifecycle: boot → onboard → prompt → streaming text → tool execution → blocking UI request → UI response → turn boundary", async (t) => {
  const fixture = makeWorkspaceFixture();
  const authStorage = AuthStorage.inMemory({});
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-assembled", "Assembled Lifecycle Session");

  // Track state across spawn generations
  let spawnCount = 0;
  let receivedUiResponse: any = null;

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      void command;
      void args;
      void options;
      spawnCount += 1;
      const child = new FakeRpcChild();

      attachJsonLineReader(child.stdin, (line) => {
        const message = JSON.parse(line) as any;

        switch (message.type) {
          case "get_state": {
            child.stdout.write(
              serializeJsonLine({
                id: message.id,
                type: "response",
                command: "get_state",
                success: true,
                data: fakeSessionState("sess-assembled", sessionPath),
              }),
            );
            return;
          }

          case "prompt": {
            // Respond with success immediately
            child.stdout.write(
              serializeJsonLine({
                id: message.id,
                type: "response",
                command: "prompt",
                success: true,
              }),
            );

            // Then emit the streaming event sequence after a tick
            setTimeout(() => {
              // 1. Streaming text delta
              child.stdout.write(
                serializeJsonLine({
                  type: "message_update",
                  assistantMessageEvent: {
                    type: "text_delta",
                    delta: "Deploying to production...",
                    contentIndex: 0,
                  },
                }),
              );

              // 2. Tool execution start
              child.stdout.write(
                serializeJsonLine({
                  type: "tool_execution_start",
                  toolCallId: "tc-deploy-1",
                  toolName: "bash",
                  args: { command: "deploy --prod" },
                }),
              );

              // 3. Tool execution end
              child.stdout.write(
                serializeJsonLine({
                  type: "tool_execution_end",
                  toolCallId: "tc-deploy-1",
                  toolName: "bash",
                  result: { exitCode: 0 },
                  isError: false,
                }),
              );

              // 4. Blocking UI request — waits for user confirmation
              child.stdout.write(
                serializeJsonLine({
                  type: "extension_ui_request",
                  id: "ui-confirm-deploy",
                  method: "confirm",
                  title: "Confirm deployment",
                  message: "Proceed with deploying to production?",
                }),
              );
              // agent_end/turn_end are withheld until the UI response arrives
            }, 10);
            return;
          }

          case "extension_ui_response": {
            // Record the round-trip proof
            receivedUiResponse = message;

            // Now emit turn boundary events
            setTimeout(() => {
              child.stdout.write(serializeJsonLine({ type: "agent_end" }));
              child.stdout.write(serializeJsonLine({ type: "turn_end" }));
            }, 10);
            return;
          }

          default:
            // Ignore unexpected commands (e.g. abort, steer)
            return;
        }
      });

      return child as any;
    },
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
  });

  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: () => undefined,
    validateApiKey: async () => ({ ok: true, message: "openai credentials validated" }),
    isExternalCliProvider: () => false,
  });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  // -----------------------------------------------------------------------
  // Stage 1: Boot — verify bridge ready, onboarding locked
  // -----------------------------------------------------------------------
  const bootResponse = await bootRoute.GET();
  assert.equal(bootResponse.status, 200, "boot endpoint should respond 200");
  const bootPayload = (await bootResponse.json()) as any;
  assert.equal(bootPayload.bridge.phase, "ready", "bridge should be ready after boot");
  assert.equal(bootPayload.onboarding.locked, true, "onboarding should be locked before setup");
  assert.equal(bootPayload.onboarding.lockReason, "required_setup", "lock reason should be required_setup");
  assert.equal(spawnCount, 1, "bridge should have spawned once during boot");

  // Verify prompt is blocked while locked
  const blockedPrompt = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: "should be rejected" }),
    }),
  );
  assert.equal(blockedPrompt.status, 423, "prompt should be locked (423) before onboarding");

  // -----------------------------------------------------------------------
  // Stage 2: Onboard — save API key, unlock workspace
  // -----------------------------------------------------------------------
  const onboardResponse = await onboardingRoute.POST(
    new Request("http://localhost/api/onboarding", {
      method: "POST",
      body: JSON.stringify({
        action: "save_api_key",
        providerId: "openai",
        apiKey: "sk-assembled-test-key",
      }),
    }),
  );
  assert.equal(onboardResponse.status, 200, "onboarding save_api_key should succeed");
  const onboardPayload = (await onboardResponse.json()) as any;
  assert.equal(onboardPayload.onboarding.locked, false, "onboarding should be unlocked after setup");
  assert.equal(onboardPayload.onboarding.lockReason, null, "lock reason should be null after setup");
  assert.equal(onboardPayload.onboarding.bridgeAuthRefresh.phase, "succeeded", "bridge auth refresh should succeed");
  assert.equal(spawnCount, 2, "bridge should have been restarted (spawned again) during auth refresh");

  // -----------------------------------------------------------------------
  // Stage 3: Subscribe SSE + send prompt
  // -----------------------------------------------------------------------
  const sseResponse = await eventsRoute.GET(
    new Request("http://localhost/api/session/events", { signal: AbortSignal.timeout(10_000) }),
  );
  assert.equal(sseResponse.status, 200, "SSE endpoint should respond 200");
  assert.equal(
    sseResponse.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
    "SSE should have correct content type",
  );

  // Start reading SSE events in background (reads until count or timeout)
  const phase1EventsPromise = readSseEvents(sseResponse, 15, 3_000);

  // Send the prompt — triggers fake child's streaming event sequence
  const promptResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: "deploy the application" }),
    }),
  );
  assert.equal(promptResponse.status, 200, "prompt should succeed after onboarding");
  const promptPayload = (await promptResponse.json()) as any;
  assert.equal(promptPayload.success, true, "prompt RPC response should indicate success");
  assert.equal(promptPayload.command, "prompt", "prompt RPC response should echo command type");

  // Collect Phase 1 SSE events
  const phase1Events = await phase1EventsPromise;
  await waitForMicrotasks();

  // -----------------------------------------------------------------------
  // Stage 4: Verify streaming events arrived via SSE
  // -----------------------------------------------------------------------
  const nonStatusEvents = phase1Events.filter((e) => e.type !== "bridge_status");
  const eventTypes = nonStatusEvents.map((e) => e.type);

  const messageUpdate = nonStatusEvents.find((e) => e.type === "message_update");
  assert.ok(
    messageUpdate,
    `message_update event should arrive via SSE (got types: ${eventTypes.join(", ")})`,
  );
  assert.equal(
    messageUpdate.assistantMessageEvent.type,
    "text_delta",
    "message_update should contain a text_delta",
  );
  assert.equal(
    messageUpdate.assistantMessageEvent.delta,
    "Deploying to production...",
    "text_delta should carry the expected content",
  );

  const toolStart = nonStatusEvents.find((e) => e.type === "tool_execution_start");
  assert.ok(
    toolStart,
    `tool_execution_start event should arrive via SSE (got types: ${eventTypes.join(", ")})`,
  );
  assert.equal(toolStart.toolCallId, "tc-deploy-1", "tool start should have correct toolCallId");
  assert.equal(toolStart.toolName, "bash", "tool start should identify the tool name");

  const toolEnd = nonStatusEvents.find((e) => e.type === "tool_execution_end");
  assert.ok(
    toolEnd,
    `tool_execution_end event should arrive via SSE (got types: ${eventTypes.join(", ")})`,
  );
  assert.equal(toolEnd.toolCallId, "tc-deploy-1", "tool end should match the tool start");
  assert.equal(toolEnd.isError, false, "tool execution should not be an error");

  const uiRequest = nonStatusEvents.find((e) => e.type === "extension_ui_request");
  assert.ok(
    uiRequest,
    `extension_ui_request event should arrive via SSE (got types: ${eventTypes.join(", ")})`,
  );
  assert.equal(uiRequest.id, "ui-confirm-deploy", "UI request should have the expected id");
  assert.equal(uiRequest.method, "confirm", "UI request should be a confirm dialog");
  assert.equal(uiRequest.title, "Confirm deployment", "UI request should have the expected title");
  assert.equal(
    uiRequest.message,
    "Proceed with deploying to production?",
    "UI request should have the expected message",
  );

  // Verify correct event ordering: message_update → tool_start → tool_end → ui_request
  const msgIdx = nonStatusEvents.indexOf(messageUpdate);
  const toolStartIdx = nonStatusEvents.indexOf(toolStart);
  const toolEndIdx = nonStatusEvents.indexOf(toolEnd);
  const uiReqIdx = nonStatusEvents.indexOf(uiRequest);
  assert.ok(msgIdx < toolStartIdx, "message_update should precede tool_execution_start");
  assert.ok(toolStartIdx < toolEndIdx, "tool_execution_start should precede tool_execution_end");
  assert.ok(toolEndIdx < uiReqIdx, "tool_execution_end should precede extension_ui_request");

  // Verify bridge_status events were also delivered (proves SSE fanout is working)
  const statusEvents = phase1Events.filter((e) => e.type === "bridge_status");
  assert.ok(statusEvents.length >= 1, "at least one bridge_status event should arrive via SSE");

  // -----------------------------------------------------------------------
  // Stage 5: Respond to UI request — prove the round-trip
  // -----------------------------------------------------------------------
  const sseResponse2 = await eventsRoute.GET(
    new Request("http://localhost/api/session/events", { signal: AbortSignal.timeout(10_000) }),
  );

  // Start reading Phase 2 events in background
  const phase2EventsPromise = readSseEvents(sseResponse2, 10, 3_000);

  // Send the UI response
  const uiResponseResult = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({
        type: "extension_ui_response",
        id: "ui-confirm-deploy",
        value: true,
      }),
    }),
  );
  assert.equal(uiResponseResult.status, 202, "extension_ui_response should return 202 (fire-and-forget)");

  // Wait for microtasks to let the stdin write propagate
  await waitForMicrotasks();

  // Verify the UI response reached the fake child's stdin (round-trip proof)
  assert.ok(receivedUiResponse, "UI response should have reached the fake child via bridge stdin");
  assert.equal(receivedUiResponse.id, "ui-confirm-deploy", "UI response id should match the request");
  assert.equal(receivedUiResponse.value, true, "UI response value should be delivered intact");

  // Collect Phase 2 SSE events (agent_end + turn_end)
  const phase2Events = await phase2EventsPromise;
  await waitForMicrotasks();

  // -----------------------------------------------------------------------
  // Stage 6: Verify turn boundary events
  // -----------------------------------------------------------------------
  const phase2NonStatus = phase2Events.filter((e) => e.type !== "bridge_status");
  const phase2Types = phase2NonStatus.map((e) => e.type);

  const agentEnd = phase2NonStatus.find((e) => e.type === "agent_end");
  assert.ok(
    agentEnd,
    `agent_end event should arrive via SSE after UI response (got types: ${phase2Types.join(", ")})`,
  );

  const turnEnd = phase2NonStatus.find((e) => e.type === "turn_end");
  assert.ok(
    turnEnd,
    `turn_end event should arrive via SSE after UI response (got types: ${phase2Types.join(", ")})`,
  );

  // Verify agent_end precedes turn_end
  const agentEndIdx = phase2NonStatus.indexOf(agentEnd);
  const turnEndIdx = phase2NonStatus.indexOf(turnEnd);
  assert.ok(agentEndIdx < turnEndIdx, "agent_end should precede turn_end");

  // -----------------------------------------------------------------------
  // Summary assertion: the complete assembled pipeline is proven
  // -----------------------------------------------------------------------
  const allEventTypes = [
    ...nonStatusEvents.map((e) => e.type),
    ...phase2NonStatus.map((e) => e.type),
  ];
  const requiredTypes = [
    "message_update",
    "tool_execution_start",
    "tool_execution_end",
    "extension_ui_request",
    "agent_end",
    "turn_end",
  ];
  for (const required of requiredTypes) {
    assert.ok(
      allEventTypes.includes(required),
      `complete pipeline must include ${required} (got: ${allEventTypes.join(", ")})`,
    );
  }
});

test("assembled settings controls keep retry visibility and daily-use mutations authoritative", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-settings", "Settings Session");
  const bridgeCommands: any[] = [];
  let sessionState = {
    ...fakeSessionState("sess-settings", sessionPath),
    retryInProgress: true,
    retryAttempt: 2,
  };

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      void command;
      void args;
      void options;
      const child = new FakeRpcChild();

      attachJsonLineReader(child.stdin, (line) => {
        const message = JSON.parse(line) as any;
        bridgeCommands.push(message);

        if (message.type === "get_state") {
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "get_state",
              success: true,
              data: sessionState,
            }),
          );
          return;
        }

        if (message.type === "set_steering_mode") {
          sessionState = { ...sessionState, steeringMode: message.mode };
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "set_steering_mode",
              success: true,
            }),
          );
          return;
        }

        if (message.type === "set_follow_up_mode") {
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "set_follow_up_mode",
              success: false,
              error: "follow-up mode rejected by the live session",
            }),
          );
          return;
        }

        if (message.type === "set_auto_compaction") {
          sessionState = { ...sessionState, autoCompactionEnabled: message.enabled };
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "set_auto_compaction",
              success: true,
            }),
          );
          return;
        }

        if (message.type === "set_auto_retry") {
          sessionState = { ...sessionState, autoRetryEnabled: message.enabled };
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "set_auto_retry",
              success: true,
            }),
          );
          return;
        }

        if (message.type === "abort_retry") {
          sessionState = { ...sessionState, retryInProgress: false, retryAttempt: 0 };
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "abort_retry",
              success: true,
            }),
          );
          return;
        }
      });

      return child as any;
    },
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  onboarding.configureOnboardingServiceForTests({
    authStorage: AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "sk-test-assembled-settings" },
    } as any),
    getEnvApiKey: () => undefined,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  const bootResponse = await bootRoute.GET();
  assert.equal(bootResponse.status, 200);
  const bootPayload = (await bootResponse.json()) as any;
  assert.equal(bootPayload.bridge.sessionState.autoRetryEnabled, false);
  assert.equal(bootPayload.bridge.sessionState.retryInProgress, true);
  assert.equal(bootPayload.bridge.sessionState.retryAttempt, 2);

  const steeringResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "set_steering_mode", mode: "one-at-a-time" }),
    }),
  );
  assert.equal(steeringResponse.status, 200);
  const steeringBody = (await steeringResponse.json()) as any;
  assert.equal(steeringBody.success, true);

  const followUpResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "set_follow_up_mode", mode: "one-at-a-time" }),
    }),
  );
  assert.equal(followUpResponse.status, 502);
  const followUpBody = (await followUpResponse.json()) as any;
  assert.equal(followUpBody.success, false);
  assert.match(followUpBody.error, /follow-up mode rejected/i);

  const autoCompactionResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "set_auto_compaction", enabled: true }),
    }),
  );
  assert.equal(autoCompactionResponse.status, 200);
  const autoCompactionBody = (await autoCompactionResponse.json()) as any;
  assert.equal(autoCompactionBody.success, true);

  const autoRetryResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "set_auto_retry", enabled: true }),
    }),
  );
  assert.equal(autoRetryResponse.status, 200);
  const autoRetryBody = (await autoRetryResponse.json()) as any;
  assert.equal(autoRetryBody.success, true);

  const abortRetryResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "abort_retry" }),
    }),
  );
  assert.equal(abortRetryResponse.status, 200);
  const abortRetryBody = (await abortRetryResponse.json()) as any;
  assert.equal(abortRetryBody.success, true);

  await waitForMicrotasks();

  const refreshedBootResponse = await bootRoute.GET();
  assert.equal(refreshedBootResponse.status, 200);
  const refreshedBootPayload = (await refreshedBootResponse.json()) as any;
  assert.equal(refreshedBootPayload.bridge.sessionState.steeringMode, "one-at-a-time");
  assert.equal(refreshedBootPayload.bridge.sessionState.followUpMode, "all");
  assert.equal(refreshedBootPayload.bridge.sessionState.autoCompactionEnabled, true);
  assert.equal(refreshedBootPayload.bridge.sessionState.autoRetryEnabled, true);
  assert.equal(refreshedBootPayload.bridge.sessionState.retryInProgress, false);
  assert.equal(refreshedBootPayload.bridge.sessionState.retryAttempt, 0);

  assert.deepEqual(
    bridgeCommands.filter((entry) => entry.type !== "get_state").map((entry) => entry.type),
    ["set_steering_mode", "set_follow_up_mode", "set_auto_compaction", "set_auto_retry", "abort_retry"],
    "settings parity must route through the live bridge instead of browser-local toggles",
  );
});

test("assembled recovery route exposes actionable browser diagnostics without raw transcript leakage", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-recovery", "Recovery Session");

  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "session", version: 3, id: "sess-recovery", timestamp: "2026-03-14T18:00:00.000Z", cwd: fixture.projectCwd }),
      JSON.stringify({ type: "session_info", id: "info-1", parentId: null, timestamp: "2026-03-14T18:00:01.000Z", name: "Recovery Session" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo hi" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          isError: true,
          content: "authentication failed for sk-assembled-recovery-secret-0001",
        },
      }),
    ].join("\n") + "\n",
  );

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      void command;
      void args;
      void options;
      const child = new FakeRpcChild();

      attachJsonLineReader(child.stdin, (line) => {
        const message = JSON.parse(line) as any;
        if (message.type === "get_state") {
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "get_state",
              success: true,
              data: {
                ...fakeSessionState("sess-recovery", sessionPath),
                autoRetryEnabled: true,
                retryInProgress: true,
                retryAttempt: 2,
              },
            }),
          );
        }
      });

      return child as any;
    },
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingState: async () => ({
      status: "ready",
      locked: true,
      lockReason: "bridge_refresh_failed",
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
        phase: "failed",
        strategy: "restart",
        startedAt: "2026-03-15T03:31:00.000Z",
        completedAt: "2026-03-15T03:31:05.000Z",
        error: "Bridge refresh failed for sk-assembled-auth-secret-0002",
      },
    }),
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const response = await recoveryRoute.GET();
  assert.equal(response.status, 200);
  const payload = (await response.json()) as any;

  assert.equal(payload.status, "ready");
  assert.equal(payload.bridge.retry.inProgress, true);
  assert.equal(payload.bridge.retry.attempt, 2);
  assert.equal(payload.bridge.authRefresh.phase, "failed");
  assert.ok(payload.actions.browser.some((action: { id: string }) => action.id === "refresh_diagnostics"));
  assert.ok(payload.actions.browser.some((action: { id: string }) => action.id === "open_retry_controls"));
  assert.ok(payload.actions.browser.some((action: { id: string }) => action.id === "open_auth_controls"));
  assert.equal(payload.interruptedRun.detected, true);
  assert.doesNotMatch(JSON.stringify(payload), /sk-assembled-recovery-secret-0001|sk-assembled-auth-secret-0002/);
});

test("assembled slash-command behavior keeps built-ins safe while preserving GSD prompt commands", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-slash", "Slash Session");
  const bridgeCommands: any[] = [];

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      void command;
      void args;
      void options;
      const child = new FakeRpcChild();

      attachJsonLineReader(child.stdin, (line) => {
        const message = JSON.parse(line) as any;
        bridgeCommands.push(message);

        if (message.type === "get_state") {
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "get_state",
              success: true,
              data: fakeSessionState("sess-slash", sessionPath),
            }),
          );
          return;
        }

        if (message.type === "new_session") {
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "new_session",
              success: true,
              data: { cancelled: false },
            }),
          );
          return;
        }

        if (message.type === "prompt") {
          child.stdout.write(
            serializeJsonLine({
              id: message.id,
              type: "response",
              command: "prompt",
              success: true,
            }),
          );
        }
      });

      return child as any;
    },
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
    getOnboardingNeeded: () => false,
  });

  onboarding.configureOnboardingServiceForTests({
    authStorage: AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "sk-test-assembled-slash" },
    } as any),
    getEnvApiKey: () => undefined,
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  async function submitBrowserInput(input: string): Promise<{ outcome: any; status: number | null; body: any; notice: string | null }> {
    const outcome = dispatchBrowserSlashCommand(input);

    if (outcome.kind === "prompt" || outcome.kind === "rpc") {
      const response = await commandRoute.POST(
        new Request("http://localhost/api/session/command", {
          method: "POST",
          body: JSON.stringify(outcome.command),
        }),
      );
      return {
        outcome,
        status: response.status,
        body: await response.json(),
        notice: null,
      };
    }

    const notice = getBrowserSlashCommandTerminalNotice(outcome)?.message ?? null;
    return {
      outcome,
      status: null,
      body: null,
      notice,
    };
  }

  const builtInExecution = await submitBrowserInput("/new");
  assert.equal(builtInExecution.outcome.kind, "rpc");
  assert.equal(builtInExecution.status, 200);
  assert.equal(builtInExecution.body.command, "new_session");

  const builtInSurface = await submitBrowserInput("/model");
  assert.equal(builtInSurface.outcome.kind, "surface");
  assert.equal(builtInSurface.outcome.surface, "model");
  assert.equal(builtInSurface.status, null);

  const builtInNameSurface = await submitBrowserInput("/name Ship It");
  assert.equal(builtInNameSurface.outcome.kind, "surface");
  assert.equal(builtInNameSurface.outcome.surface, "name");
  assert.equal(builtInNameSurface.status, null);

  const builtInReject = await submitBrowserInput("/share");
  assert.equal(builtInReject.outcome.kind, "reject");
  assert.match(builtInReject.notice ?? "", /blocked instead of falling through to the model/i);
  assert.equal(builtInReject.status, null);

  // /gsd status is now a browser surface (S02), verify that
  const gsdSurface = await submitBrowserInput("/gsd status");
  assert.equal(gsdSurface.outcome.kind, "surface");
  assert.equal(gsdSurface.outcome.surface, "gsd-status");
  assert.equal(gsdSurface.status, null);

  // /gsd auto is a passthrough subcommand — reaches the bridge as a prompt
  const gsdPrompt = await submitBrowserInput("/gsd auto");
  assert.equal(gsdPrompt.outcome.kind, "prompt");
  assert.equal(gsdPrompt.status, 200);
  assert.equal(gsdPrompt.body.command, "prompt");

  const sentTypes = bridgeCommands.map((command) => command.type);
  assert.deepEqual(
    sentTypes.filter((type) => type !== "get_state"),
    ["new_session", "prompt"],
    "only browser-executable slash commands should reach the live bridge; built-in surfaces/rejects must stay out of prompt text",
  );
  const promptCommand = bridgeCommands.find((command) => command.type === "prompt");
  assert.equal(promptCommand?.message, "/gsd auto", "GSD passthrough commands must stay on the extension prompt path");
});
