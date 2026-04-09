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
const commandRoute = await import("../../../web/app/api/session/command/route.ts");
const { AuthStorage } = await import("@gsd/pi-coding-agent");

const ONBOARDING_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "HF_TOKEN",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "ALIBABA_API_KEY",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

const ORIGINAL_ONBOARDING_ENV = Object.fromEntries(
  ONBOARDING_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ONBOARDING_ENV_KEYS)[number], string | undefined>;

function clearOnboardingEnv(): void {
  for (const key of ONBOARDING_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreOnboardingEnv(): void {
  for (const key of ONBOARDING_ENV_KEYS) {
    const value = ORIGINAL_ONBOARDING_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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

function noEnvApiKey(): null {
  return null;
}

function projectRequest(projectCwd: string, url: string, init?: RequestInit): Request {
  const base = new URL(url, "http://localhost");
  base.searchParams.set("project", projectCwd);
  return new Request(base, init);
}

function makeWorkspaceFixture(): { projectCwd: string; sessionsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gsd-web-onboarding-"));
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
    `# S02: First-run setup wizard\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Tasks\n- [ ] **T01: Establish shared onboarding auth truth and browser setup API** \`est:1h\`\n  Do the work.\n`,
  );
  writeFileSync(
    join(tasksDir, "T01-PLAN.md"),
    `# T01: Establish shared onboarding auth truth and browser setup API\n\n## Steps\n- do it\n`,
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
                id: "T01",
                title: "Establish shared onboarding auth truth and browser setup API",
                done: false,
                planPath: ".gsd/milestones/M001/slices/S02/tasks/T01-PLAN.md",
              },
            ],
          },
        ],
      },
    ],
    active: {
      milestoneId: "M001",
      sliceId: "S02",
      taskId: "T01",
      phase: "executing",
    },
    scopes: [
      { scope: "project", label: "project", kind: "project" },
      { scope: "M001", label: "M001: Demo Milestone", kind: "milestone" },
      { scope: "M001/S02", label: "M001/S02: First-run setup wizard", kind: "slice" },
      {
        scope: "M001/S02/T01",
        label: "M001/S02/T01: Establish shared onboarding auth truth and browser setup API",
        kind: "task",
      },
    ],
    validationIssues: [],
  };
}

