/**
 * GSD Doctor — Provider & Integration Health Checks
 *
 * Fast, deterministic checks for external service configuration.
 * Checks key presence in auth.json and environment variables — no HTTP calls,
 * no network I/O, always sub-10ms.
 *
 * Covers:
 *   - LLM providers required by the effective model preferences (per phase)
 *   - Remote questions channel if configured (Slack/Discord/Telegram token)
 *   - Optional search/tool integrations (Brave, Tavily, Jina, Context7)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage } from "@gsd/pi-coding-agent";
import { getEnvApiKey } from "@gsd/pi-ai";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { getAuthPath, PROVIDER_REGISTRY, type ProviderCategory } from "./key-manager.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ProviderCheckStatus = "ok" | "warning" | "error" | "unconfigured";

export interface ProviderCheckResult {
  /** Provider id from PROVIDER_REGISTRY (e.g. "anthropic", "slack_bot") */
  name: string;
  /** Human-readable label */
  label: string;
  /** Functional grouping */
  category: ProviderCategory;
  status: ProviderCheckStatus;
  message: string;
  /** Optional extra detail (e.g. which env var to set) */
  detail?: string;
  /** True if this provider is actively required by preferences */
  required: boolean;
}

// ── Model → Provider ID mapping ───────────────────────────────────────────────

/**
 * Infer the auth provider ID from a model string.
 * Handles plain model IDs ("claude-sonnet-4-6") and prefixed ones ("openrouter/deepseek").
 */
function modelToProviderId(model: string): string | null {
  if (!model) return null;

  // Explicit provider prefix (e.g. "openrouter/deepseek-r1")
  if (model.includes("/")) {
    const prefix = model.split("/")[0].toLowerCase();
    // Map known prefixes to registry IDs
    const prefixMap: Record<string, string> = {
      "anthropic-vertex": "anthropic-vertex",
      openrouter: "openrouter",
      groq: "groq",
      mistral: "mistral",
      google: "google",
      "google-vertex": "google-vertex",
      anthropic: "anthropic",
      openai: "openai",
      "github-copilot": "github-copilot",
    };
    if (prefixMap[prefix]) return prefixMap[prefix];
  }

  const lower = model.toLowerCase();
  if (lower.startsWith("claude"))        return "anthropic";
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3")) return "openai";
  if (lower.startsWith("gemini"))        return "google";
  if (lower.startsWith("llama") || lower.startsWith("mixtral")) return "groq";
  if (lower.startsWith("grok"))          return "xai";
  if (lower.startsWith("mistral") || lower.startsWith("codestral")) return "mistral";

  return null;
}

/** Collect all model strings from effective preferences across all phases. */
function collectConfiguredModelProviders(): Set<string> {
  const providers = new Set<string>();

  try {
    const loaded = loadEffectiveGSDPreferences();
    const models = loaded?.preferences?.models;
    if (!models) {
      // Default: Anthropic
      providers.add("anthropic");
      return providers;
    }

    const modelEntries = typeof models === "object" ? Object.values(models) : [];
    for (const entry of modelEntries) {
      if (typeof entry === "string") {
        const pid = modelToProviderId(entry);
        if (pid) providers.add(pid);
        continue;
      }

      if (typeof entry === "object" && entry !== null && "model" in entry) {
        const configuredProvider = "provider" in entry ? (entry as { provider?: unknown }).provider : undefined;
        if (typeof configuredProvider === "string" && configuredProvider.trim().length > 0) {
          providers.add(configuredProvider);
          continue;
        }

        const modelId = String((entry as { model: unknown }).model);
        const pid = modelToProviderId(modelId);
        if (pid) providers.add(pid);
      }
    }
  } catch {
    // Preferences not readable — assume Anthropic as default
    providers.add("anthropic");
  }

  if (providers.size === 0) providers.add("anthropic");
  return providers;
}

// ── Key resolution ─────────────────────────────────────────────────────────────

interface KeyLookup {
  found: boolean;
  source: "auth.json" | "env" | "none";
  backedOff: boolean;
}

