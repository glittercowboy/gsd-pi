import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright";

import {
  killProcessOnPort,
  launchPackagedWebHost,
  runtimeAuthHeaders,
  waitForHttpOk,
} from "./web-mode-runtime-harness.ts";

const repoRoot = process.cwd();

const bridge = await import("../../web/bridge-service.ts");
const onboarding = await import("../../web/onboarding-service.ts");
const bootRoute = await import("../../../web/app/api/boot/route.ts");
const onboardingRoute = await import("../../../web/app/api/onboarding/route.ts");
const commandRoute = await import("../../../web/app/api/session/command/route.ts");
const { AuthStorage } = await import("@gsd/pi-coding-agent");

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
  const root = mkdtempSync(join(tmpdir(), "gsd-web-onboarding-integration-"));
  const projectCwd = join(root, "project");
  const sessionsDir = join(root, "sessions");
  const milestoneDir = join(projectCwd, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S02");
  const tasksDir = join(sliceDir, "tasks");

  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    `# M001: Demo Milestone\n\n## Slices\n- [ ] **S02: First-run setup wizard** \`risk:medium\` \`depends:[S01]\`\n  > Browser onboarding\n`,
  );
  writeFileSync(
    join(sliceDir, "S02-PLAN.md"),
    `# S02: First-run setup wizard\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [ ] **T02: Enforce the gate and refresh bridge auth after successful setup** \`est:1h\`\n  Do the work.\n`,
  );
  writeFileSync(
    join(tasksDir, "T02-PLAN.md"),
    `# T02: Enforce the gate and refresh bridge auth after successful setup\n\n## Steps\n- do it\n`,
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

async function removeTreeWithRetry(path: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "ENOTEMPTY" || code === "EBUSY";
      if (!retryable || attempt === maxAttempts) throw err;
      await delay(100 * attempt);
    }
  }
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
            id: "S02",
            title: "First-run setup wizard",
            done: false,
            planPath: ".gsd/milestones/M001/slices/S02/S02-PLAN.md",
            tasksDir: ".gsd/milestones/M001/slices/S02/tasks",
            tasks: [
              {
                id: "T02",
                title: "Enforce the gate and refresh bridge auth after successful setup",
                done: false,
                planPath: ".gsd/milestones/M001/slices/S02/tasks/T02-PLAN.md",
              },
            ],
          },
        ],
      },
    ],
    active: {
      milestoneId: "M001",
      sliceId: "S02",
      taskId: "T02",
      phase: "executing",
    },
    scopes: [
      { scope: "project", label: "project", kind: "project" },
      { scope: "M001", label: "M001: Demo Milestone", kind: "milestone" },
      { scope: "M001/S02", label: "M001/S02: First-run setup wizard", kind: "slice" },
      {
        scope: "M001/S02/T02",
        label: "M001/S02/T02: Enforce the gate and refresh bridge auth after successful setup",
        kind: "task",
      },
    ],
    validationIssues: [],
  };
}

type BridgeRuntimeHarness = ReturnType<typeof configureBridgeRuntime>;

function configureBridgeRuntime(
  fixture: { projectCwd: string; sessionsDir: string },
  authStorage: InstanceType<typeof AuthStorage>,
  options: { failRestart?: boolean } = {},
) {
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, "sess-web-onboarding", "Web Onboarding Session");
  const generations: Array<{ authVisibleAtStart: boolean; promptMessages: string[] }> = [];
  let spawnCalls = 0;
  let child: FakeRpcChild | null = null;

  bridge.configureBridgeServiceForTests({
    env: {
      ...process.env,
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn(command: string, args: readonly string[], optionsArg: Record<string, unknown>) {
      void command;
      void args;
      void optionsArg;
      spawnCalls += 1;
      const generation = {
        authVisibleAtStart: authStorage.hasAuth("openai"),
        promptMessages: [] as string[],
      };
      generations.push(generation);
      child = new FakeRpcChild();
      attachJsonLineReader(child.stdin, (line) => {
        const message = JSON.parse(line) as any;
        switch (message.type) {
          case "get_state": {
            if (options.failRestart && spawnCalls >= 2) {
              child!.stdout.write(
                serializeJsonLine({
                  id: message.id,
                  type: "response",
                  command: "get_state",
                  success: false,
                  error: "bridge auth refresh could not attach to a live session",
                }),
              );
              return;
            }
            child!.stdout.write(
              serializeJsonLine({
                id: message.id,
                type: "response",
                command: "get_state",
                success: true,
                data: {
                  sessionId: "sess-web-onboarding",
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
                  messageCount: generation.promptMessages.length,
                  pendingMessageCount: 0,
                },
              }),
            );
            return;
          }
          case "prompt": {
            generation.promptMessages.push(String(message.message ?? ""));
            child!.stdout.write(
              serializeJsonLine(
                generation.authVisibleAtStart
                  ? {
                      id: message.id,
                      type: "response",
                      command: "prompt",
                      success: true,
                    }
                  : {
                      id: message.id,
                      type: "response",
                      command: "prompt",
                      success: false,
                      error: "prompt reached bridge without refreshed auth",
                    },
              ),
            );
            return;
          }
          default:
            assert.fail(`unexpected command during integration test: ${message.type}`);
        }
      });
      return child as any;
    },
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
  });

  return {
    get spawnCalls() {
      return spawnCalls;
    },
    get generations() {
      return generations;
    },
    get promptCount() {
      return generations.reduce((count, generation) => count + generation.promptMessages.length, 0);
    },
  };
}


