/**
 * API Key Manager — /gsd keys
 *
 * Comprehensive CLI for managing API keys: list, add, remove, test, rotate, doctor.
 * Works with AuthStorage from pi-coding-agent — no core package changes needed.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import {
  AuthStorage,
  type AuthCredential,
  type ApiKeyCredential,
  type OAuthCredential,
} from "@gsd/pi-coding-agent";
import { getEnvApiKey } from "@gsd/pi-ai";
import { existsSync, statSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { getErrorMessage } from "./error-utils.js";

// ─── Provider Registry ─────────────────────────────────────────────────────────

export type ProviderCategory = "llm" | "tool" | "search" | "remote";

export interface ProviderInfo {
  id: string;
  label: string;
  category: ProviderCategory;
  envVar?: string;
  prefixes?: string[];
  hasOAuth?: boolean;
  dashboardUrl?: string;
}

export const PROVIDER_REGISTRY: ProviderInfo[] = [
  // LLM Providers
  { id: "anthropic",        label: "Anthropic (Claude)",      category: "llm", envVar: "ANTHROPIC_API_KEY",      prefixes: ["sk-ant-"], hasOAuth: true, dashboardUrl: "console.anthropic.com" },
  { id: "openai",           label: "OpenAI",                  category: "llm", envVar: "OPENAI_API_KEY",         prefixes: ["sk-"],     dashboardUrl: "platform.openai.com/api-keys" },
  { id: "github-copilot",   label: "GitHub Copilot",          category: "llm", envVar: "GITHUB_TOKEN",           hasOAuth: true },
  { id: "openai-codex",     label: "ChatGPT Plus/Pro (Codex)",category: "llm",                                   hasOAuth: true },
  { id: "google-gemini-cli",label: "Google Gemini CLI",       category: "llm",                                   hasOAuth: true },
  { id: "google-antigravity",label: "Antigravity",            category: "llm",                                   hasOAuth: true },
  { id: "google",           label: "Google (Gemini)",         category: "llm", envVar: "GEMINI_API_KEY",         dashboardUrl: "aistudio.google.com/apikey" },
  { id: "groq",             label: "Groq",                    category: "llm", envVar: "GROQ_API_KEY",           dashboardUrl: "console.groq.com" },
  { id: "xai",              label: "xAI (Grok)",              category: "llm", envVar: "XAI_API_KEY",            dashboardUrl: "console.x.ai" },
  { id: "openrouter",       label: "OpenRouter",              category: "llm", envVar: "OPENROUTER_API_KEY",     dashboardUrl: "openrouter.ai/keys" },
  { id: "mistral",          label: "Mistral",                 category: "llm", envVar: "MISTRAL_API_KEY",        dashboardUrl: "console.mistral.ai" },
  { id: "ollama-cloud",     label: "Ollama Cloud",            category: "llm", envVar: "OLLAMA_API_KEY" },
  { id: "custom-openai",    label: "Custom (OpenAI-compat)",  category: "llm", envVar: "CUSTOM_OPENAI_API_KEY" },
  { id: "cerebras",         label: "Cerebras",                category: "llm", envVar: "CEREBRAS_API_KEY" },
  { id: "azure-openai-responses", label: "Azure OpenAI",      category: "llm", envVar: "AZURE_OPENAI_API_KEY" },
  { id: "alibaba-coding-plan", label: "Alibaba Coding Plan",  category: "llm", envVar: "ALIBABA_API_KEY",      dashboardUrl: "bailian.console.aliyun.com" },
  { id: "alibaba-dashscope",   label: "Alibaba DashScope",    category: "llm", envVar: "DASHSCOPE_API_KEY",    dashboardUrl: "dashscope.console.aliyun.com" },

  // Tool Keys
  { id: "context7",  label: "Context7 Docs",     category: "tool", envVar: "CONTEXT7_API_KEY",  dashboardUrl: "context7.com/dashboard" },
  { id: "jina",      label: "Jina Page Extract",  category: "tool", envVar: "JINA_API_KEY",      dashboardUrl: "jina.ai/api" },

  // Search Providers
  { id: "tavily",    label: "Tavily Search",      category: "search", envVar: "TAVILY_API_KEY",  dashboardUrl: "tavily.com/app/api-keys" },
  { id: "brave",     label: "Brave Search",       category: "search", envVar: "BRAVE_API_KEY",   dashboardUrl: "brave.com/search/api" },

  // Remote Integrations
  { id: "discord_bot",  label: "Discord Bot",     category: "remote", envVar: "DISCORD_BOT_TOKEN" },
  { id: "slack_bot",    label: "Slack Bot",        category: "remote", envVar: "SLACK_BOT_TOKEN",   prefixes: ["xoxb-"] },
  { id: "telegram_bot", label: "Telegram Bot",     category: "remote", envVar: "TELEGRAM_BOT_TOKEN" },
];

// ─── Utilities ──────────────────────────────────────────────────────────────────

/**
 * Mask an API key for display: show first 4 + last 4 chars.
 * Keys shorter than 12 chars show only first 2 + last 2.
 */