function resolveKey(providerId: string): KeyLookup {
  const info = PROVIDER_REGISTRY.find(p => p.id === providerId);

  if (providerId === "anthropic-vertex" && process.env.ANTHROPIC_VERTEX_PROJECT_ID) {
    return { found: true, source: "env", backedOff: false };
  }

  // Check auth.json
  const authPath = getAuthPath();
  if (existsSync(authPath)) {
    try {
      const auth = AuthStorage.create(authPath);
      const creds = auth.getCredentialsForProvider(providerId);
      if (creds.length > 0) {
        // Filter out empty placeholder keys (from skipped onboarding)
        const hasRealKey = creds.some(c =>
          c.type === "oauth" || (c.type === "api_key" && (c as { key?: string }).key)
        );
        if (hasRealKey) {
          return {
            found: true,
            source: "auth.json",
            backedOff: auth.areAllCredentialsBackedOff(providerId),
          };
        }
      }
    } catch {
      // auth.json malformed — fall through to env check
    }
  }

  // Check environment variable using the authoritative env var resolution
  // (handles multi-var lookups like ANTHROPIC_OAUTH_TOKEN || ANTHROPIC_API_KEY,
  //  COPILOT_GITHUB_TOKEN || GH_TOKEN || GITHUB_TOKEN, Vertex ADC, Bedrock, etc.)
  if (getEnvApiKey(providerId)) {
    return { found: true, source: "env", backedOff: false };
  }

  // Fall back to PROVIDER_REGISTRY env var for providers not covered by getEnvApiKey
  // (e.g., search providers like Brave, Tavily; tool providers like Jina, Context7)
  if (info?.envVar && process.env[info.envVar]) {
    return { found: true, source: "env", backedOff: false };
  }

  return { found: false, source: "none", backedOff: false };
}

// ── Individual check groups ────────────────────────────────────────────────────

/**
 * Providers that can serve models normally associated with another provider.
 * Key = the provider whose models can be served, Value = alternative providers to check.
 * e.g. GitHub Copilot subscriptions can access Claude and GPT models.
 */
const PROVIDER_ROUTES: Record<string, string[]> = {
  anthropic: ["github-copilot"],
  openai: ["github-copilot", "openai-codex"],
  google: ["google-gemini-cli"],
};

function checkLlmProviders(): ProviderCheckResult[] {
  const required = collectConfiguredModelProviders();
  const results: ProviderCheckResult[] = [];

  for (const providerId of required) {
    const info = PROVIDER_REGISTRY.find(p => p.id === providerId);
    const label = providerId === "anthropic-vertex"
      ? "Anthropic Vertex"
      : info?.label ?? providerId;
    const lookup = resolveKey(providerId);

    if (!lookup.found) {
      // Check if a cross-provider can serve this provider's models
      const routes = PROVIDER_ROUTES[providerId];
      const routeProvider = routes?.find(routeId => resolveKey(routeId).found);
      if (routeProvider) {
        const routeInfo = PROVIDER_REGISTRY.find(p => p.id === routeProvider);
        const routeLabel = routeInfo?.label ?? routeProvider;
        results.push({
          name: providerId,
          label,
          category: "llm",
          status: "ok",
          message: `${label} — available via ${routeLabel}`,
          required: true,
        });
        continue;
      }

      const envVar = providerId === "anthropic-vertex"
        ? "ANTHROPIC_VERTEX_PROJECT_ID"
        : info?.envVar ?? `${providerId.toUpperCase()}_API_KEY`;
      results.push({
        name: providerId,
        label,
        category: "llm",
        status: "error",
        message: `${label} — not configured`,
        detail: providerId === "anthropic-vertex"
          ? "Set ANTHROPIC_VERTEX_PROJECT_ID and authenticate with Google ADC"
          : info?.hasOAuth
          ? `Run /gsd keys to authenticate`
          : `Set ${envVar} or run /gsd keys`,
        required: true,
      });
    } else if (lookup.backedOff) {
      results.push({
        name: providerId,
        label,
        category: "llm",
        status: "warning",
        message: `${label} — all credentials backed off (rate limited)`,
        detail: `GSD will retry automatically`,
        required: true,
      });
    } else {
      results.push({
        name: providerId,
        label,
        category: "llm",
        status: "ok",
        message: `${label} — key present (${lookup.source})`,
        required: true,
      });
    }
  }

  return results;
}