test("successful browser onboarding restarts the stale bridge child and unlocks the first prompt", async (t) => {
  const fixture = makeWorkspaceFixture();
  const authStorage = AuthStorage.inMemory({});
  const harness = configureBridgeRuntime(fixture, authStorage);
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: () => undefined,
    isExternalCliProvider: () => false,
    validateApiKey: async () => ({ ok: true, message: "openai credentials validated" }),
  });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const bootResponse = await bootRoute.GET();
  assert.equal(bootResponse.status, 200);
  const bootPayload = (await bootResponse.json()) as any;
  assert.equal(bootPayload.onboarding.locked, true);
  assert.equal(bootPayload.onboarding.lockReason, "required_setup");
  assert.equal(harness.spawnCalls, 1);
  assert.equal(harness.generations[0]?.authVisibleAtStart, false);

  const blockedPrompt = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: "should stay locked" }),
    }),
  );
  assert.equal(blockedPrompt.status, 423);
  const blockedPayload = (await blockedPrompt.json()) as any;
  assert.equal(blockedPayload.code, "onboarding_locked");
  assert.equal(blockedPayload.details.reason, "required_setup");
  assert.equal(harness.promptCount, 0);

  const validationResponse = await onboardingRoute.POST(
    new Request("http://localhost/api/onboarding", {
      method: "POST",
      body: JSON.stringify({
        action: "save_api_key",
        providerId: "openai",
        apiKey: "sk-valid-123456",
      }),
    }),
  );
  assert.equal(validationResponse.status, 200);
  const validationPayload = (await validationResponse.json()) as any;
  assert.equal(validationPayload.onboarding.locked, false);
  assert.equal(validationPayload.onboarding.lockReason, null);
  assert.equal(validationPayload.onboarding.bridgeAuthRefresh.phase, "succeeded");
  assert.equal(harness.spawnCalls, 2);
  assert.equal(harness.generations[1]?.authVisibleAtStart, true);

  const firstPrompt = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: "first unlocked prompt" }),
    }),
  );
  assert.equal(firstPrompt.status, 200);
  const firstPromptPayload = (await firstPrompt.json()) as any;
  assert.equal(firstPromptPayload.success, true);
  assert.equal(firstPromptPayload.command, "prompt");
  assert.equal(harness.promptCount, 1);
  assert.deepEqual(harness.generations[1]?.promptMessages, ["first unlocked prompt"]);
});

test("refresh failures keep the workspace locked and expose the failed bridge-refresh reason", async (t) => {
  const fixture = makeWorkspaceFixture();
  const authStorage = AuthStorage.inMemory({});
  const harness = configureBridgeRuntime(fixture, authStorage, { failRestart: true });
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: () => undefined,
    isExternalCliProvider: () => false,
    validateApiKey: async () => ({ ok: true, message: "openai credentials validated" }),
  });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  });

  const bootResponse = await bootRoute.GET();
  assert.equal(bootResponse.status, 200);
  assert.equal(harness.spawnCalls, 1);

  const validationResponse = await onboardingRoute.POST(
    new Request("http://localhost/api/onboarding", {
      method: "POST",
      body: JSON.stringify({
        action: "save_api_key",
        providerId: "openai",
        apiKey: "sk-valid-123456",
      }),
    }),
  );
  assert.equal(validationResponse.status, 503);
  const validationPayload = (await validationResponse.json()) as any;
  assert.equal(validationPayload.onboarding.required.satisfied, true);
  assert.equal(validationPayload.onboarding.locked, true);
  assert.equal(validationPayload.onboarding.lockReason, "bridge_refresh_failed");
  assert.equal(validationPayload.onboarding.lastValidation.status, "succeeded");
  assert.equal(validationPayload.onboarding.bridgeAuthRefresh.phase, "failed");
  assert.match(validationPayload.onboarding.bridgeAuthRefresh.error, /could not attach/i);
  assert.equal(harness.spawnCalls, 2);
  assert.equal(harness.generations[1]?.authVisibleAtStart, true);

  const blockedPrompt = await commandRoute.POST(
    new Request("http://localhost/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: "still locked after failed refresh" }),
    }),
  );
  assert.equal(blockedPrompt.status, 423);
  const blockedPayload = (await blockedPrompt.json()) as any;
  assert.equal(blockedPayload.code, "onboarding_locked");
  assert.equal(blockedPayload.details.reason, "bridge_refresh_failed");
  assert.equal(harness.promptCount, 0);

  const failedBootResponse = await bootRoute.GET();
  assert.equal(failedBootResponse.status, 200);
  const failedBootPayload = (await failedBootResponse.json()) as any;
  assert.equal(failedBootPayload.onboarding.locked, true);
  assert.equal(failedBootPayload.onboarding.lockReason, "bridge_refresh_failed");
  assert.equal(failedBootPayload.onboarding.bridgeAuthRefresh.phase, "failed");
  assert.match(failedBootPayload.onboarding.bridgeAuthRefresh.error, /could not attach/i);
});