export function maskKey(key: string): string {
  if (!key) return "(empty)";
  if (key.length <= 8) return key.slice(0, 2) + "***" + key.slice(-2);
  return key.slice(0, 4) + "***" + key.slice(-4);
}

/**
 * Format a duration in milliseconds to human-readable.
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

/**
 * Describe a credential's type and status.
 */
export function describeCredential(cred: AuthCredential): string {
  if (cred.type === "api_key") {
    const apiCred = cred as ApiKeyCredential;
    if (!apiCred.key) return "empty key";
    return `API key (${maskKey(apiCred.key)})`;
  }
  if (cred.type === "oauth") {
    const oauthCred = cred as OAuthCredential;
    const remaining = oauthCred.expires - Date.now();
    if (remaining <= 0) return "OAuth (expired — will auto-refresh)";
    return `OAuth (expires in ${formatDuration(remaining)})`;
  }
  return "unknown";
}

/**
 * Get the auth.json path.
 */
export function getAuthPath(): string {
  return join(process.env.HOME ?? "~", ".gsd", "agent", "auth.json");
}

/**
 * Create an AuthStorage instance for key management.
 */
export function getKeyManagerAuthStorage(): AuthStorage {
  const authPath = getAuthPath();
  mkdirSync(dirname(authPath), { recursive: true });
  return AuthStorage.create(authPath);
}

/**
 * Look up a provider by ID (case-insensitive).
 */
export function findProvider(idOrLabel: string): ProviderInfo | undefined {
  const lower = idOrLabel.toLowerCase();
  return PROVIDER_REGISTRY.find(
    (p) => p.id.toLowerCase() === lower || p.label.toLowerCase() === lower,
  );
}

// ─── Key Status / List ──────────────────────────────────────────────────────────

export interface KeyStatus {
  provider: ProviderInfo;
  configured: boolean;
  source: "auth.json" | "env" | "none";
  credentialCount: number;
  description: string;
  backedOff: boolean;
}

/**
 * Get the status of all known providers.
 */
export function getAllKeyStatuses(auth: AuthStorage): KeyStatus[] {
  return PROVIDER_REGISTRY.map((provider) => {
    const rawCreds = auth.getCredentialsForProvider(provider.id);
    // Filter out empty-key entries (left by legacy removeProviderToken or skipped onboarding)
    const creds = rawCreds.filter((c) => !(c.type === "api_key" && !(c as ApiKeyCredential).key));
    const envKey = provider.envVar ? process.env[provider.envVar] : undefined;

    if (creds.length > 0) {
      const firstCred = creds[0];
      const desc =
        creds.length > 1
          ? `${creds.length} keys (round-robin)`
          : describeCredential(firstCred);
      return {
        provider,
        configured: true,
        source: "auth.json" as const,
        credentialCount: creds.length,
        description: desc,
        backedOff: auth.areAllCredentialsBackedOff(provider.id),
      };
    }

    if (envKey) {
      return {
        provider,
        configured: true,
        source: "env" as const,
        credentialCount: 1,
        description: `env ${provider.envVar}`,
        backedOff: false,
      };
    }

    return {
      provider,
      configured: false,
      source: "none" as const,
      credentialCount: 0,
      description: provider.dashboardUrl
        ? `not configured (${provider.dashboardUrl})`
        : provider.envVar
          ? `not configured (env: ${provider.envVar})`
          : "not configured",
      backedOff: false,
    };
  });
}

