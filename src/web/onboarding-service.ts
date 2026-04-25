import { randomUUID } from "node:crypto";

import { getEnvApiKey } from "../../packages/pi-ai/src/web-runtime-env-api-keys.ts";
import type { OAuthAuthInfo, OAuthPrompt, OAuthProviderInterface } from "../../packages/pi-ai/dist/oauth.js";
import { authFilePath } from "../app-paths.ts";
import { createOnboardingAuthStorage, type OnboardingAuthStorage as AuthStorageInstance } from "./web-auth-storage.ts";

type RequiredProviderCatalogEntry = {
  id: string;
  label: string;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  supportsExternalCli?: boolean;
  recommended?: boolean;
};

type OptionalSectionCatalogEntry = {
  id: string;
  label: string;
  providers: Array<{ id: string; label: string; envVar?: string }>;
};

type ValidationProbeResult =
  | { ok: true; message?: string }
  | { ok: false; message: string };

type GetEnvApiKeyFn = typeof getEnvApiKey;
type BridgeAuthRefresher = () => Promise<void>;

let onboardingBridgeAuthRefresher: BridgeAuthRefresher | null = null;

type OnboardingServiceDeps = {
  env?: NodeJS.ProcessEnv;
  authPath?: string;
  authStorage?: AuthStorageInstance;
  createAuthStorage?: (authPath: string) => AuthStorageInstance | Promise<AuthStorageInstance>;
  validateApiKey?: (providerId: string, apiKey: string) => Promise<ValidationProbeResult>;
  fetch?: typeof fetch;
  now?: () => Date;
  createFlowId?: () => string;
  getEnvApiKey?: GetEnvApiKeyFn;
  refreshBridgeAuth?: () => Promise<void>;
  isExternalCliProvider?: (providerId: string) => boolean;
};

export type OnboardingCredentialSource = "auth_file" | "environment" | "runtime" | "external_cli";
export type OnboardingValidationStatus = "succeeded" | "failed";
export type OnboardingFlowStatus =
  | "idle"
  | "running"
  | "awaiting_browser_auth"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled";
export type OnboardingLockReason = "required_setup" | "bridge_refresh_pending" | "bridge_refresh_failed";
export type OnboardingBridgeAuthRefreshPhase = "idle" | "pending" | "succeeded" | "failed";

export interface OnboardingProviderState {
  id: string;
  label: string;
  required: true;
  recommended: boolean;
  configured: boolean;
  configuredVia: OnboardingCredentialSource | null;
  supports: {
    apiKey: boolean;
    oauth: boolean;
    oauthAvailable: boolean;
    usesCallbackServer: boolean;
    externalCli: boolean;
  };
}

export interface OnboardingOptionalSectionState {
  id: string;
  label: string;
  blocking: false;
  skippable: true;
  configured: boolean;
  configuredItems: string[];
}

export interface OnboardingValidationResult {
  status: OnboardingValidationStatus;
  providerId: string;
  method: "api_key" | "oauth";
  checkedAt: string;
  message: string;
  persisted: boolean;
}

