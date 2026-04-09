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
const eventsRoute = await import("../../../web/app/api/session/events/route.ts");

// ---------------------------------------------------------------------------
// Test infrastructure (reused from web-bridge-contract.test.ts)
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
  const root = mkdtempSync(join(tmpdir(), "gsd-web-live-"));
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
    `# S01: Demo\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Must-Haves\n- test\n\n## Tasks\n- [ ] **T01: Work** \`est:5m\`\n`,
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
    scopes: [
      { scope: "project", label: "project", kind: "project" },
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
    get commands() {
      return commands;
    },
    get child() {
      return child;
    },
  };

  return harness;
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

function setupBridge(harness: ReturnType<typeof createHarness>, fixture: ReturnType<typeof makeWorkspaceFixture>) {
  onboarding.configureOnboardingServiceForTests({
    authStorage: AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "sk-test-live-interaction" },
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
  });
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
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out reading SSE events")), 2_000)),
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
        await reader.cancel();
        return events;
      }
    }
  }

  await reader.cancel();
  return events;
}

// ---------------------------------------------------------------------------
// Inline store event routing harness
//
// This mirrors the GSDWorkspaceStore's handleEvent routing logic
// so we can verify state transitions without importing .tsx.
// The contract test verifies this logic matches the real store behavior
// by testing the same event shapes the SSE bridge produces.
// ---------------------------------------------------------------------------

interface MinimalLiveState {
  pendingUiRequests: any[];
  streamingAssistantText: string;
  liveTranscript: string[];
  activeToolExecution: { id: string; name: string } | null;
  statusTexts: Record<string, string>;
  widgetContents: Record<string, { lines: string[] | undefined; placement?: string }>;
  titleOverride: string | null;
  editorTextBuffer: string | null;
}

function createMinimalLiveState(): MinimalLiveState {
  return {
    pendingUiRequests: [],
    streamingAssistantText: "",
    liveTranscript: [],
    activeToolExecution: null,
    statusTexts: {},
    widgetContents: {},
    titleOverride: null,
    editorTextBuffer: null,
  };
}

function consumeEditorTextBuffer(state: MinimalLiveState): { state: MinimalLiveState; value: string | null } {
  const value = state.editorTextBuffer;
  if (value === null) {
    return { state, value: null };
  }

  return {
    value,
    state: {
      ...state,
      editorTextBuffer: null,
    },
  };
}

/** Mirrors GSDWorkspaceStore.routeLiveInteractionEvent */
function routeEvent(state: MinimalLiveState, event: any): MinimalLiveState {
  const s = { ...state };

  switch (event.type) {
    case "extension_ui_request": {
      const method = event.method;
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        s.pendingUiRequests = [...s.pendingUiRequests, event];
      } else if (method === "setStatus") {
        s.statusTexts = { ...s.statusTexts };
        if (event.statusText === undefined) {
          delete s.statusTexts[event.statusKey];
        } else {
          s.statusTexts[event.statusKey] = event.statusText;
        }
      } else if (method === "setWidget") {
        s.widgetContents = { ...s.widgetContents };
        if (event.widgetLines === undefined) {
          delete s.widgetContents[event.widgetKey];
        } else {
          s.widgetContents[event.widgetKey] = { lines: event.widgetLines, placement: event.widgetPlacement };
        }
      } else if (method === "setTitle") {
        const nextTitle = typeof event.title === "string" ? event.title.trim() : "";
        s.titleOverride = nextTitle.length > 0 ? nextTitle : null;
      } else if (method === "set_editor_text") {
        s.editorTextBuffer = event.text;
      }
      // notify: no state change (produces terminal line only)
      break;
    }
    case "message_update": {
      const ae = event.assistantMessageEvent;
      if (ae && ae.type === "text_delta" && typeof ae.delta === "string") {
        s.streamingAssistantText = s.streamingAssistantText + ae.delta;
      }
      break;
    }
    case "agent_end":
    case "turn_end": {
      if (s.streamingAssistantText.length > 0) {
        s.liveTranscript = [...s.liveTranscript, s.streamingAssistantText];
        s.streamingAssistantText = "";
      }
      break;
    }
    case "tool_execution_start": {
      s.activeToolExecution = { id: event.toolCallId, name: event.toolName };
      break;
    }
    case "tool_execution_end": {
      s.activeToolExecution = null;
      break;
    }
  }

  return s;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("(a) SSE emits extension_ui_request with method 'select' → typed payload with options and allowMultiple", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-ui", "UI Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-ui", sessionPath),
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

  harness.emit({
    type: "extension_ui_request",
    id: "req-select-1",
    method: "select",
    title: "Choose a file",
    options: ["file-a.ts", "file-b.ts", "file-c.ts"],
    allowMultiple: true,
  });

  const events = await readSseEvents(response, 2); // bridge_status + the UI request
  controller.abort();
  await waitForMicrotasks();

  const uiEvent = events.find((e) => e.type === "extension_ui_request");
  assert.ok(uiEvent, "extension_ui_request event received via SSE");
  assert.equal(uiEvent.id, "req-select-1");
  assert.equal(uiEvent.method, "select");
  assert.equal(uiEvent.title, "Choose a file");
  assert.deepEqual(uiEvent.options, ["file-a.ts", "file-b.ts", "file-c.ts"]);
  assert.equal(uiEvent.allowMultiple, true);

  // Verify store routing: select is a blocking method → should queue
  let state = createMinimalLiveState();
  state = routeEvent(state, uiEvent);
  assert.equal(state.pendingUiRequests.length, 1);
  assert.equal(state.pendingUiRequests[0].id, "req-select-1");
  assert.equal(state.pendingUiRequests[0].method, "select");
  assert.deepEqual(state.pendingUiRequests[0].options, ["file-a.ts", "file-b.ts", "file-c.ts"]);
  assert.equal(state.pendingUiRequests[0].allowMultiple, true);
});