/**
 * Format statuses into a grouped dashboard string.
 */
export function formatKeyDashboard(statuses: KeyStatus[]): string {
  const categories: { label: string; key: ProviderCategory }[] = [
    { label: "LLM Providers", key: "llm" },
    { label: "Search Providers", key: "search" },
    { label: "Tool Keys", key: "tool" },
    { label: "Remote Integrations", key: "remote" },
  ];

  const lines: string[] = ["GSD API Key Manager\n"];

  for (const cat of categories) {
    const items = statuses.filter((s) => s.provider.category === cat.key);
    if (items.length === 0) continue;

    lines.push(`  ${cat.label}`);
    for (const item of items) {
      const icon = item.configured ? "✓" : "✗";
      const backoff = item.backedOff ? " [backed off]" : "";
      const pad = item.provider.id.padEnd(20);
      lines.push(`  ${icon} ${pad} — ${item.description}${backoff}`);
    }
    lines.push("");
  }

  // Summary
  const configured = statuses.filter((s) => s.configured);
  const fromAuth = configured.filter((s) => s.source === "auth.json");
  const fromEnv = configured.filter((s) => s.source === "env");
  const oauthCount = statuses.filter((s) => {
    if (!s.configured || s.source !== "auth.json") return false;
    return s.description.startsWith("OAuth");
  }).length;

  const parts: string[] = [];
  parts.push(`${configured.length} configured`);
  if (fromAuth.length > 0) parts.push(`${fromAuth.length} in auth.json`);
  if (fromEnv.length > 0) parts.push(`${fromEnv.length} from env`);
  if (oauthCount > 0) parts.push(`${oauthCount} OAuth`);

  lines.push(`  Source: ${getAuthPath()}`);
  lines.push(`  ${parts.join(" | ")}`);

  return lines.join("\n");
}

// ─── Add Key ────────────────────────────────────────────────────────────────────

/**
 * Add a key interactively.
 */
export async function handleAddKey(
  providerArg: string,
  ctx: ExtensionCommandContext,
  auth: AuthStorage,
): Promise<boolean> {
  let provider: ProviderInfo | undefined;

  if (providerArg) {
    provider = findProvider(providerArg);
    if (!provider) {
      ctx.ui.notify(`Unknown provider: "${providerArg}". Use /gsd keys list to see available providers.`, "error");
      return false;
    }
  } else {
    // Interactive provider picker
    const options = PROVIDER_REGISTRY.map((p) => {
      const creds = auth.getCredentialsForProvider(p.id).filter((c) => !(c.type === "api_key" && !(c as ApiKeyCredential).key));
      const existing = creds.length > 0 ? " (configured)" : "";
      return `[${p.category}] ${p.label}${existing}`;
    });
    const choice = await ctx.ui.select("Add key for which provider?", options);
    if (!choice || typeof choice !== "string") return false;

    const idx = options.indexOf(choice);
    if (idx === -1) return false;
    provider = PROVIDER_REGISTRY[idx];
  }

  // If OAuth is available, offer choice
  if (provider.hasOAuth) {
    const methods = ["API key", "Browser login (OAuth)"];
    const method = await ctx.ui.select(
      `${provider.label} — how do you want to authenticate?`,
      methods,
    );
    if (!method || typeof method !== "string") return false;

    if (method.includes("OAuth")) {
      ctx.ui.notify(
        `Use /login to authenticate via OAuth with ${provider.label}.\n` +
        `The /login command handles the full browser flow.`,
        "info",
      );
      return false;
    }
  }

  // API key input
  const input = await ctx.ui.input(
    `API key for ${provider.label}:`,
    provider.envVar ? `or set ${provider.envVar} env var` : "paste your key here",
  );

  if (input === null || input === undefined) return false;
  const key = input.trim();
  if (!key) {
    ctx.ui.notify("No key provided.", "warning");
    return false;
  }

  // Prefix validation
  if (provider.prefixes && provider.prefixes.length > 0) {
    const valid = provider.prefixes.some((pfx) => key.startsWith(pfx));
    if (!valid) {
      ctx.ui.notify(
        `Warning: key doesn't start with expected prefix (${provider.prefixes.join(" or ")}). Saving anyway.`,
        "warning",
      );
    }
  }

  auth.set(provider.id, { type: "api_key", key });
  if (provider.envVar) {
    process.env[provider.envVar] = key;
  }

  ctx.ui.notify(`Key saved for ${provider.label}: ${maskKey(key)}`, "success");
  return true;
}