function checkRemoteQuestionsProvider(): ProviderCheckResult | null {
  try {
    const loaded = loadEffectiveGSDPreferences();
    const rq = loaded?.preferences?.remote_questions;
    if (!rq) return null;

    const channel = rq.channel as string | undefined;
    if (!channel) return null;

    const providerMap: Record<string, string> = {
      slack: "slack_bot",
      discord: "discord_bot",
      telegram: "telegram_bot",
    };

    const providerId = providerMap[channel.toLowerCase()];
    if (!providerId) return null;

    const info = PROVIDER_REGISTRY.find(p => p.id === providerId);
    const label = info?.label ?? channel;
    const lookup = resolveKey(providerId);

    if (!lookup.found) {
      return {
        name: providerId,
        label,
        category: "remote",
        status: "warning",
        message: `${label} — channel configured but token not found`,
        detail: info?.envVar ? `Set ${info.envVar} or run /gsd keys` : `Run /gsd keys to configure`,
        required: true,
      };
    }

    return {
      name: providerId,
      label,
      category: "remote",
      status: "ok",
      message: `${label} — token present (${lookup.source})`,
      required: true,
    };
  } catch {
    return null;
  }
}

function checkOptionalProviders(): ProviderCheckResult[] {
  const optional = ["brave", "tavily", "jina", "context7"] as const;
  const results: ProviderCheckResult[] = [];

  // Determine which search providers are configured so we can suppress
  // "not configured" noise for alternative search providers when at least
  // one is already active (e.g. don't warn about missing BRAVE_API_KEY
  // when Tavily is configured).
  const searchProviderIds = ["brave", "tavily"] as const;
  const hasAnySearchProvider = searchProviderIds.some(id => resolveKey(id).found);

  for (const providerId of optional) {
    const info = PROVIDER_REGISTRY.find(p => p.id === providerId);
    if (!info) continue;

    const lookup = resolveKey(providerId);

    // Skip unconfigured search providers when another search provider is active
    if (!lookup.found && hasAnySearchProvider && info.category === "search") {
      continue;
    }

    results.push({
      name: providerId,
      label: info.label,
      category: info.category as ProviderCategory,
      status: lookup.found ? "ok" : "unconfigured",
      message: lookup.found
        ? `${info.label} — key present (${lookup.source})`
        : `${info.label} — not configured (optional)`,
      detail: !lookup.found && info.envVar ? `Set ${info.envVar} to enable` : undefined,
      required: false,
    });
  }

  return results;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run all provider checks: required LLM keys, remote questions channel, optional tools.
 * Fast (sub-10ms) — reads auth.json and env vars only, no network I/O.
 */
export function runProviderChecks(): ProviderCheckResult[] {
  const results: ProviderCheckResult[] = [];

  results.push(...checkLlmProviders());

  const remoteCheck = checkRemoteQuestionsProvider();
  if (remoteCheck) results.push(remoteCheck);

  results.push(...checkOptionalProviders());

  return results;
}

/**
 * Format provider check results as a human-readable report string.
 */
export function formatProviderReport(results: ProviderCheckResult[]): string {
  if (results.length === 0) return "No provider checks run.";

  const lines: string[] = [];

  const groups: Record<string, ProviderCheckResult[]> = {};
  for (const r of results) {
    (groups[r.category] ??= []).push(r);
  }

  const categoryLabels: Record<string, string> = {
    llm: "LLM Providers",
    remote: "Notifications",
    search: "Search",
    tool: "Tools",
  };

  for (const [cat, items] of Object.entries(groups)) {
    lines.push(`${categoryLabels[cat] ?? cat}:`);
    for (const item of items) {
      const icon = item.status === "ok" ? "✓"
        : item.status === "warning" ? "⚠"
        : item.status === "error" ? "✗"
        : "·";
      lines.push(`  ${icon} ${item.message}`);
      if (item.detail && item.status !== "ok") {
        lines.push(`    ${item.detail}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Summarise check results to a compact widget-friendly string.
 * Returns null if all required providers are ok.
 */
export function summariseProviderIssues(results: ProviderCheckResult[]): string | null {
  const errors = results.filter(r => r.required && r.status === "error");
  const warnings = results.filter(r => r.required && r.status === "warning");

  if (errors.length === 0 && warnings.length === 0) return null;

  const parts: string[] = [];
  if (errors.length > 0) parts.push(`✗ ${errors[0].label} key missing`);
  if (warnings.length > 0 && errors.length === 0) parts.push(`⚠ ${warnings[0].label} backed off`);
  if (errors.length + warnings.length > 1) parts.push(`(+${errors.length + warnings.length - 1} more)`);

  return parts.join(" ");
}
