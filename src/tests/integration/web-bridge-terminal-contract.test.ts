import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const repoRoot = process.cwd();
const bridge = await import("../../web/bridge-service.ts");
const streamRoute = await import("../../../web/app/api/bridge-terminal/stream/route.ts");
const inputRoute = await import("../../../web/app/api/bridge-terminal/input/route.ts");
const resizeRoute = await import("../../../web/app/api/bridge-terminal/resize/route.ts");

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

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor<T>(check: () => T | null | undefined, timeoutMs = 1500): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value != null) {
      return value;
    }
    await waitForMicrotasks();
  }
  throw new Error("Timed out waiting for condition");
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
        await reader.cancel();
        return events;
      }
    }
  }

  await reader.cancel();
  return events;
}

function makeWorkspaceFixture(): { projectCwd: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-bridge-terminal-"));
  const projectCwd = join(root, "project");
  const sessionsDir = join(root, "sessions");
  mkdirSync(projectCwd, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  return {
    projectCwd,
    sessionsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createHarness(onCommand: (command: any, harness: ReturnType<typeof createHarness>) => void) {
  let child: FakeRpcChild | null = null;
  const commands: any[] = [];

  const harness = {
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      void command;
      void args;
      void options;
      child = new FakeRpcChild();
      attachJsonLineReader(child.stdin, (line) => {
        const parsed = JSON.parse(line);
        commands.push(parsed);
        onCommand(parsed, harness);
      });
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

test("/api/bridge-terminal/stream attaches to the main bridge runtime and forwards native terminal output", async (t) => {
  const fixture = makeWorkspaceFixture();
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-main",
          sessionFile: join(fixture.sessionsDir, "sess-main.jsonl"),
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

    if (command.type === "terminal_resize") {
      current.emit({ id: command.id, type: "response", command: "terminal_resize", success: true });
      return;
    }

    if (command.type === "terminal_redraw") {
      current.emit({ id: command.id, type: "response", command: "terminal_redraw", success: true });
      queueMicrotask(() => {
        current.emit({ type: "terminal_output", data: "\u001b[2J\u001b[Hnative main session" });
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
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const response = await streamRoute.GET(
    new Request("http://localhost/api/bridge-terminal/stream?cols=132&rows=41"),
  );

  const events = await readSseEvents(response, 2);
  assert.equal(events[0].type, "connected");
  assert.equal(events[1].type, "output");
  assert.match(events[1].data, /native main session/);

  assert.ok(harness.commands.some((command) => command.type === "terminal_resize" && command.cols === 132 && command.rows === 41));
  assert.ok(harness.commands.some((command) => command.type === "terminal_redraw"));
});

test("bridge-terminal input and resize routes forward browser terminal traffic onto the authoritative bridge session", async (t) => {
  const fixture = makeWorkspaceFixture();
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "sess-main",
          sessionFile: join(fixture.sessionsDir, "sess-main.jsonl"),
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

    if (command.type === "terminal_input") {
      current.emit({ id: command.id, type: "response", command: "terminal_input", success: true });
      return;
    }

    if (command.type === "terminal_resize") {
      current.emit({ id: command.id, type: "response", command: "terminal_resize", success: true });
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
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const inputResponse = await inputRoute.POST(
    new Request("http://localhost/api/bridge-terminal/input", {
      method: "POST",
      body: JSON.stringify({ data: "hello from xterm" }),
    }),
  );
  assert.equal(inputResponse.status, 200);

  const resizeResponse = await resizeRoute.POST(
    new Request("http://localhost/api/bridge-terminal/resize", {
      method: "POST",
      body: JSON.stringify({ cols: 140, rows: 48 }),
    }),
  );
  assert.equal(resizeResponse.status, 200);

  assert.ok(harness.commands.some((command) => command.type === "terminal_input" && command.data === "hello from xterm"));
  assert.ok(harness.commands.some((command) => command.type === "terminal_resize" && command.cols === 140 && command.rows === 48));
});

test("session_state_changed from the native main-session TUI refreshes bridge state and emits matching live invalidations", async (t) => {
  const fixture = makeWorkspaceFixture();
  const sessionAPath = join(fixture.sessionsDir, "sess-a.jsonl");
  const sessionBPath = join(fixture.sessionsDir, "sess-b.jsonl");
  let activeSessionId = "sess-a";
  let activeSessionFile = sessionAPath;
  const seenEvents: Array<{ type?: string; reason?: string }> = [];

  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: activeSessionId,
          sessionFile: activeSessionFile,
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
  });

  t.after(async () => {
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const service = bridge.getProjectBridgeService();
  const unsubscribe = service.subscribe((event) => {
    seenEvents.push(event as { type?: string; reason?: string });
  });

  await service.ensureStarted();
  activeSessionId = "sess-b";
  activeSessionFile = sessionBPath;
  harness.emit({ type: "session_state_changed", reason: "switch_session" });

  await waitFor(() => {
    const snapshot = service.getSnapshot();
    return snapshot.activeSessionId === "sess-b" ? snapshot : null;
  });

  assert.ok(
    seenEvents.some((event) => event.type === "live_state_invalidation" && event.reason === "switch_session"),
    "switch_session live_state_invalidation should be emitted when the native TUI changes the active session",
  );

  unsubscribe();
});