function createHarness(onCommand: (command: any, harness: ReturnType<typeof createHarness>) => void) {
  let spawnCalls = 0;
  let child: FakeRpcChild | null = null;

  const harness = {
    spawn(command: string, args: readonly string[], options: Record<string, unknown>) {
      spawnCalls += 1;
      child = new FakeRpcChild();
      attachJsonLineReader(child.stdin, (line) => {
        onCommand(JSON.parse(line), harness);
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
  };

  return harness;
}

function configureBridgeFixture(fixture: { projectCwd: string; sessionsDir: string }, sessionId: string) {
  const sessionPath = createSessionFile(fixture.projectCwd, fixture.sessionsDir, sessionId, "Onboarding Session");
  const harness = createHarness((command, current) => {
    if (command.type === "get_state") {
      current.emit({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
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
        },
      });
      return;
    }

    assert.fail(`unexpected bridge command during onboarding contract test: ${command.type}`);
  });

  bridge.configureBridgeServiceForTests({
    env: {
      GSD_WEB_PROJECT_CWD: fixture.projectCwd,
      GSD_WEB_PROJECT_SESSIONS_DIR: fixture.sessionsDir,
      GSD_WEB_PACKAGE_ROOT: repoRoot,
    },
    spawn: harness.spawn,
    indexWorkspace: async () => fakeWorkspaceIndex(),
    getAutoDashboardData: () => fakeAutoDashboardData(),
  });

  return harness;
}

test("boot and onboarding routes expose locked required state plus explicitly skippable optional setup when auth is missing", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({});
  configureBridgeFixture(fixture, "sess-missing-auth");
  onboarding.configureOnboardingServiceForTests({ authStorage, getEnvApiKey: noEnvApiKey });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const bootResponse = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  assert.equal(bootResponse.status, 200);
  const bootPayload = (await bootResponse.json()) as any;

  assert.equal(bootPayload.onboardingNeeded, true);
  assert.equal(bootPayload.onboarding.status, "blocked");
  assert.equal(bootPayload.onboarding.locked, true);
  assert.equal(bootPayload.onboarding.lockReason, "required_setup");
  assert.equal(bootPayload.onboarding.bridgeAuthRefresh.phase, "idle");
  assert.equal(bootPayload.onboarding.required.satisfied, false);
  assert.equal(bootPayload.onboarding.required.satisfiedBy, null);
  assert.equal(bootPayload.onboarding.optional.skippable, true);
  assert.ok(bootPayload.onboarding.optional.sections.every((section: any) => section.blocking === false));

  const providerIds = bootPayload.onboarding.required.providers.map((provider: any) => provider.id);
  assert.deepEqual(providerIds, [
    "anthropic",
    "openai",
    "github-copilot",
    "openai-codex",
    "google-gemini-cli",
    "google-antigravity",
    "google",
    "groq",
    "xai",
    "openrouter",
    "mistral",
  ]);
  const anthropicProvider = bootPayload.onboarding.required.providers.find((provider: any) => provider.id === "anthropic");
  assert.equal(anthropicProvider.supports.apiKey, true);
  assert.equal(anthropicProvider.supports.oauthAvailable, true);

  const onboardingResponse = await onboardingRoute.GET(projectRequest(fixture.projectCwd, "/api/onboarding"));
  assert.equal(onboardingResponse.status, 200);
  const onboardingPayload = (await onboardingResponse.json()) as any;
  assert.equal(onboardingPayload.onboarding.locked, true);
  assert.equal(onboardingPayload.onboarding.optional.skippable, true);
});

test("runtime env-backed auth unlocks boot onboarding state and reports the environment source", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({});
  const previousGithubToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghu_runtime_env_token";
  configureBridgeFixture(fixture, "sess-env-auth");
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: (provider: string) => (provider === "github-copilot" ? process.env.GITHUB_TOKEN : undefined),
  });

  t.after(async () => {
    if (previousGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
    } else {
    process.env.GITHUB_TOKEN = previousGithubToken;
    }
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const bootResponse = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  assert.equal(bootResponse.status, 200);
  const bootPayload = (await bootResponse.json()) as any;

  assert.equal(bootPayload.onboardingNeeded, false);
  assert.equal(bootPayload.onboarding.locked, false);
  assert.equal(bootPayload.onboarding.lockReason, null);
  assert.equal(bootPayload.onboarding.bridgeAuthRefresh.phase, "idle");
  assert.deepEqual(bootPayload.onboarding.required.satisfiedBy, {
    providerId: "github-copilot",
    source: "environment",
  });
  const copilotProvider = bootPayload.onboarding.required.providers.find((provider: any) => provider.id === "github-copilot");
  assert.equal(copilotProvider.configured, true);
  assert.equal(copilotProvider.configuredVia, "environment");
});

test("failed API-key validation stays locked, redacts the error, and is reflected in boot state without persisting auth", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({});
  configureBridgeFixture(fixture, "sess-validation-failure");
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: noEnvApiKey,
    validateApiKey: async () => ({
      ok: false,
      message: "OpenAI rejected sk-test-secret-123456 because Bearer sk-test-secret-123456 is invalid",
    }),
  });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const validationResponse = await onboardingRoute.POST(
    projectRequest(fixture.projectCwd, "/api/onboarding", {
      method: "POST",
      body: JSON.stringify({
        action: "save_api_key",
        providerId: "openai",
        apiKey: "sk-test-secret-123456",
      }),
    }),
  );

  assert.equal(validationResponse.status, 422);
  const validationPayload = (await validationResponse.json()) as any;
  assert.equal(validationPayload.onboarding.locked, true);
  assert.equal(validationPayload.onboarding.required.satisfied, false);
  assert.equal(validationPayload.onboarding.lastValidation.status, "failed");
  assert.equal(validationPayload.onboarding.lastValidation.providerId, "openai");
  assert.equal(validationPayload.onboarding.lastValidation.persisted, false);
  assert.equal(validationPayload.onboarding.lockReason, "required_setup");
  assert.equal(validationPayload.onboarding.bridgeAuthRefresh.phase, "idle");
  assert.match(validationPayload.onboarding.lastValidation.message, /OpenAI rejected/i);
  assert.doesNotMatch(validationPayload.onboarding.lastValidation.message, /sk-test-secret-123456/);
  assert.equal(authStorage.hasAuth("openai"), false);

  const bootResponse = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  assert.equal(bootResponse.status, 200);
  const bootPayload = (await bootResponse.json()) as any;
  assert.equal(bootPayload.onboarding.locked, true);
  assert.equal(bootPayload.onboarding.lastValidation.status, "failed");
  assert.doesNotMatch(bootPayload.onboarding.lastValidation.message, /sk-test-secret-123456/);
});