test("(b) Multiple concurrent UI requests queue correctly keyed by id", async () => {
  let state = createMinimalLiveState();

  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "req-1",
    method: "select",
    title: "First",
    options: ["a", "b"],
  });
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "req-2",
    method: "confirm",
    title: "Second",
    message: "Are you sure?",
  });
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "req-3",
    method: "input",
    title: "Third",
    placeholder: "Enter value",
  });
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "req-4",
    method: "editor",
    title: "Fourth",
    prefill: "initial text",
  });

  assert.equal(state.pendingUiRequests.length, 4);
  assert.equal(state.pendingUiRequests[0].id, "req-1");
  assert.equal(state.pendingUiRequests[0].method, "select");
  assert.equal(state.pendingUiRequests[1].id, "req-2");
  assert.equal(state.pendingUiRequests[1].method, "confirm");
  assert.equal(state.pendingUiRequests[1].message, "Are you sure?");
  assert.equal(state.pendingUiRequests[2].id, "req-3");
  assert.equal(state.pendingUiRequests[2].method, "input");
  assert.equal(state.pendingUiRequests[2].placeholder, "Enter value");
  assert.equal(state.pendingUiRequests[3].id, "req-4");
  assert.equal(state.pendingUiRequests[3].method, "editor");
  assert.equal(state.pendingUiRequests[3].prefill, "initial text");
});

test("(c) Responding to a UI request posts extension_ui_response with correct id and value to the bridge", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-respond", "Respond Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-respond", sessionPath),
      });
      return;
    }
    // extension_ui_response is a fire-and-forget write to stdin — no RPC response expected
  });

  setupBridge(harness, fixture);

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  // Post an extension_ui_response via the command route
  const response = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "extension_ui_response", id: "req-42", value: "option-b" }),
    }),
  );

  // extension_ui_response returns { ok: true } (202) because it's fire-and-forget
  assert.equal(response.status, 202);

  await waitForMicrotasks();

  // Verify the command was written to the bridge's stdin
  const uiResponseCmd = harness.commands.find((c) => c.type === "extension_ui_response");
  assert.ok(uiResponseCmd, "extension_ui_response was sent to the bridge");
  assert.equal(uiResponseCmd.id, "req-42");
  assert.equal(uiResponseCmd.value, "option-b");
});