// ─── Remove Key ─────────────────────────────────────────────────────────────────

/**
 * Remove a key interactively.
 */
export async function handleRemoveKey(
  providerArg: string,
  ctx: ExtensionCommandContext,
  auth: AuthStorage,
): Promise<boolean> {
  let provider: ProviderInfo | undefined;

  if (providerArg) {
    provider = findProvider(providerArg);
    if (!provider) {
      ctx.ui.notify(`Unknown provider: "${providerArg}".`, "error");
      return false;
    }
  } else {
    // Show only configured providers
    const configured = PROVIDER_REGISTRY.filter((p) => {
      const creds = auth.getCredentialsForProvider(p.id).filter((c) => !(c.type === "api_key" && !(c as ApiKeyCredential).key));
      return creds.length > 0;
    });

    if (configured.length === 0) {
      ctx.ui.notify("No keys configured to remove.", "info");
      return false;
    }

    const options = configured.map((p) => p.label);
    const choice = await ctx.ui.select("Remove key for which provider?", options);
    if (!choice || typeof choice !== "string") return false;

    provider = configured.find((p) => p.label === choice);
    if (!provider) return false;
  }

  const creds = auth.getCredentialsForProvider(provider.id);
  if (creds.length === 0) {
    ctx.ui.notify(`No keys found for ${provider.label}.`, "info");
    return false;
  }

  // Multi-key handling
  if (creds.length > 1) {
    const options = creds.map((c, i) => `[${i + 1}] ${describeCredential(c)}`);
    options.push("Remove all");

    const choice = await ctx.ui.select(
      `${provider.label} has ${creds.length} keys. Remove which?`,
      options,
    );
    if (!choice || typeof choice !== "string") return false;

    if (choice === "Remove all") {
      auth.remove(provider.id);
    } else {
      // Remove specific index — need to rebuild the array without that entry
      const idx = options.indexOf(choice);
      if (idx === -1 || idx >= creds.length) return false;
      const remaining = creds.filter((_, i) => i !== idx);
      auth.remove(provider.id);
      for (const c of remaining) {
        auth.set(provider.id, c);
      }
    }
  } else {
    const confirmed = await ctx.ui.confirm(
      "Remove key?",
      `Remove ${describeCredential(creds[0])} for ${provider.label}?`,
    );
    if (!confirmed) return false;
    auth.remove(provider.id);
  }

  // Clear env var
  if (provider.envVar && process.env[provider.envVar]) {
    delete process.env[provider.envVar];
  }

  ctx.ui.notify(`Key removed for ${provider.label}.`, "success");
  return true;
}

// ─── Test Key ───────────────────────────────────────────────────────────────────

export interface TestResult {
  provider: ProviderInfo;
  status: "valid" | "invalid" | "rate_limited" | "error" | "skipped";
  message: string;
  latencyMs?: number;
}