export interface OnboardingFlowPromptState {
  kind: "text" | "manual_code";
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

export interface OnboardingProviderFlowState {
  flowId: string;
  providerId: string;
  providerLabel: string;
  status: OnboardingFlowStatus;
  updatedAt: string;
  auth: OAuthAuthInfo | null;
  prompt: OnboardingFlowPromptState | null;
  progress: string[];
  error: string | null;
}

export interface OnboardingBridgeAuthRefreshState {
  phase: OnboardingBridgeAuthRefreshPhase;
  strategy: "restart" | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

/**
 * CLI-side onboarding completion record exposed to the web client.
 *
 * Mirrors the JSON written by `src/resources/extensions/gsd/onboarding-state.ts`.
 * Read-only metadata: lets the web UI render "setup complete (date)" indicators
 * and offer a "re-run setup" affordance. Does NOT influence the `locked` flag —
 * lock semantics still depend on whether a required provider is configured.
 */
export interface OnboardingCompletionRecord {
  completedAt: string | null;
  completedSteps: string[];
  skippedSteps: string[];
  lastResumePoint: string | null;
  flowVersion: number;
}

export interface OnboardingState {
  status: "blocked" | "ready";
  locked: boolean;
  lockReason: OnboardingLockReason | null;
  required: {
    blocking: true;
    skippable: false;
    satisfied: boolean;
    satisfiedBy: { providerId: string; source: OnboardingCredentialSource } | null;
    providers: OnboardingProviderState[];
  };
  optional: {
    blocking: false;
    skippable: true;
    sections: OnboardingOptionalSectionState[];
  };
  lastValidation: OnboardingValidationResult | null;
  activeFlow: OnboardingProviderFlowState | null;
  bridgeAuthRefresh: OnboardingBridgeAuthRefreshState;
  /** CLI-side onboarding wizard completion record. Null if never completed. Optional for back-compat with existing fixtures. */
  completionRecord?: OnboardingCompletionRecord | null;
}

type ProviderFlowRuntime = {
  state: OnboardingProviderFlowState;
  awaitingInput: ((value: string) => void) | null;
  abortController: AbortController;
};

/**
 * Ordered catalog of required AI providers shown in the onboarding wizard.
 *
 * **Precedence contract:** `satisfiedBy` is set to the first *configured*
 * provider in this list. Reordering entries changes which provider wins when
 * multiple are configured simultaneously — do so intentionally.
 *
 * ExternalCli providers (those with `supportsExternalCli: true`) are always
 * treated as configured by the onboarding service regardless of auth-file
 * contents, so placing them higher in the list gives them higher precedence.
 */
const REQUIRED_PROVIDER_CATALOG: RequiredProviderCatalogEntry[] = [
  { id: "anthropic", label: "Anthropic (Claude)", supportsApiKey: true, supportsOAuth: false, recommended: true },
  { id: "openai", label: "OpenAI", supportsApiKey: true, supportsOAuth: false },
  { id: "github-copilot", label: "GitHub Copilot", supportsApiKey: false, supportsOAuth: true },
  { id: "openai-codex", label: "ChatGPT Plus/Pro (Codex Subscription)", supportsApiKey: false, supportsOAuth: true },
  { id: "google-gemini-cli", label: "Google Cloud Code Assist (Gemini CLI)", supportsApiKey: false, supportsOAuth: true },
  { id: "google-antigravity", label: "Antigravity (Gemini 3, Claude, GPT-OSS)", supportsApiKey: false, supportsOAuth: true },
  { id: "google", label: "Google (Gemini API)", supportsApiKey: true, supportsOAuth: false },
  { id: "groq", label: "Groq", supportsApiKey: true, supportsOAuth: false },
  { id: "xai", label: "xAI (Grok)", supportsApiKey: true, supportsOAuth: false },
  { id: "openrouter", label: "OpenRouter", supportsApiKey: true, supportsOAuth: false },
  { id: "mistral", label: "Mistral", supportsApiKey: true, supportsOAuth: false },
  { id: "minimax", label: "MiniMax", supportsApiKey: true, supportsOAuth: false },
  { id: "minimax-cn", label: "MiniMax CN", supportsApiKey: true, supportsOAuth: false },
  // Supported by the core provider registry; configured via env/auth today.
  { id: "ollama-cloud", label: "Ollama Cloud", supportsApiKey: false, supportsOAuth: false },
  { id: "custom-openai", label: "Custom (OpenAI-compatible)", supportsApiKey: false, supportsOAuth: false },
  { id: "cerebras", label: "Cerebras", supportsApiKey: false, supportsOAuth: false },
  { id: "azure-openai-responses", label: "Azure OpenAI", supportsApiKey: false, supportsOAuth: false },
  { id: "alibaba-coding-plan", label: "Alibaba Coding Plan", supportsApiKey: false, supportsOAuth: false },
  { id: "alibaba-dashscope", label: "Alibaba DashScope", supportsApiKey: false, supportsOAuth: false },
  { id: "claude-code", label: "Claude Code (Local CLI)", supportsApiKey: false, supportsOAuth: false, supportsExternalCli: true, recommended: true },
];

const OPTIONAL_SECTION_CATALOG: OptionalSectionCatalogEntry[] = [
  {
    id: "web_search",
    label: "Web search",
    providers: [
      { id: "brave", label: "Brave Search", envVar: "BRAVE_API_KEY" },
      { id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY" },
    ],
  },
  {
    id: "tool_keys",
    label: "Tool API keys",
    providers: [
      { id: "context7", label: "Context7", envVar: "CONTEXT7_API_KEY" },
      { id: "jina", label: "Jina AI", envVar: "JINA_API_KEY" },
      { id: "groq", label: "Groq", envVar: "GROQ_API_KEY" },
    ],
  },
  {
    id: "remote_questions",
    label: "Remote questions",
    providers: [
      { id: "discord_bot", label: "Discord", envVar: "DISCORD_BOT_TOKEN" },
      { id: "slack_bot", label: "Slack", envVar: "SLACK_BOT_TOKEN" },
      { id: "telegram_bot", label: "Telegram", envVar: "TELEGRAM_BOT_TOKEN" },
    ],
  },
];

/**
 * ExternalCli providers authenticate through a local CLI tool rather than
 * storing credentials in GSD. They are always treated as "configured" by the
 * onboarding service — if the binary is missing, inference will fail at
 * runtime (the correct place to surface that error).
 *
 * **Sync requirement:** This set must stay in sync with `CLI_AUTH_PROVIDERS`
 * in `src/resources/extensions/gsd/doctor-providers.ts`. If a new ExternalCli
 * provider is added to one set but not the other, onboarding will silently
 * mis-classify it (treating it as unconfigured or vice-versa).
 */
const CLI_AUTH_PROVIDER_IDS = new Set([
  "claude-code",
]);

function defaultIsExternalCliProvider(id: string): boolean {
  return CLI_AUTH_PROVIDER_IDS.has(id);
}

let onboardingServiceOverrides: Partial<OnboardingServiceDeps> | null = null;
let onboardingServiceSingleton: OnboardingService | null = null;

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)["'=:\s]+)([^\s,;"']+)/gi, "$1[redacted]");
}

function sanitizeMessage(message: unknown): string {
  const raw = message instanceof Error ? message.message : String(message);
  return redactSensitiveText(raw).replace(/\s+/g, " ").trim();
}

function createIdleBridgeAuthRefreshState(): OnboardingBridgeAuthRefreshState {
  return {
    phase: "idle",
    strategy: null,
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

function resolveOnboardingLockReason(
  requiredSatisfied: boolean,
  bridgeAuthRefresh: OnboardingBridgeAuthRefreshState,
): OnboardingLockReason | null {
  if (!requiredSatisfied) {
    return "required_setup";
  }
  if (bridgeAuthRefresh.phase === "pending") {
    return "bridge_refresh_pending";
  }
  if (bridgeAuthRefresh.phase === "failed") {
    return "bridge_refresh_failed";
  }
  return null;
}

function hasStoredCredentialValue(authStorage: AuthStorageInstance, providerId: string): boolean {
  return authStorage.getCredentialsForProvider(providerId).some((credential) => {
    if (credential.type === "oauth") {
      return typeof credential.access === "string" && credential.access.trim().length > 0;
    }
    return typeof credential.key === "string" && credential.key.trim().length > 0;
  });
}

function resolveCredentialSource(
  authStorage: AuthStorageInstance,
  providerId: string,
  getEnvApiKeyFn: GetEnvApiKeyFn,
  isExternalCliProviderFn: (id: string) => boolean,
): OnboardingCredentialSource | null {
  // ExternalCli providers authenticate through a local CLI — no credentials
  // are stored in GSD. Treat them as always configured.
  if (isExternalCliProviderFn(providerId)) {
    return "external_cli";
  }
  if (hasStoredCredentialValue(authStorage, providerId)) {
    return "auth_file";
  }
  if (getEnvApiKeyFn(providerId)) {
    return "environment";
  }
  return null;
}

function extractErrorDetail(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const candidates = [record.message, record.error, record.detail, record.error_description];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
    const nested = extractErrorDetail(candidate);
    if (nested) return nested;
  }
  return null;
}

async function parseFailureMessage(providerId: string, response: Response): Promise<string> {
  let detail = "";

  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      detail = extractErrorDetail(payload) ?? JSON.stringify(payload);
    } else {
      detail = await response.text();
    }
  } catch {
    detail = "";
  }