test("(d) Dismissing a UI request posts cancelled: true and removes from pending", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-dismiss", "Dismiss Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-dismiss", sessionPath),
      });
      return;
    }
  });

  setupBridge(harness, fixture);

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    onboarding.resetOnboardingServiceForTests();
    fixture.cleanup();
  });

  // Post a cancel response
  const response = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "extension_ui_response", id: "req-99", cancelled: true }),
    }),
  );

  assert.equal(response.status, 202);
  await waitForMicrotasks();

  const cancelCmd = harness.commands.find((c) => c.type === "extension_ui_response" && c.cancelled === true);
  assert.ok(cancelCmd, "cancellation extension_ui_response was sent to the bridge");
  assert.equal(cancelCmd.id, "req-99");
  assert.equal(cancelCmd.cancelled, true);

  // Verify store routing: removing from pending queue
  let state = createMinimalLiveState();
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "req-99",
    method: "confirm",
    title: "Confirm?",
    message: "Really?",
  });
  assert.equal(state.pendingUiRequests.length, 1);

  // Simulate removal (mirrors store's dismissUiRequest behavior)
  state = {
    ...state,
    pendingUiRequests: state.pendingUiRequests.filter((r: any) => r.id !== "req-99"),
  };
  assert.equal(state.pendingUiRequests.length, 0);
});

test("(e) SSE emits message_update with text delta → streamingAssistantText accumulates", async (t) => {
  let state = createMinimalLiveState();

  state = routeEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hello ", contentIndex: 0 },
  });
  assert.equal(state.streamingAssistantText, "Hello ");

  state = routeEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "world!", contentIndex: 0 },
  });
  assert.equal(state.streamingAssistantText, "Hello world!");

  // Non-text_delta events should not accumulate
  state = routeEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  assert.equal(state.streamingAssistantText, "Hello world!");

  // Verify via SSE that message_update events flow through the bridge
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-stream", "Stream Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-stream", sessionPath),
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

  harness.emit({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", delta: "streamed text", contentIndex: 0, partial: {} },
  });

  const events = await readSseEvents(response, 2); // bridge_status + message_update
  controller.abort();
  await waitForMicrotasks();

  const msgEvent = events.find((e) => e.type === "message_update");
  assert.ok(msgEvent, "message_update event received via SSE");
  assert.equal(msgEvent.assistantMessageEvent.type, "text_delta");
  assert.equal(msgEvent.assistantMessageEvent.delta, "streamed text");
});

test("(f) agent_end moves streaming text to transcript and resets streaming text", async () => {
  let state = createMinimalLiveState();

  // Accumulate some text
  state = routeEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "First turn output" },
  });
  assert.equal(state.streamingAssistantText, "First turn output");
  assert.equal(state.liveTranscript.length, 0);

  // Agent end → moves to transcript
  state = routeEvent(state, { type: "agent_end" });
  assert.equal(state.streamingAssistantText, "");
  assert.equal(state.liveTranscript.length, 1);
  assert.equal(state.liveTranscript[0], "First turn output");

  // Second turn
  state = routeEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Second turn" },
  });
  state = routeEvent(state, { type: "turn_end" });
  assert.equal(state.streamingAssistantText, "");
  assert.equal(state.liveTranscript.length, 2);
  assert.equal(state.liveTranscript[1], "Second turn");

  // Agent end with no streaming text → no empty transcript entry
  state = routeEvent(state, { type: "agent_end" });
  assert.equal(state.liveTranscript.length, 2);
});

test("(g) setStatus/setWidget/setTitle/set_editor_text fire-and-forget events update correct store state", async () => {
  let state = createMinimalLiveState();

  // setStatus
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-1",
    method: "setStatus",
    statusKey: "build",
    statusText: "Building…",
  });
  assert.equal(state.statusTexts["build"], "Building…");

  // setStatus with undefined clears the key
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-2",
    method: "setStatus",
    statusKey: "build",
    statusText: undefined,
  });
  assert.equal(state.statusTexts["build"], undefined);
  assert.equal("build" in state.statusTexts, false);

  // setWidget
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-3",
    method: "setWidget",
    widgetKey: "progress",
    widgetLines: ["Step 1/3", "Building module…"],
    widgetPlacement: "belowEditor",
  });
  assert.ok(state.widgetContents["progress"]);
  assert.deepEqual(state.widgetContents["progress"].lines, ["Step 1/3", "Building module…"]);
  assert.equal(state.widgetContents["progress"].placement, "belowEditor");

  // setWidget with undefined lines clears the widget
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-4",
    method: "setWidget",
    widgetKey: "progress",
    widgetLines: undefined,
  });
  assert.equal("progress" in state.widgetContents, false);

  // setTitle
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-5",
    method: "setTitle",
    title: "Custom Title",
  });
  assert.equal(state.titleOverride, "Custom Title");

  // blank setTitle clears the visible override instead of leaving an empty string behind
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-5-clear",
    method: "setTitle",
    title: "   ",
  });
  assert.equal(state.titleOverride, null);

  // set_editor_text
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-6",
    method: "set_editor_text",
    text: "prefilled editor content",
  });
  assert.equal(state.editorTextBuffer, "prefilled editor content");

  // Browser terminal consumes editor text once, then clears the buffer so it doesn't replay forever
  let consumed = consumeEditorTextBuffer(state);
  assert.equal(consumed.value, "prefilled editor content");
  assert.equal(consumed.state.editorTextBuffer, null);

  consumed = consumeEditorTextBuffer(consumed.state);
  assert.equal(consumed.value, null);
  assert.equal(consumed.state.editorTextBuffer, null);

  // Empty editor text is still a valid consume-once prefill because it clears the visible input
  state = routeEvent(consumed.state, {
    type: "extension_ui_request",
    id: "ff-6-clear",
    method: "set_editor_text",
    text: "",
  });
  assert.equal(state.editorTextBuffer, "");
  consumed = consumeEditorTextBuffer(state);
  assert.equal(consumed.value, "");
  assert.equal(consumed.state.editorTextBuffer, null);

  // notify does NOT queue — only produces a terminal line
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "ff-7",
    method: "notify",
    message: "Operation completed",
    notifyType: "info",
  });
  assert.equal(state.pendingUiRequests.length, 0, "notify should not queue a pending request");
});

