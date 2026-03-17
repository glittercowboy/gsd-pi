import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { chromium } from "playwright";

import {
  killProcessOnPort,
  launchPackagedWebHost,
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


test("successful browser onboarding restarts the stale bridge child and unlocks the first prompt", async () => {
  const fixture = makeWorkspaceFixture();
  const authStorage = AuthStorage.inMemory({});
  const harness = configureBridgeRuntime(fixture, authStorage);
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    validateApiKey: async () => ({ ok: true, message: "openai credentials validated" }),
  });

  try {
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
  } finally {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  }
});

test("refresh failures keep the workspace locked and expose the failed bridge-refresh reason", async () => {
  const fixture = makeWorkspaceFixture();
  const authStorage = AuthStorage.inMemory({});
  const harness = configureBridgeRuntime(fixture, authStorage, { failRestart: true });
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    validateApiKey: async () => ({ ok: true, message: "openai credentials validated" }),
  });

  try {
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
  } finally {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    fixture.cleanup();
  }
});

test("fresh gsd --web browser onboarding stays locked on failed validation and unlocks after a successful retry", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime launch test uses POSIX browser-open stubs");
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "gsd-web-onboarding-runtime-"));
  const tempHome = join(tempRoot, "home");
  const browserLogPath = join(tempRoot, "browser-open.log");
  let port: number | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    const launch = await launchPackagedWebHost({
      launchCwd: repoRoot,
      tempHome,
      browserLogPath,
      env: {
        GSD_WEB_TEST_FAKE_API_KEY_VALIDATION: "1",
      },
    });
    port = launch.port;

    assert.equal(launch.exitCode, 0, `expected the web launcher to exit cleanly:\n${launch.stderr}`);
    assert.match(launch.stderr, /status=started/, "expected a started diagnostic line on stderr");

    await waitForHttpOk(`${launch.url}/api/boot`);

    const bootBefore = await fetch(`${launch.url}/api/boot`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(bootBefore.ok, true, `expected boot endpoint to respond successfully: ${bootBefore.status}`);
    const bootBeforePayload = await bootBefore.json() as any;
    assert.equal(bootBeforePayload.onboarding.locked, true);
    assert.equal(bootBeforePayload.onboarding.lockReason, "required_setup");

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(launch.url, { waitUntil: "load" });

    await page.waitForSelector('[data-testid="onboarding-gate"]', { state: "visible" });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="workspace-connection-status"]');
      return Boolean(node?.textContent?.includes("Required setup"));
    });

    assert.equal(await page.locator('[data-testid="terminal-command-input"]').isDisabled(), true);

    await page.click('[data-testid="onboarding-provider-openai"]');
    await page.locator('[data-testid="onboarding-api-key-input"]').fill('invalid-demo-key');
    await page.click('[data-testid="onboarding-save-api-key"]');

    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="onboarding-validation-message"]');
      return Boolean(node?.textContent?.match(/rejected/i));
    });

    const failedValidationText = await page.locator('[data-testid="onboarding-validation-message"]').textContent();
    assert.match(failedValidationText ?? "", /rejected/i);
    assert.equal(await page.locator('[data-testid="onboarding-gate"]').isVisible(), true);
    assert.equal(await page.locator('[data-testid="terminal-command-input"]').isDisabled(), true);

    await page.locator('[data-testid="onboarding-api-key-input"]').fill('valid-demo-key');
    await page.click('[data-testid="onboarding-save-api-key"]');

    // Wait for onboarding to unlock and wizard to auto-advance past authenticate step
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="workspace-connection-status"]');
      return Boolean(node && !/Required setup|Refreshing bridge auth/i.test(node.textContent || ""));
    }, null, { timeout: 30_000 });

    // Complete the onboarding wizard — click through Optional and Ready steps
    const optionalContinue = page.locator('[data-testid="onboarding-optional-continue"]');
    if (await optionalContinue.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await optionalContinue.click();
    }
    const finishButton = page.locator('[data-testid="onboarding-finish"]');
    if (await finishButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await finishButton.click();
    }

    await page.waitForSelector('[data-testid="onboarding-gate"]', { state: 'detached', timeout: 15_000 });

    assert.equal(await page.locator('[data-testid="terminal-command-input"]').isDisabled(), false);

    await page.locator('[data-testid="terminal-command-input"]').fill('/new');
    await page.locator('[data-testid="terminal-command-input"]').press('Enter');

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('[data-testid="terminal-line"]')).some((node) =>
        node.textContent?.includes('Started a new session'),
      );
    });

    const bootAfter = await fetch(`${launch.url}/api/boot`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(bootAfter.ok, true, `expected unlocked boot endpoint to respond successfully: ${bootAfter.status}`);
    const bootAfterPayload = await bootAfter.json() as any;
    assert.equal(bootAfterPayload.onboarding.locked, false);
    assert.equal(bootAfterPayload.onboarding.lockReason, null);
  } finally {
    await browser?.close().catch(() => undefined);
    if (port !== null) {
      await killProcessOnPort(port);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