test("direct prompt commands cannot bypass onboarding while required setup is still locked", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({});
  const harness = configureBridgeFixture(fixture, "sess-command-locked");
  onboarding.configureOnboardingServiceForTests({ authStorage, getEnvApiKey: noEnvApiKey });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const response = await commandRoute.POST(
    projectRequest(fixture.projectCwd, "/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "prompt", message: "hello from bypass attempt" }),
    }),
  );

  assert.equal(response.status, 423);
  const payload = (await response.json()) as any;
  assert.equal(payload.success, false);
  assert.equal(payload.command, "prompt");
  assert.equal(payload.code, "onboarding_locked");
  assert.equal(payload.details.reason, "required_setup");
  assert.equal(payload.details.onboarding.locked, true);
  assert.equal(harness.spawnCalls, 0);

  const stateResponse = await commandRoute.POST(
    projectRequest(fixture.projectCwd, "/api/session/command", {
      method: "POST",
      body: JSON.stringify({ type: "get_state" }),
    }),
  );
  assert.equal(stateResponse.status, 200);
  const statePayload = (await stateResponse.json()) as any;
  assert.equal(statePayload.success, true);
  assert.equal(statePayload.command, "get_state");
  assert.equal(harness.spawnCalls, 1);
});

test("bridge auth refresh failures remain inspectable and keep the workspace locked after credentials validate", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({});
  configureBridgeFixture(fixture, "sess-refresh-failure");
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: noEnvApiKey,
    validateApiKey: async () => ({ ok: true, message: "openai credentials validated" }),
    refreshBridgeAuth: async () => {
      throw new Error("bridge restart failed for sk-refresh-secret-123456");
    },
  });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const validationResponse = await onboardingRoute.POST(
    projectRequest(fixture.projectCwd, "/api/onboarding", {
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
  assert.match(validationPayload.onboarding.bridgeAuthRefresh.error, /bridge restart failed/i);
  assert.doesNotMatch(validationPayload.onboarding.bridgeAuthRefresh.error, /sk-refresh-secret-123456/);
  assert.equal(authStorage.hasAuth("openai"), true);

  const bootResponse = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  const bootPayload = (await bootResponse.json()) as any;
  assert.equal(bootPayload.onboarding.locked, true);
  assert.equal(bootPayload.onboarding.lockReason, "bridge_refresh_failed");
  assert.equal(bootPayload.onboarding.bridgeAuthRefresh.phase, "failed");
});

test("successful API-key validation persists the credential and unlocks onboarding", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({});
  const harness = configureBridgeFixture(fixture, "sess-validation-success");
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: noEnvApiKey,
    validateApiKey: async () => ({ ok: true, message: "openai credentials validated" }),
  });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const validationResponse = await onboardingRoute.POST(
    projectRequest(fixture.projectCwd, "/api/onboarding", {
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
  assert.deepEqual(validationPayload.onboarding.required.satisfiedBy, {
    providerId: "openai",
    source: "auth_file",
  });
  assert.equal(validationPayload.onboarding.lastValidation.status, "succeeded");
  assert.equal(validationPayload.onboarding.lastValidation.persisted, true);
  assert.equal(validationPayload.onboarding.lockReason, null);
  assert.equal(validationPayload.onboarding.bridgeAuthRefresh.phase, "succeeded");
  assert.equal(authStorage.hasAuth("openai"), true);
  assert.equal(harness.spawnCalls, 1);

  const bootResponse = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  const bootPayload = (await bootResponse.json()) as any;
  assert.equal(bootPayload.onboarding.locked, false);
  assert.equal(bootPayload.onboarding.lockReason, null);
  assert.equal(bootPayload.onboarding.bridgeAuthRefresh.phase, "succeeded");
  assert.equal(bootPayload.onboardingNeeded, false);
});

test("logout_provider removes saved auth, refreshes the bridge, and relocks onboarding when it was the only provider", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({
    openai: { type: "api_key", key: "sk-saved-logout" },
  } as any);
  const harness = configureBridgeFixture(fixture, "sess-logout-success");
  onboarding.configureOnboardingServiceForTests({ authStorage, getEnvApiKey: noEnvApiKey });

  t.after(async () => {
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const bootBefore = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  const bootBeforePayload = (await bootBefore.json()) as any;
  assert.equal(bootBeforePayload.onboarding.locked, false);
  assert.equal(bootBeforePayload.onboarding.required.satisfiedBy.providerId, "openai");
  assert.equal(harness.spawnCalls, 1);

  const logoutResponse = await onboardingRoute.POST(
    projectRequest(fixture.projectCwd, "/api/onboarding", {
      method: "POST",
      body: JSON.stringify({
        action: "logout_provider",
        providerId: "openai",
      }),
    }),
  );

  assert.equal(logoutResponse.status, 200);
  const logoutPayload = (await logoutResponse.json()) as any;
  assert.equal(logoutPayload.onboarding.locked, true);
  assert.equal(logoutPayload.onboarding.lockReason, "required_setup");
  assert.equal(logoutPayload.onboarding.bridgeAuthRefresh.phase, "succeeded");
  assert.equal(logoutPayload.onboarding.lastValidation, null);
  assert.equal(authStorage.hasAuth("openai"), false);
  assert.equal(harness.spawnCalls, 2);

  const bootAfter = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  const bootAfterPayload = (await bootAfter.json()) as any;
  assert.equal(bootAfterPayload.onboarding.locked, true);
  assert.equal(bootAfterPayload.onboarding.lockReason, "required_setup");
  assert.equal(bootAfterPayload.onboarding.bridgeAuthRefresh.phase, "succeeded");
  assert.equal(bootAfterPayload.onboarding.required.satisfied, false);
});

test("logout_provider fails clearly for environment-backed auth that the browser cannot remove", async (t) => {
  const fixture = makeWorkspaceFixture();
  clearOnboardingEnv();
  const authStorage = AuthStorage.inMemory({});
  const previousGithubToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghu_env_only_token";
  configureBridgeFixture(fixture, "sess-logout-env");
  onboarding.configureOnboardingServiceForTests({
    authStorage,
    getEnvApiKey: (provider: string) => (provider === "github-copilot" ? process.env.GITHUB_TOKEN : undefined),
  });

  t.after(async () => {
    if (previousGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
    } else {
    process.env.GITHUB_TOKEN = previousGithubToken;
    }
    onboarding.resetOnboardingServiceForTests();
    await bridge.resetBridgeServiceForTests();
    restoreOnboardingEnv();
    fixture.cleanup();
  });

  const bootBefore = await bootRoute.GET(projectRequest(fixture.projectCwd, "/api/boot"));
  const bootBeforePayload = (await bootBefore.json()) as any;
  assert.equal(bootBeforePayload.onboarding.locked, false);
  assert.equal(bootBeforePayload.onboarding.required.satisfiedBy.providerId, "github-copilot");
  assert.equal(bootBeforePayload.onboarding.required.satisfiedBy.source, "environment");

  const logoutResponse = await onboardingRoute.POST(
    projectRequest(fixture.projectCwd, "/api/onboarding", {
      method: "POST",
      body: JSON.stringify({
        action: "logout_provider",
        providerId: "github-copilot",
      }),
    }),
  );

  assert.equal(logoutResponse.status, 400);
  const logoutPayload = (await logoutResponse.json()) as any;
  assert.match(logoutPayload.error, /cannot be logged out from the browser surface/i);
  assert.equal(logoutPayload.onboarding.locked, false);
  assert.equal(logoutPayload.onboarding.required.satisfiedBy.providerId, "github-copilot");
  assert.equal(logoutPayload.onboarding.required.satisfiedBy.source, "environment");
});