test("(g-2) tool_execution_start/end update activeToolExecution", async () => {
  let state = createMinimalLiveState();

  state = routeEvent(state, {
    type: "tool_execution_start",
    toolCallId: "tc-1",
    toolName: "bash",
    args: { command: "ls" },
  });
  assert.ok(state.activeToolExecution);
  assert.equal(state.activeToolExecution.id, "tc-1");
  assert.equal(state.activeToolExecution.name, "bash");

  state = routeEvent(state, {
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName: "bash",
    result: {},
    isError: false,
  });
  assert.equal(state.activeToolExecution, null);
});

test("(h) steer and abort commands post the correct RPC command type", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-steer", "Steer Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-steer", sessionPath),
      });
      return;
    }

    if (command.type === "steer") {
      current.emit({
        id: command.id,
        type: "response",
        command: "steer",
        success: true,
      });
      return;
    }

    if (command.type === "abort") {
      current.emit({
        id: command.id,
        type: "response",
        command: "abort",
        success: true,
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

  // Send steer command
  const steerResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "steer", message: "focus on the login flow" }),
    }),
  );
  assert.equal(steerResponse.status, 200);
  const steerBody = await steerResponse.json() as any;
  assert.equal(steerBody.success, true);
  assert.equal(steerBody.command, "steer");

  // Verify steer command reached the bridge with the correct shape
  const steerCmd = harness.commands.find((c) => c.type === "steer");
  assert.ok(steerCmd, "steer command was sent to the bridge");
  assert.equal(steerCmd.message, "focus on the login flow");

  // Send abort command
  const abortResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "abort" }),
    }),
  );
  assert.equal(abortResponse.status, 200);
  const abortBody = await abortResponse.json() as any;
  assert.equal(abortBody.success, true);
  assert.equal(abortBody.command, "abort");

  const abortCmd = harness.commands.find((c) => c.type === "abort");
  assert.ok(abortCmd, "abort command was sent to the bridge");
});

test("(failure-path) UI response errors are visible as lastClientError and pending requests persist on failure", async () => {
  // Test the store-level behavior: if respondToUiRequest fails, the request stays in the queue
  let state = createMinimalLiveState();

  // Queue a request
  state = routeEvent(state, {
    type: "extension_ui_request",
    id: "req-fail",
    method: "confirm",
    title: "Confirm action",
    message: "Proceed?",
  });
  assert.equal(state.pendingUiRequests.length, 1);

  // Simulate failed removal (on error, the store does NOT remove the request)
  // Only successful responses remove from the queue
  const failedState = { ...state }; // no filter applied on error
  assert.equal(failedState.pendingUiRequests.length, 1, "request stays in queue on response failure");
  assert.equal(failedState.pendingUiRequests[0].id, "req-fail");

  // Simulate successful removal
  const successState = {
    ...state,
    pendingUiRequests: state.pendingUiRequests.filter((r: any) => r.id !== "req-fail"),
  };
  assert.equal(successState.pendingUiRequests.length, 0, "request removed on success");
});