  const sanitizedDetail = sanitizeMessage(detail);
  return sanitizedDetail
    ? `${providerId} validation failed (${response.status}): ${sanitizedDetail}`
    : `${providerId} validation failed (${response.status})`;
}

async function validateBearerRequest(
  fetchImpl: typeof fetch,
  providerId: string,
  url: string,
  apiKey: string,
  extraHeaders: Record<string, string> = {},
): Promise<ValidationProbeResult> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage(providerId, response) };
    }

    return { ok: true, message: `${providerId} credentials validated` };
  } catch (error) {
    return { ok: false, message: `${providerId} validation failed: ${sanitizeMessage(error)}` };
  }
}

async function validateGoogleApiKey(fetchImpl: typeof fetch, apiKey: string): Promise<ValidationProbeResult> {
  try {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage("google", response) };
    }
    return { ok: true, message: "google credentials validated" };
  } catch (error) {
    return { ok: false, message: `google validation failed: ${sanitizeMessage(error)}` };
  }
}

async function validateAnthropicApiKey(fetchImpl: typeof fetch, apiKey: string): Promise<ValidationProbeResult> {
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage("anthropic", response) };
    }

    return { ok: true, message: "anthropic credentials validated" };
  } catch (error) {
    return { ok: false, message: `anthropic validation failed: ${sanitizeMessage(error)}` };
  }
}