test("fresh gsd --web browser onboarding stays locked on failed validation and unlocks after a successful retry", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime launch test uses POSIX browser-open stubs")
    return
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-onboarding-runtime-"))
  const tempHome = join(tempRoot, "home")
  const browserLogPath = join(tempRoot, "browser-open.log")
  let port: number | null = null

  t.after(async () => {
    if (port !== null) {
    await killProcessOnPort(port)
    }
    await removeTreeWithRetry(tempRoot)
  });

  const launch = await launchPackagedWebHost({
    launchCwd: repoRoot,
    tempHome,
    browserLogPath,
    env: {
      GSD_WEB_TEST_FAKE_API_KEY_VALIDATION: "1",
      GSD_WEB_TEST_DISABLE_EXTERNAL_CLI: "1",
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      GOOGLE_API_KEY: "",
    },
  })
  port = launch.port

  assert.equal(launch.exitCode, 0, `expected the web launcher to exit cleanly:\n${launch.stderr}`)
  assert.match(launch.stderr, /status=started/, "expected a started diagnostic line on stderr")

  const auth = runtimeAuthHeaders(launch)
  await waitForHttpOk(`${launch.url}/api/boot`, undefined, auth)

  // 1. Boot reports locked before any credentials are saved
  const bootBefore = await fetch(`${launch.url}/api/boot`, {
    method: "GET",
    headers: { Accept: "application/json", ...auth },
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(bootBefore.ok, true, `expected boot endpoint to respond successfully: ${bootBefore.status}`)
  const bootBeforePayload = await bootBefore.json() as any
  assert.equal(bootBeforePayload.onboarding.locked, true)
  assert.equal(bootBeforePayload.onboarding.lockReason, "required_setup")

  // 2. Invalid key → stays locked with failed validation
  const invalidValidation = await fetch(`${launch.url}/api/onboarding`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
    body: JSON.stringify({ action: "save_api_key", providerId: "openai", apiKey: "invalid-demo-key" }),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(invalidValidation.status, 422)
  const invalidPayload = await invalidValidation.json() as any
  assert.equal(invalidPayload.onboarding.locked, true)
  assert.equal(invalidPayload.onboarding.lastValidation.status, "failed")
  assert.match(invalidPayload.onboarding.lastValidation.message ?? "", /rejected/i)

  // 3. Valid key → unlocks
  const validValidation = await fetch(`${launch.url}/api/onboarding`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
    body: JSON.stringify({ action: "save_api_key", providerId: "openai", apiKey: "valid-demo-key" }),
    signal: AbortSignal.timeout(60_000),
  })
  assert.equal(validValidation.status, 200, `expected successful retry to unlock onboarding: ${validValidation.status}`)
  const validPayload = await validValidation.json() as any
  assert.equal(validPayload.onboarding.locked, false)
  assert.equal(validPayload.onboarding.bridgeAuthRefresh.phase, "succeeded")

  // 4. Boot confirms unlocked
  const bootAfter = await fetch(`${launch.url}/api/boot`, {
    method: "GET",
    headers: { Accept: "application/json", ...auth },
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(bootAfter.ok, true)
  const bootAfterPayload = await bootAfter.json() as any
  assert.equal(bootAfterPayload.onboarding.locked, false)
  assert.equal(bootAfterPayload.onboarding.lockReason, null)
})