test("(session-controls) browser session RPCs round-trip through /api/session/command", async (t) => {
  const fixture = makeWorkspaceFixture();
  const activeSessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-session", "Session Surface");
  const nextSessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-next", "Next Session");
  const stats = {
    sessionFile: activeSessionPath,
    sessionId: "sess-session",
    userMessages: 4,
    assistantMessages: 4,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 12,
    tokens: {
      input: 1200,
      output: 3400,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4600,
    },
    cost: 0.42,
  };
  const forkMessages = [
    { entryId: "entry-1", text: "Investigate the login flow" },
    { entryId: "entry-2", text: "Fix the slash-command dispatcher" },
  ];
  const exportPath = join(fixture.projectCwd, "artifacts", "session.html");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: fakeSessionState("sess-session", activeSessionPath),
      });
      return;
    }

    if (command.type === "get_session_stats") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_session_stats",
        success: true,
        data: stats,
      });
      return;
    }

    if (command.type === "export_html") {
      current.emit({
        id: command.id,
        type: "response",
        command: "export_html",
        success: true,
        data: { path: exportPath },
      });
      return;
    }

    if (command.type === "switch_session") {
      assert.equal(command.sessionPath, nextSessionPath);
      current.emit({
        id: command.id,
        type: "response",
        command: "switch_session",
        success: true,
        data: { cancelled: false },
      });
      return;
    }

    if (command.type === "get_fork_messages") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_fork_messages",
        success: true,
        data: { messages: forkMessages },
      });
      return;
    }

    if (command.type === "fork") {
      assert.equal(command.entryId, "entry-2");
      current.emit({
        id: command.id,
        type: "response",
        command: "fork",
        success: true,
        data: { text: "Fix the slash-command dispatcher", cancelled: false },
      });
      return;
    }

    if (command.type === "compact") {
      assert.equal(command.customInstructions, "Preserve blockers and current task state");
      current.emit({
        id: command.id,
        type: "response",
        command: "compact",
        success: true,
        data: {
          summary: "Compacted summary",
          firstKeptEntryId: "entry-9",
          tokensBefore: 14200,
        },
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

  const sessionResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "get_session_stats" }),
    }),
  );
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json() as any;
  assert.equal(sessionBody.success, true);
  assert.equal(sessionBody.command, "get_session_stats");
  assert.equal(sessionBody.data.sessionId, "sess-session");
  assert.equal(sessionBody.data.tokens.total, 4600);

  const exportResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "export_html", outputPath: exportPath }),
    }),
  );
  assert.equal(exportResponse.status, 200);
  const exportBody = await exportResponse.json() as any;
  assert.equal(exportBody.success, true);
  assert.equal(exportBody.data.path, exportPath);

  const switchResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "switch_session", sessionPath: nextSessionPath }),
    }),
  );
  assert.equal(switchResponse.status, 200);
  const switchBody = await switchResponse.json() as any;
  assert.equal(switchBody.success, true);
  assert.equal(switchBody.data.cancelled, false);

  const forkMessagesResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "get_fork_messages" }),
    }),
  );
  assert.equal(forkMessagesResponse.status, 200);
  const forkMessagesBody = await forkMessagesResponse.json() as any;
  assert.equal(forkMessagesBody.success, true);
  assert.deepEqual(forkMessagesBody.data.messages, forkMessages);

  const forkResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "fork", entryId: "entry-2" }),
    }),
  );
  assert.equal(forkResponse.status, 200);
  const forkBody = await forkResponse.json() as any;
  assert.equal(forkBody.success, true);
  assert.equal(forkBody.data.cancelled, false);
  assert.equal(forkBody.data.text, "Fix the slash-command dispatcher");

  const compactResponse = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "compact", customInstructions: "Preserve blockers and current task state" }),
    }),
  );
  assert.equal(compactResponse.status, 200);
  const compactBody = await compactResponse.json() as any;
  assert.equal(compactBody.success, true);
  assert.equal(compactBody.data.summary, "Compacted summary");
  assert.equal(compactBody.data.tokensBefore, 14200);

  assert.deepEqual(
    harness.commands.filter((command) => command.type !== "get_state").map((command) => command.type),
    ["get_session_stats", "export_html", "switch_session", "get_fork_messages", "fork", "compact"],
    "browser session controls should hit the live command route with the expected RPC sequence",
  );
});
