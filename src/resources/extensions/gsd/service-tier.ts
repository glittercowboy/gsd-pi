/**
 * Service Tier — gating, status formatting, icon resolution, and
 * the /gsd fast command handler.
 *
 * Service tiers (priority/flex) are an OpenAI feature that currently only
 * applies to gpt-5.4 variants in GSD. This module centralizes the model-gating logic
 * so that icons, preferences, and the before_provider_request hook all
 * use a single source of truth.
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { saveFile } from "./files.js";
import {
  getGlobalGSDPreferencesPath,
  loadEffectiveGSDPreferences,
  loadGlobalGSDPreferences,
} from "./preferences.js";
import { ensurePreferencesFile, serializePreferencesToFrontmatter } from "./commands-prefs-wizard.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceTierSetting = "priority" | "flex" | undefined;

const SERVICE_TIER_SCOPE_NOTE = "Only affects gpt-5.4 models, regardless of provider.";

// ─── Gating ──────────────────────────────────────────────────────────────────

/**
 * Model ID prefixes (bare, without provider) that support OpenAI service tiers.
 *
 * This list is the fallback for callers that only have a model ID string.
 * The authoritative source of truth is `model.capabilities.supportsServiceTier`
 * (set via CAPABILITY_PATCHES in packages/pi-ai/src/models.ts). When callers
 * have access to the full Model object, prefer reading capabilities directly.
 *
 * GPT-5.5 is intentionally excluded until we verify its provider payload
 * contract instead of assuming `service_tier` support.
 *
 * See: https://github.com/gsd-build/gsd-2/issues/2546
 */
const SERVICE_TIER_MODEL_PREFIXES = ["gpt-5.4"] as const;

/**
 * Returns true when the given model ID supports OpenAI service tiers.
 * Reads from SERVICE_TIER_MODEL_PREFIXES — update that list, not this function.
 */
export function supportsServiceTier(modelId: string): boolean {
  if (!modelId) return false;
  // Strip provider prefix if present (e.g. "openai/gpt-5.4" → "gpt-5.4")
  const bare = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return SERVICE_TIER_MODEL_PREFIXES.some((prefix) => bare.startsWith(prefix));
}

// ─── Status Formatting ───────────────────────────────────────────────────────

/**
 * Human-readable description of the current service tier setting.
 */
export function formatServiceTierStatus(tier: ServiceTierSetting): string {
  if (!tier) {
    return [
      "Service tier: disabled",
      "",
      "Usage:",
      "  /gsd fast on     Set to priority (2x cost, faster)",
      "  /gsd fast flex   Set to flex (0.5x cost, slower)",
      "  /gsd fast off    Disable service tier",
      "",
      SERVICE_TIER_SCOPE_NOTE,
    ].join("\n");
  }

  const label = tier === "priority" ? "priority (2x cost, faster)" : "flex (0.5x cost, slower)";
  return [
    `Service tier: ${label}`,
    "",
    "Usage:",
    "  /gsd fast on     Set to priority (2x cost, faster)",
    "  /gsd fast flex   Set to flex (0.5x cost, slower)",
    "  /gsd fast off    Disable service tier",
    "",
    SERVICE_TIER_SCOPE_NOTE,
  ].join("\n");
}

export function formatServiceTierFooterStatus(
  tier: ServiceTierSetting,
  modelId: string | undefined,
): string | undefined {
  if (!tier || !modelId || !supportsServiceTier(modelId)) return undefined;
  return tier === "priority" ? "fast: ⚡ priority" : "fast: 💰 flex";
}

// ─── Icon Resolution ─────────────────────────────────────────────────────────

/**
 * Returns the appropriate icon for the active service tier and model.
 * Returns empty string when the tier is inactive or the model doesn't
 * support service tiers.
 */
export function resolveServiceTierIcon(tier: ServiceTierSetting, modelId: string): string {
  if (!tier || !supportsServiceTier(modelId)) return "";
  return tier === "priority" ? "⚡" : "💰";
}

// ─── Preference Read ─────────────────────────────────────────────────────────

/**
 * Read the effective service_tier setting from preferences.
 */
export function getEffectiveServiceTier(): ServiceTierSetting {
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const raw = prefs?.service_tier;
  if (raw === "priority" || raw === "flex") return raw;
  return undefined;
}

// ─── Preference Write ────────────────────────────────────────────────────────

function extractBodyAfterFrontmatter(content: string): string | null {
  const start = content.startsWith("---\n") ? 4 : content.startsWith("---\r\n") ? 5 : -1;
  if (start === -1) return null;
  const closingIdx = content.indexOf("\n---", start);
  if (closingIdx === -1) return null;
  const after = content.slice(closingIdx + 4);
  return after.trim() ? after : null;
}

async function writeGlobalServiceTier(
  ctx: ExtensionCommandContext,
  tier: ServiceTierSetting,
): Promise<void> {
  const path = getGlobalGSDPreferencesPath();
  await ensurePreferencesFile(path, ctx, "global");

  const existing = loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : {};
  prefs.version = prefs.version || 1;

  if (tier) {
    prefs.service_tier = tier;
  } else {
    delete prefs.service_tier;
  }

  const frontmatter = serializePreferencesToFrontmatter(prefs);
  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  if (existsSync(path)) {
    const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
    if (preserved) body = preserved;
  }

  await saveFile(path, `---\n${frontmatter}---${body}`);
  await ctx.waitForIdle();
  await ctx.reload();
}

// ─── Command Handler ─────────────────────────────────────────────────────────

/**
 * Handle `/gsd fast [on|off|flex|status]`.
 */
export async function handleFast(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim().toLowerCase();

  if (!trimmed || trimmed === "status") {
    const tier = getEffectiveServiceTier();
    ctx.ui.notify(formatServiceTierStatus(tier), "info");
    return;
  }

  if (trimmed === "on") {
    await writeGlobalServiceTier(ctx, "priority");
    ctx.ui.setStatus("gsd-fast", formatServiceTierFooterStatus("priority", ctx.model?.id));
    ctx.ui.notify("Service tier set to priority (2x cost, faster responses). Only affects gpt-5.4 models, regardless of provider.", "info");
    return;
  }

  if (trimmed === "off") {
    await writeGlobalServiceTier(ctx, undefined);
    ctx.ui.setStatus("gsd-fast", undefined);
    ctx.ui.notify("Service tier disabled.", "info");
    return;
  }

  if (trimmed === "flex") {
    await writeGlobalServiceTier(ctx, "flex");
    ctx.ui.setStatus("gsd-fast", formatServiceTierFooterStatus("flex", ctx.model?.id));
    ctx.ui.notify("Service tier set to flex (0.5x cost, slower responses). Only affects gpt-5.4 models, regardless of provider.", "info");
    return;
  }

  ctx.ui.notify(
    "Usage: /gsd fast [on|off|flex|status]\n\n  on    Priority tier (2x cost, faster)\n  off   Disable service tier\n  flex  Flex tier (0.5x cost, slower)\n  status Show current setting",
    "warning",
  );
}