async function validateAnthropicCompatibleApiKey(
  fetchImpl: typeof fetch,
  providerId: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<ValidationProbeResult> {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return { ok: false, message: await parseFailureMessage(providerId, response) };
    }

    return { ok: true, message: `${providerId} credentials validated` };
  } catch (error) {
    return { ok: false, message: `${providerId} validation failed: ${sanitizeMessage(error)}` };
  }
}

async function defaultValidateApiKey(
  providerId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<ValidationProbeResult> {
  switch (providerId) {
    case "anthropic":
      return await validateAnthropicApiKey(fetchImpl, apiKey);
    case "openai":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.openai.com/v1/models", apiKey);
    case "google":
      return await validateGoogleApiKey(fetchImpl, apiKey);
    case "groq":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.groq.com/openai/v1/models", apiKey);
    case "xai":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.x.ai/v1/models", apiKey);
    case "openrouter":
      return await validateBearerRequest(fetchImpl, providerId, "https://openrouter.ai/api/v1/models", apiKey, {
        "HTTP-Referer": "https://localhost",
        "X-Title": "GSD onboarding",
      });
    case "mistral":
      return await validateBearerRequest(fetchImpl, providerId, "https://api.mistral.ai/v1/models", apiKey);
    case "minimax":
      return await validateAnthropicCompatibleApiKey(
        fetchImpl,
        providerId,
        apiKey,
        "https://api.minimax.io/anthropic",
        "MiniMax-M2.7",
      );
    case "minimax-cn":
      return await validateAnthropicCompatibleApiKey(
        fetchImpl,
        providerId,
        apiKey,
        "https://api.minimaxi.com/anthropic",
        "MiniMax-M2.7",
      );
    default:
      return { ok: false, message: `${providerId} does not support API-key validation via onboarding` };
  }
}

function resolveRuntimeTestIsExternalCliProvider(env: NodeJS.ProcessEnv): OnboardingServiceDeps["isExternalCliProvider"] | undefined {
  if (env.GSD_WEB_TEST_DISABLE_EXTERNAL_CLI !== "1") {
    return undefined;
  }
  return () => false;
}

function resolveRuntimeTestValidateApiKey(env: NodeJS.ProcessEnv): OnboardingServiceDeps["validateApiKey"] | undefined {
  if (env.GSD_WEB_TEST_FAKE_API_KEY_VALIDATION !== "1") {
    return undefined;
  }

  return async (providerId: string, apiKey: string) => {
    const providerLabel = REQUIRED_PROVIDER_CATALOG.find((entry) => entry.id === providerId)?.label ?? providerId;
    const candidate = apiKey.trim().toLowerCase();
    if (!candidate || candidate.includes("invalid") || candidate.includes("reject") || candidate.includes("fail")) {
      return {
        ok: false,
        message: `${providerLabel} rejected the supplied key`,
      };
    }

    return {
      ok: true,
      message: `${providerLabel} credentials validated`,
    };
  };
}

function getOnboardingDeps(): OnboardingServiceDeps {
  return {
    env: process.env,
    authPath: authFilePath,
    fetch,
    now: () => new Date(),
    createFlowId: () => randomUUID(),
    validateApiKey: resolveRuntimeTestValidateApiKey(process.env),
    isExternalCliProvider: resolveRuntimeTestIsExternalCliProvider(process.env),
    refreshBridgeAuth: onboardingBridgeAuthRefresher ?? undefined,
    ...(onboardingServiceOverrides ?? {}),
  };
}

export class OnboardingService {
  private readonly deps: OnboardingServiceDeps;
  private authStorage: AuthStorageInstance | null = null;
  private lastValidation: OnboardingValidationResult | null = null;
  private activeFlow: ProviderFlowRuntime | null = null;
  private bridgeAuthRefresh: OnboardingBridgeAuthRefreshState = createIdleBridgeAuthRefreshState();

  constructor(deps: OnboardingServiceDeps) {
    this.deps = deps;
  }

  async getState(): Promise<OnboardingState> {
    return this.buildState();
  }

  async validateAndSaveApiKey(providerId: string, apiKey: string): Promise<OnboardingState> {
    const provider = REQUIRED_PROVIDER_CATALOG.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new Error(`Unknown onboarding provider: ${providerId}`);
    }
    if (!provider.supportsApiKey) {
      throw new Error(`${providerId} must be configured with browser sign-in`);
    }

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      throw new Error("API key is required");
    }

    const validateApiKey =
      this.deps.validateApiKey ??
      (async (candidateProviderId: string, candidateApiKey: string) =>
        await defaultValidateApiKey(candidateProviderId, candidateApiKey, this.deps.fetch ?? fetch));

    const validation = await validateApiKey(providerId, trimmedKey);
    const checkedAt = nowIso(this.deps.now ?? (() => new Date()));

    if (!validation.ok) {
      this.lastValidation = {
        status: "failed",
        providerId,
        method: "api_key",
        checkedAt,
        message: sanitizeMessage(validation.message),
        persisted: false,
      };
      return await this.buildState();
    }

    const authStorage = await this.getAuthStorage();
    authStorage.reload();
    authStorage.set(providerId, { type: "api_key", key: trimmedKey });
    this.lastValidation = {
      status: "succeeded",
      providerId,
      method: "api_key",
      checkedAt,
      message: sanitizeMessage(validation.message || `${providerId} credentials validated`),
      persisted: true,
    };
    await this.refreshBridgeAuth();

    return await this.buildState();
  }

  async startProviderFlow(providerId: string): Promise<OnboardingState> {
    const authStorage = await this.getAuthStorage();
    authStorage.reload();

    const oauthProvider = authStorage.getOAuthProviders().find((provider) => provider.id === providerId);
    if (!oauthProvider) {
      throw new Error(`OAuth provider not available for onboarding: ${providerId}`);
    }

    if (this.activeFlow && ["running", "awaiting_browser_auth", "awaiting_input"].includes(this.activeFlow.state.status)) {
      this.cancelActiveFlow();
    }

    const runtime: ProviderFlowRuntime = {
      state: {
        flowId: (this.deps.createFlowId ?? (() => randomUUID()))(),
        providerId,
        providerLabel: oauthProvider.name,
        status: "running",
        updatedAt: nowIso(this.deps.now ?? (() => new Date())),
        auth: null,
        prompt: null,
        progress: [],
        error: null,
      },
      awaitingInput: null,
      abortController: new AbortController(),
    };

    this.activeFlow = runtime;
    void this.runOAuthFlow(runtime, oauthProvider, authStorage);
    return await this.buildState();
  }

  async submitProviderFlowInput(flowId: string, input: string): Promise<OnboardingState> {
    const runtime = this.activeFlow;
    if (!runtime || runtime.state.flowId !== flowId) {
      throw new Error(`Unknown onboarding flow: ${flowId}`);
    }
    if (!runtime.awaitingInput) {
      throw new Error(`Onboarding flow ${flowId} is not waiting for input`);
    }

    const resolveInput = runtime.awaitingInput;
    runtime.awaitingInput = null;
    runtime.state.prompt = null;
    runtime.state.status = "running";
    runtime.state.updatedAt = nowIso(this.deps.now ?? (() => new Date()));
    resolveInput(input);

    return await this.buildState();
  }

  async cancelProviderFlow(flowId: string): Promise<OnboardingState> {
    const runtime = this.activeFlow;
    if (!runtime || runtime.state.flowId !== flowId) {
      throw new Error(`Unknown onboarding flow: ${flowId}`);
    }

    this.cancelActiveFlow();
    return await this.buildState();
  }

  async logoutProvider(providerId: string): Promise<OnboardingState> {
    const authStorage = await this.getAuthStorage();
    authStorage.reload();

    const currentState = await this.buildState();
    const requestedProviderId = providerId.trim();
    const resolvedProviderId =
      requestedProviderId ||
      currentState.required.satisfiedBy?.providerId ||
      currentState.required.providers.find((provider) => provider.configured)?.id;

    if (!resolvedProviderId) {
      throw new Error("No configured provider is available to log out");
    }

    const providerState = currentState.required.providers.find((provider) => provider.id === resolvedProviderId);
    const providerLabel = providerState?.label ?? resolvedProviderId;

    if (!providerState?.configured) {
      throw new Error(`${providerLabel} is not configured in this workspace`);
    }

    if (providerState.configuredVia !== "auth_file") {
      throw new Error(`${providerLabel} is configured via ${providerState.configuredVia} and cannot be logged out from the browser surface`);
    }

    if (
      this.activeFlow &&
      this.activeFlow.state.providerId === resolvedProviderId &&
      ["running", "awaiting_browser_auth", "awaiting_input"].includes(this.activeFlow.state.status)
    ) {
      this.cancelActiveFlow();
    }

    authStorage.logout(resolvedProviderId);
    this.lastValidation = null;
    await this.refreshBridgeAuth();
    return await this.buildState();
  }

  private async refreshBridgeAuth(): Promise<void> {
    const refreshBridgeAuth = this.deps.refreshBridgeAuth;
    if (!refreshBridgeAuth) {
      this.bridgeAuthRefresh = createIdleBridgeAuthRefreshState();
      return;
    }

    const startedAt = nowIso(this.deps.now ?? (() => new Date()));
    this.bridgeAuthRefresh = {
      phase: "pending",
      strategy: "restart",
      startedAt,
      completedAt: null,
      error: null,
    };

    try {
      await refreshBridgeAuth();
      this.bridgeAuthRefresh = {
        phase: "succeeded",
        strategy: "restart",
        startedAt,
        completedAt: nowIso(this.deps.now ?? (() => new Date())),
        error: null,
      };
    } catch (error) {
      this.bridgeAuthRefresh = {
        phase: "failed",
        strategy: "restart",
        startedAt,
        completedAt: nowIso(this.deps.now ?? (() => new Date())),
        error: sanitizeMessage(error),
      };
    }
  }

  private async getAuthStorage(): Promise<AuthStorageInstance> {
    if (!this.authStorage) {
      if (this.deps.authStorage) {
        this.authStorage = this.deps.authStorage;
      } else if (this.deps.createAuthStorage) {
        this.authStorage = await this.deps.createAuthStorage(this.deps.authPath ?? authFilePath);
      } else {
        this.authStorage = createOnboardingAuthStorage(this.deps.authPath ?? authFilePath);
      }
    }
    return this.authStorage;
  }

  private buildOptionalSectionState(authStorage: AuthStorageInstance): OnboardingOptionalSectionState[] {
    const env = this.deps.env ?? process.env;

    return OPTIONAL_SECTION_CATALOG.map((section) => {
      const configuredItems = section.providers
        .filter((provider) => {
          const envConfigured = provider.envVar ? typeof env[provider.envVar] === "string" && env[provider.envVar]!.trim().length > 0 : false;
          const storedConfigured = hasStoredCredentialValue(authStorage, provider.id);
          return envConfigured || storedConfigured;
        })
        .map((provider) => provider.label);

      return {
        id: section.id,
        label: section.label,
        blocking: false,
        skippable: true,
        configured: configuredItems.length > 0,
        configuredItems,
      };
    });
  }

  private buildProviderState(
    authStorage: AuthStorageInstance,
    getEnvApiKeyFn: GetEnvApiKeyFn,
  ): OnboardingProviderState[] {
    const oauthProviders = new Map(authStorage.getOAuthProviders().map((provider) => [provider.id, provider]));
    const isExternalCliProviderFn = this.deps.isExternalCliProvider ?? defaultIsExternalCliProvider;

    return REQUIRED_PROVIDER_CATALOG.map((provider) => {
      const oauthProvider = oauthProviders.get(provider.id);
      const configuredVia = resolveCredentialSource(authStorage, provider.id, getEnvApiKeyFn, isExternalCliProviderFn);
      return {
        id: provider.id,
        label: oauthProvider?.name ?? provider.label,
        required: true,
        recommended: Boolean(provider.recommended),
        configured: configuredVia !== null,
        configuredVia,
        supports: {
          apiKey: provider.supportsApiKey,
          oauth: provider.supportsOAuth,
          oauthAvailable: provider.supportsOAuth ? Boolean(oauthProvider) : false,
          usesCallbackServer: Boolean(oauthProvider?.usesCallbackServer),
          externalCli: Boolean(provider.supportsExternalCli),
        },
      };
    });
  }

  private async buildState(): Promise<OnboardingState> {
    const authStorage = await this.getAuthStorage();
    const getEnvApiKeyFn = this.deps.getEnvApiKey ?? getEnvApiKey;
    authStorage.reload();

    const providers = this.buildProviderState(authStorage, getEnvApiKeyFn);
    const satisfiedByProvider = providers.find((provider) => provider.configured) ?? null;
    const optionalSections = this.buildOptionalSectionState(authStorage);
    const lockReason = resolveOnboardingLockReason(Boolean(satisfiedByProvider), this.bridgeAuthRefresh);

    // Read CLI-side completion record (best-effort — never throw)
    let completionRecord: OnboardingCompletionRecord | null = null;
    try {
      const { readOnboardingRecord, isOnboardingComplete } = await import(
        "../resources/extensions/gsd/onboarding-state.js"
      );
      const r = readOnboardingRecord();
      completionRecord = {
        completedAt: isOnboardingComplete() ? r.completedAt : null,
        completedSteps: r.completedSteps,
        skippedSteps: r.skippedSteps,
        lastResumePoint: r.lastResumePoint,
        flowVersion: r.flowVersion,
      };
    } catch {
      completionRecord = null;
    }

    return {
      status: lockReason ? "blocked" : "ready",
      locked: lockReason !== null,
      lockReason,
      required: {
        blocking: true,
        skippable: false,
        satisfied: Boolean(satisfiedByProvider),
        satisfiedBy: satisfiedByProvider
          ? {
              providerId: satisfiedByProvider.id,
              source: satisfiedByProvider.configuredVia ?? "runtime",
            }
          : null,
        providers,
      },
      optional: {
        blocking: false,
        skippable: true,
        sections: optionalSections,
      },
      lastValidation: this.lastValidation ? { ...this.lastValidation } : null,
      activeFlow: this.activeFlow ? structuredClone(this.activeFlow.state) : null,
      bridgeAuthRefresh: { ...this.bridgeAuthRefresh },
      completionRecord,
    };
  }

  private cancelActiveFlow(): void {
    if (!this.activeFlow) return;
    this.activeFlow.abortController.abort();
    if (this.activeFlow.awaitingInput) {
      this.activeFlow.awaitingInput("");
      this.activeFlow.awaitingInput = null;
    }
    this.activeFlow.state.status = "cancelled";
    this.activeFlow.state.prompt = null;
    this.activeFlow.state.error = null;
    this.activeFlow.state.updatedAt = nowIso(this.deps.now ?? (() => new Date()));
  }

  private async runOAuthFlow(
    runtime: ProviderFlowRuntime,
    provider: OAuthProviderInterface,
    authStorage: AuthStorageInstance,
  ): Promise<void> {
    try {
      await authStorage.login(provider.id, {
        onAuth: (info) => {
          runtime.state.auth = info;
          runtime.state.status = "awaiting_browser_auth";
          runtime.state.updatedAt = nowIso(this.deps.now ?? (() => new Date()));
        },
        onPrompt: async (prompt) => await this.waitForFlowInput(runtime, "text", prompt),
        onProgress: (message) => {
          runtime.state.progress = [...runtime.state.progress, sanitizeMessage(message)].slice(-20);
          if (runtime.state.status !== "awaiting_input") {
            runtime.state.status = "running";
          }
          runtime.state.updatedAt = nowIso(this.deps.now ?? (() => new Date()));
        },
        onManualCodeInput: async () =>
          await this.waitForFlowInput(runtime, "manual_code", {
            message: "Paste the redirect URL from your browser:",
            placeholder: "http://localhost:...",
          }),
        signal: runtime.abortController.signal,
      });

      runtime.state.status = "succeeded";
      runtime.state.prompt = null;
      runtime.state.error = null;
      runtime.state.updatedAt = nowIso(this.deps.now ?? (() => new Date()));
      this.lastValidation = {
        status: "succeeded",
        providerId: provider.id,
        method: "oauth",
        checkedAt: runtime.state.updatedAt,
        message: `${provider.id} sign-in complete`,
        persisted: true,
      };
      await this.refreshBridgeAuth();
    } catch (error) {
      const cancelled = runtime.abortController.signal.aborted;
      runtime.state.status = cancelled ? "cancelled" : "failed";
      runtime.state.prompt = null;
      runtime.state.error = cancelled ? null : sanitizeMessage(error);
      runtime.state.updatedAt = nowIso(this.deps.now ?? (() => new Date()));
      if (!cancelled) {
        this.lastValidation = {
          status: "failed",
          providerId: provider.id,
          method: "oauth",
          checkedAt: runtime.state.updatedAt,
          message: runtime.state.error || `${provider.id} sign-in failed`,
          persisted: false,
        };
      }
    }
  }

  private async waitForFlowInput(
    runtime: ProviderFlowRuntime,
    kind: OnboardingFlowPromptState["kind"],
    prompt: OAuthPrompt,
  ): Promise<string> {
    runtime.state.status = "awaiting_input";
    runtime.state.prompt = {
      kind,
      message: prompt.message,
      placeholder: prompt.placeholder,
      allowEmpty: prompt.allowEmpty,
    };
    runtime.state.updatedAt = nowIso(this.deps.now ?? (() => new Date()));

    return await new Promise<string>((resolve) => {
      runtime.awaitingInput = resolve;
    });
  }
}

export function getOnboardingService(): OnboardingService {
  if (!onboardingServiceSingleton) {
    onboardingServiceSingleton = new OnboardingService(getOnboardingDeps());
  }
  return onboardingServiceSingleton;
}

export async function collectOnboardingState(): Promise<OnboardingState> {
  return await getOnboardingService().getState();
}

export function registerOnboardingBridgeAuthRefresher(refresher: BridgeAuthRefresher | null): void {
  onboardingBridgeAuthRefresher = refresher;
  onboardingServiceSingleton = null;
}

export function configureOnboardingServiceForTests(overrides: Partial<OnboardingServiceDeps> | null): void {
  onboardingServiceOverrides = overrides;
  onboardingServiceSingleton = null;
}

export function resetOnboardingServiceForTests(): void {
  onboardingServiceOverrides = null;
  onboardingServiceSingleton = null;
}
