import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { clearCmuxSidebar, CmuxClient, detectCmuxEnvironment, resolveCmuxConfig } from "../cmux/index.js";
import { saveFile } from "./files.js";
import {
  getProjectGSDPreferencesPath,
  loadEffectiveGSDPreferences,
  loadProjectGSDPreferences,
} from "./preferences.js";
import { ensurePreferencesFile, serializePreferencesToFrontmatter } from "./commands-prefs-wizard.js";

/**
 * Auto-enable cmux in project preferences when detected but never configured.
 * Called at boot (before agent start) — no ExtensionCommandContext needed.
 * Returns true if preferences were written, false if skipped.
 */
export function autoEnableCmuxPreferences(): boolean {
  const path = resolveProjectPreferencesWritePath();
  if (!existsSync(path)) return false;

  const existing = loadProjectGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : { version: 1 };
  prefs.cmux = {
    enabled: true,
    notifications: true,
    sidebar: true,
    splits: false,
    browser: false,
    ...((prefs.cmux as Record<string, unknown> | undefined) ?? {}),
  };
  (prefs.cmux as Record<string, unknown>).enabled = true;
  prefs.version = prefs.version || 1;

  const frontmatter = serializePreferencesToFrontmatter(prefs);
  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  const preserved = extractBodyAfterFrontmatter(readFileSync(path, "utf-8"));
  if (preserved) body = preserved;

  writeFileSync(path, `---\n${frontmatter}---${body}`, "utf-8");
  return true;
}

function extractBodyAfterFrontmatter(content: string): string | null {
  const start = content.startsWith("---\n") ? 4 : content.startsWith("---\r\n") ? 5 : -1;
  if (start === -1) return null;
  const closingIdx = content.indexOf("\n---", start);
  if (closingIdx === -1) return null;
  const after = content.slice(closingIdx + 4);
  return after.trim() ? after : null;
}

async function writeProjectCmuxPreferences(
  ctx: ExtensionCommandContext,
  updater: (prefs: Record<string, unknown>) => void,
): Promise<void> {
  const path = resolveProjectPreferencesWritePath();
  await ensurePreferencesFile(path, ctx, "project");

  const existing = loadProjectGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : { version: 1 };
  updater(prefs);
  prefs.version = prefs.version || 1;

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

function resolveProjectPreferencesWritePath(): string {
  return loadProjectGSDPreferences()?.path ?? getProjectGSDPreferencesPath();
}

function formatCmuxStatus(): string {
  const loaded = loadEffectiveGSDPreferences();
  const detected = detectCmuxEnvironment();
  const resolved = resolveCmuxConfig(loaded?.preferences);
  const capabilities = new CmuxClient(resolved).getCapabilities() as Record<string, unknown> | null;
  const accessMode = typeof capabilities?.mode === "string"
    ? capabilities.mode
    : typeof capabilities?.access_mode === "string"
      ? capabilities.access_mode
      : "unknown";
  const methods = Array.isArray(capabilities?.methods) ? capabilities.methods.length : 0;

  return [
    "cmux status",
    "",
    `Detected: ${detected.available ? "yes" : "no"}`,
    `Enabled: ${resolved.enabled ? "yes" : "no"}`,
    `CLI available: ${detected.cliAvailable ? "yes" : "no"}`,
    `Socket: ${detected.socketPath}`,
    `Workspace: ${detected.workspaceId ?? "(none)"}`,
    `Surface: ${detected.surfaceId ?? "(none)"}`,
    `Features: notifications=${resolved.notifications ? "on" : "off"}, sidebar=${resolved.sidebar ? "on" : "off"}, splits=${resolved.splits ? "on" : "off"}, browser=${resolved.browser ? "on" : "off"}`,
    `Capabilities: access=${accessMode}, methods=${methods}`,
  ].join("\n");
}

function ensureCmuxAvailableForEnable(ctx: ExtensionCommandContext): boolean {
  const detected = detectCmuxEnvironment();
  if (detected.available) return true;
  ctx.ui.notify(
    "cmux not detected. Install it from https://cmux.com and run gsd inside a cmux terminal.",
    "warning",
  );
  return false;
}

export async function handleCmux(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "status") {
    ctx.ui.notify(formatCmuxStatus(), "info");
    return;
  }

  if (trimmed === "on") {
    if (!ensureCmuxAvailableForEnable(ctx)) return;
    await writeProjectCmuxPreferences(ctx, (prefs) => {
      prefs.cmux = {
        enabled: true,
        notifications: true,
        sidebar: true,
        splits: false,
        browser: false,
        ...((prefs.cmux as Record<string, unknown> | undefined) ?? {}),
      };
      (prefs.cmux as Record<string, unknown>).enabled = true;
    });
    ctx.ui.notify("cmux integration enabled in project preferences.", "info");
    return;
  }

  if (trimmed === "off") {
    const effective = loadEffectiveGSDPreferences()?.preferences;
    await writeProjectCmuxPreferences(ctx, (prefs) => {
      prefs.cmux = { ...((prefs.cmux as Record<string, unknown> | undefined) ?? {}), enabled: false };
    });
    clearCmuxSidebar(effective);
    ctx.ui.notify("cmux integration disabled in project preferences.", "info");
    return;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 2 && ["notifications", "sidebar", "splits", "browser"].includes(parts[0]) && ["on", "off"].includes(parts[1])) {
    const feature = parts[0] as "notifications" | "sidebar" | "splits" | "browser";
    const enabled = parts[1] === "on";
    if (enabled && !ensureCmuxAvailableForEnable(ctx)) return;

    await writeProjectCmuxPreferences(ctx, (prefs) => {
      const next = { ...((prefs.cmux as Record<string, unknown> | undefined) ?? {}) };
      next[feature] = enabled;
      if (enabled) next.enabled = true;
      prefs.cmux = next;
    });

    if (!enabled && feature === "sidebar") {
      clearCmuxSidebar(loadEffectiveGSDPreferences()?.preferences);
    }

    const note = feature === "browser" && enabled
      ? " Browser surfaces are still a follow-up path."
      : "";
    ctx.ui.notify(`cmux ${feature} ${enabled ? "enabled" : "disabled"}.${note}`, "info");
    return;
  }

  ctx.ui.notify(
    "Usage: /gsd cmux <status|on|off|notifications on|notifications off|sidebar on|sidebar off|splits on|splits off|browser on|browser off>",
    "info",
  );
}