/** Test endpoint configurations per provider */
const TEST_ENDPOINTS: Record<string, { url: string; method?: string; headers?: (key: string) => Record<string, string>; body?: string }> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }),
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: (key) => ({ "x-goog-api-key": key }),
  },
  groq: {
    url: "https://api.groq.com/openai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  brave: {
    url: "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
    headers: (key) => ({ "X-Subscription-Token": key }),
  },
  tavily: {
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: () => ({ "content-type": "application/json" }),
    body: JSON.stringify({ query: "test", max_results: 1 }),
  },
  discord_bot: {
    url: "https://discord.com/api/v10/users/@me",
    headers: (key) => ({ Authorization: `Bot ${key}` }),
  },
  slack_bot: {
    url: "https://slack.com/api/auth.test",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  telegram_bot: {
    url: "", // Constructed dynamically with token in URL
    headers: () => ({}),
  },
  xai: {
    url: "https://api.x.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  mistral: {
    url: "https://api.mistral.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

/**
 * Test a single provider's key.
 */
export async function testProviderKey(
  provider: ProviderInfo,
  auth: AuthStorage,
): Promise<TestResult> {
  // Get the API key
  const key = await auth.getApiKey(provider.id);
  if (!key || key === "<authenticated>") {
    if (!key) {
      return { provider, status: "skipped", message: "not configured" };
    }
    return { provider, status: "skipped", message: "uses credential chain (not testable)" };
  }

  const endpoint = TEST_ENDPOINTS[provider.id];
  if (!endpoint) {
    return { provider, status: "skipped", message: "no test endpoint configured" };
  }

  // Special handling for Telegram (token in URL)
  let url = endpoint.url;
  if (provider.id === "telegram_bot") {
    url = `https://api.telegram.org/bot${key}/getMe`;
  }

  // Special handling for Tavily (API key in body)
  let body = endpoint.body;
  if (provider.id === "tavily" && body) {
    const parsed = JSON.parse(body);
    parsed.api_key = key;
    body = JSON.stringify(parsed);
  }

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: endpoint.method ?? "GET",
      headers: endpoint.headers?.(key) ?? {},
      body: body ?? undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      return { provider, status: "valid", message: "valid", latencyMs };
    }

    if (res.status === 401 || res.status === 403) {
      return { provider, status: "invalid", message: `invalid key (${res.status})`, latencyMs };
    }

    if (res.status === 429) {
      return { provider, status: "rate_limited", message: "rate limited", latencyMs };
    }

    return { provider, status: "error", message: `HTTP ${res.status}`, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = getErrorMessage(err);
    if (msg.includes("timeout") || msg.includes("AbortError")) {
      return { provider, status: "error", message: "timeout (15s)", latencyMs };
    }
    return { provider, status: "error", message: msg, latencyMs };
  }
}

/**
 * Format test results for display.
 */
export function formatTestResults(results: TestResult[]): string {
  const lines: string[] = ["API Key Test Results\n"];

  for (const r of results) {
    const icon =
      r.status === "valid" ? "✓" :
      r.status === "invalid" ? "✗" :
      r.status === "rate_limited" ? "⚠" :
      r.status === "error" ? "✗" :
      "—";
    const pad = r.provider.id.padEnd(20);
    const latency = r.latencyMs !== undefined ? `  ${r.latencyMs}ms` : "";
    lines.push(`  ${icon} ${pad} — ${r.message}${latency}`);
  }

  lines.push("");
  const valid = results.filter((r) => r.status === "valid").length;
  const invalid = results.filter((r) => r.status === "invalid").length;
  const rateLimited = results.filter((r) => r.status === "rate_limited").length;
  const errors = results.filter((r) => r.status === "error").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  const parts: string[] = [];
  if (valid > 0) parts.push(`${valid} valid`);
  if (invalid > 0) parts.push(`${invalid} invalid`);
  if (rateLimited > 0) parts.push(`${rateLimited} rate-limited`);
  if (errors > 0) parts.push(`${errors} errors`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  lines.push(`  ${parts.join(" | ")}`);

  return lines.join("\n");
}

// ─── Rotate Key ─────────────────────────────────────────────────────────────────

/**
 * Rotate a key: show current, prompt for new, optionally test, then save.
 */
export async function handleRotateKey(
  providerArg: string,
  ctx: ExtensionCommandContext,
  auth: AuthStorage,
): Promise<boolean> {
  let provider: ProviderInfo | undefined;

  if (providerArg) {
    provider = findProvider(providerArg);
    if (!provider) {
      ctx.ui.notify(`Unknown provider: "${providerArg}".`, "error");
      return false;
    }
  } else {
    // Show only configured API key providers
    const configured = PROVIDER_REGISTRY.filter((p) => {
      const creds = auth.getCredentialsForProvider(p.id);
      return creds.some((c) => c.type === "api_key" && (c as ApiKeyCredential).key);
    });

    if (configured.length === 0) {
      ctx.ui.notify("No API keys configured to rotate.", "info");
      return false;
    }

    const options = configured.map((p) => p.label);
    const choice = await ctx.ui.select("Rotate key for which provider?", options);
    if (!choice || typeof choice !== "string") return false;

    provider = configured.find((p) => p.label === choice);
    if (!provider) return false;
  }

  const creds = auth.getCredentialsForProvider(provider.id);
  const apiKeyCreds = creds.filter((c) => c.type === "api_key") as ApiKeyCredential[];

  if (apiKeyCreds.length === 0) {
    ctx.ui.notify(`No API keys for ${provider.label} (may use OAuth instead).`, "info");
    return false;
  }

  // Show current key(s)
  const currentDesc = apiKeyCreds.map((c) => maskKey(c.key)).join(", ");
  ctx.ui.notify(`Current key${apiKeyCreds.length > 1 ? "s" : ""}: ${currentDesc}`, "info");

  // Prompt for new key
  const input = await ctx.ui.input(
    `New API key for ${provider.label}:`,
    "paste your new key here",
  );

  if (input === null || input === undefined) return false;
  const newKey = input.trim();
  if (!newKey) {
    ctx.ui.notify("No key provided. Rotation cancelled.", "warning");
    return false;
  }

  // Prefix validation
  if (provider.prefixes && provider.prefixes.length > 0) {
    const valid = provider.prefixes.some((pfx) => newKey.startsWith(pfx));
    if (!valid) {
      ctx.ui.notify(
        `Warning: key doesn't start with expected prefix (${provider.prefixes.join(" or ")}).`,
        "warning",
      );
    }
  }

  // Offer to test before saving
  const shouldTest = await ctx.ui.confirm(
    "Test key?",
    "Validate the new key before saving?",
  );

  if (shouldTest) {
    // Temporarily test the new key
    const tempAuth = AuthStorage.inMemory({ [provider.id]: { type: "api_key", key: newKey } });
    const result = await testProviderKey(provider, tempAuth);

    if (result.status === "invalid") {
      ctx.ui.notify(`Key validation failed: ${result.message}. Rotation cancelled.`, "error");
      return false;
    }

    if (result.status === "valid") {
      ctx.ui.notify(`Key validated successfully (${result.latencyMs}ms).`, "success");
    } else {
      ctx.ui.notify(`Key test result: ${result.message}. Proceeding anyway.`, "warning");
    }
  }

  // Remove old keys and add new one
  // Preserve any OAuth credentials
  const oauthCreds = creds.filter((c) => c.type === "oauth");
  auth.remove(provider.id);
  for (const c of oauthCreds) {
    auth.set(provider.id, c);
  }
  auth.set(provider.id, { type: "api_key", key: newKey });

  if (provider.envVar) {
    process.env[provider.envVar] = newKey;
  }

  ctx.ui.notify(`Key rotated for ${provider.label}: ${maskKey(newKey)}`, "success");
  return true;
}

// ─── Key Doctor ─────────────────────────────────────────────────────────────────

export interface DoctorFinding {
  severity: "error" | "warning" | "info" | "fixed";
  provider?: string;
  message: string;
}

/**
 * Run health checks on all API keys.
 */
export function runKeyDoctor(auth: AuthStorage): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  // 1. Check auth.json permissions
  const authPath = getAuthPath();
  if (existsSync(authPath)) {
    try {
      const stats = statSync(authPath);
      const mode = stats.mode & 0o777;
      if (mode !== 0o600) {
        chmodSync(authPath, 0o600);
        findings.push({
          severity: "fixed",
          message: `auth.json permissions were ${mode.toString(8)} — fixed to 600`,
        });
      }
    } catch {
      // Can't check permissions — skip
    }
  }

  // 2. Check for empty keys
  for (const provider of PROVIDER_REGISTRY) {
    const creds = auth.getCredentialsForProvider(provider.id);
    for (const cred of creds) {
      if (cred.type === "api_key" && !(cred as ApiKeyCredential).key) {
        findings.push({
          severity: "warning",
          provider: provider.id,
          message: `${provider.label}: empty key stored (from skipped setup) — run /gsd keys add ${provider.id}`,
        });
      }
    }
  }

  // 3. Check expired OAuth
  for (const provider of PROVIDER_REGISTRY) {
    const creds = auth.getCredentialsForProvider(provider.id);
    for (const cred of creds) {
      if (cred.type === "oauth") {
        const oauthCred = cred as OAuthCredential;
        const remaining = oauthCred.expires - Date.now();
        if (remaining <= 0) {
          findings.push({
            severity: "warning",
            provider: provider.id,
            message: `${provider.label}: OAuth token expired — will auto-refresh on next use`,
          });
        } else if (remaining < 5 * 60 * 1000) {
          findings.push({
            severity: "info",
            provider: provider.id,
            message: `${provider.label}: OAuth token expires in ${formatDuration(remaining)} — will auto-refresh`,
          });
        }
      }
    }
  }

  // 4. Check for env var conflicts
  for (const provider of PROVIDER_REGISTRY) {
    if (!provider.envVar) continue;
    const envValue = process.env[provider.envVar];
    if (!envValue) continue;

    const creds = auth.getCredentialsForProvider(provider.id);
    const apiKey = creds.find((c) => c.type === "api_key" && (c as ApiKeyCredential).key) as ApiKeyCredential | undefined;
    if (apiKey?.key && apiKey.key !== envValue) {
      findings.push({
        severity: "warning",
        provider: provider.id,
        message: `${provider.label}: env ${provider.envVar} differs from auth.json — auth.json takes priority`,
      });
    }
  }

  // 5. Check for backed-off keys
  for (const provider of PROVIDER_REGISTRY) {
    if (auth.areAllCredentialsBackedOff(provider.id)) {
      const remaining = auth.getProviderBackoffRemaining(provider.id);
      findings.push({
        severity: "warning",
        provider: provider.id,
        message: `${provider.label}: all keys in backoff${remaining > 0 ? ` (${formatDuration(remaining)} remaining)` : ""}`,
      });
    }
  }

  // 6. Check for missing LLM provider
  const llmProviders = PROVIDER_REGISTRY.filter((p) => p.category === "llm");
  const hasAnyLlm = llmProviders.some((p) => {
    const creds = auth.getCredentialsForProvider(p.id);
    const hasValidKey = creds.some((c) => c.type === "api_key" ? !!(c as ApiKeyCredential).key : true);
    const hasEnv = p.envVar ? !!process.env[p.envVar] : false;
    return hasValidKey || hasEnv;
  });
  if (!hasAnyLlm) {
    findings.push({
      severity: "error",
      message: "No LLM provider configured — run /gsd keys add or /login",
    });
  }

  // 7. Check for duplicate keys across providers
  const keyToProviders = new Map<string, string[]>();
  for (const provider of PROVIDER_REGISTRY) {
    const creds = auth.getCredentialsForProvider(provider.id);
    for (const cred of creds) {
      if (cred.type === "api_key" && (cred as ApiKeyCredential).key) {
        const key = (cred as ApiKeyCredential).key;
        const existing = keyToProviders.get(key) ?? [];
        existing.push(provider.id);
        keyToProviders.set(key, existing);
      }
    }
  }
  for (const [, providers] of keyToProviders) {
    if (providers.length > 1) {
      findings.push({
        severity: "warning",
        message: `Same key used by multiple providers: ${providers.join(", ")}`,
      });
    }
  }

  return findings;
}

/**
 * Format doctor findings for display.
 */
export function formatDoctorFindings(findings: DoctorFinding[]): string {
  if (findings.length === 0) {
    return "API Key Health Check\n\n  All checks passed. No issues found.";
  }

  const lines: string[] = ["API Key Health Check\n"];

  for (const f of findings) {
    const icon =
      f.severity === "error" ? "✗" :
      f.severity === "warning" ? "⚠" :
      f.severity === "fixed" ? "✓" :
      "ℹ";
    lines.push(`  ${icon} ${f.message}`);
  }

  lines.push("");
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const fixed = findings.filter((f) => f.severity === "fixed").length;
  const info = findings.filter((f) => f.severity === "info").length;

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  if (fixed > 0) parts.push(`${fixed} fixed`);
  if (info > 0) parts.push(`${info} info`);
  lines.push(`  ${parts.join(" | ")}`);

  return lines.join("\n");
}

// ─── Main Handler ───────────────────────────────────────────────────────────────

/**
 * Main entry point for /gsd keys [subcommand].
 */
export async function handleKeys(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const auth = getKeyManagerAuthStorage();
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0] || "";
  const subArgs = parts.slice(1).join(" ").trim();

  switch (subcommand) {
    case "":
    case "list":
    case "status": {
      const statuses = getAllKeyStatuses(auth);
      ctx.ui.notify(formatKeyDashboard(statuses), "info");
      return;
    }

    case "add": {
      const changed = await handleAddKey(subArgs, ctx, auth);
      if (changed) {
        await ctx.waitForIdle();
        await ctx.reload();
      }
      return;
    }

    case "remove":
    case "rm":
    case "delete": {
      const changed = await handleRemoveKey(subArgs, ctx, auth);
      if (changed) {
        await ctx.waitForIdle();
        await ctx.reload();
      }
      return;
    }

    case "test":
    case "validate": {
      let providers: ProviderInfo[];
      if (subArgs) {
        const p = findProvider(subArgs);
        if (!p) {
          ctx.ui.notify(`Unknown provider: "${subArgs}".`, "error");
          return;
        }
        providers = [p];
      } else {
        // Test all configured providers
        const statuses = getAllKeyStatuses(auth);
        providers = statuses
          .filter((s) => s.configured)
          .map((s) => s.provider);
      }

      if (providers.length === 0) {
        ctx.ui.notify("No configured keys to test.", "info");
        return;
      }

      ctx.ui.notify(`Testing ${providers.length} key${providers.length > 1 ? "s" : ""}...`, "info");

      const results: TestResult[] = [];
      for (const p of providers) {
        const result = await testProviderKey(p, auth);
        results.push(result);
      }

      ctx.ui.notify(formatTestResults(results), "info");
      return;
    }

    case "rotate": {
      const changed = await handleRotateKey(subArgs, ctx, auth);
      if (changed) {
        await ctx.waitForIdle();
        await ctx.reload();
      }
      return;
    }

    case "doctor":
    case "health": {
      const findings = runKeyDoctor(auth);
      ctx.ui.notify(formatDoctorFindings(findings), "info");
      return;
    }

    default:
      ctx.ui.notify(
        "Usage: /gsd keys [list|add|remove|test|rotate|doctor]\n\n" +
        "  /gsd keys              Show key status dashboard\n" +
        "  /gsd keys list         List all configured keys\n" +
        "  /gsd keys add [id]     Add a key for a provider\n" +
        "  /gsd keys remove [id]  Remove a key\n" +
        "  /gsd keys test [id]    Validate key(s) with API call\n" +
        "  /gsd keys rotate [id]  Replace an existing key\n" +
        "  /gsd keys doctor       Health check all keys",
        "info",
      );
      return;
  }
}
