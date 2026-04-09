/**
 * GSD Extensions Command — /gsd extensions
 *
 * Manage the extension registry: list, enable, disable, info.
 * Self-contained — no imports outside the extensions tree (extensions are loaded
 * via jiti at runtime from ~/.gsd/agent/, not compiled by tsc).
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

// ─── Types (mirrored from extension-registry.ts) ────────────────────────────

interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  tier: "core" | "bundled" | "community";
  requires: { platform: string };
  provides?: {
    tools?: string[];
    commands?: string[];
    hooks?: string[];
    shortcuts?: string[];
  };
  dependencies?: {
    extensions?: string[];
    runtime?: string[];
  };
}

interface ExtensionRegistryEntry {
  id: string;
  enabled: boolean;
  source: "bundled" | "user" | "project";
  disabledAt?: string;
  disabledReason?: string;
}

interface ExtensionRegistry {
  version: 1;
  entries: Record<string, ExtensionRegistryEntry>;
}

// ─── Registry I/O ───────────────────────────────────────────────────────────

function getRegistryPath(): string {
  return join(gsdHome, "extensions", "registry.json");
}

function getAgentExtensionsDir(): string {
  return join(gsdHome, "agent", "extensions");
}

function loadRegistry(): ExtensionRegistry {
  const filePath = getRegistryPath();
  try {
    if (!existsSync(filePath)) return { version: 1, entries: {} };
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && parsed.version === 1 && typeof parsed.entries === "object") {
      return parsed as ExtensionRegistry;
    }
    return { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveRegistry(registry: ExtensionRegistry): void {
  const filePath = getRegistryPath();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch { /* non-fatal */ }
}

function isEnabled(registry: ExtensionRegistry, id: string): boolean {
  const entry = registry.entries[id];
  if (!entry) return true;
  return entry.enabled;
}

function readManifest(dir: string): ExtensionManifest | null {
  const mPath = join(dir, "extension-manifest.json");
  if (!existsSync(mPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(mPath, "utf-8"));
    if (typeof raw?.id === "string" && typeof raw?.name === "string") return raw as ExtensionManifest;
    return null;
  } catch {
    return null;
  }
}

function discoverManifests(): Map<string, ExtensionManifest> {
  const extDir = getAgentExtensionsDir();
  const manifests = new Map<string, ExtensionManifest>();
  if (!existsSync(extDir)) return manifests;
  for (const entry of readdirSync(extDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const m = readManifest(join(extDir, entry.name));
    if (m) manifests.set(m.id, m);
  }
  return manifests;
}

// ─── Command Handler ────────────────────────────────────────────────────────

export async function handleExtensions(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  const subCmd = parts[0] ?? "list";

  if (subCmd === "list") {
    handleList(ctx);
    return;
  }

  if (subCmd === "enable") {
    handleEnable(parts[1], ctx);
    return;
  }

  if (subCmd === "disable") {
    handleDisable(parts[1], parts.slice(2).join(" "), ctx);
    return;
  }

  if (subCmd === "info") {
    handleInfo(parts[1], ctx);
    return;
  }

  ctx.ui.notify(
    `Unknown: /gsd extensions ${subCmd}. Usage: /gsd extensions [list|enable|disable|info]`,
    "warning",
  );
}

function handleList(ctx: ExtensionCommandContext): void {
  const manifests = discoverManifests();
  const registry = loadRegistry();

  if (manifests.size === 0) {
    ctx.ui.notify("No extension manifests found.", "warning");
    return;
  }

  // Sort: core first, then alphabetical
  const sorted = [...manifests.values()].sort((a, b) => {
    if (a.tier === "core" && b.tier !== "core") return -1;
    if (b.tier === "core" && a.tier !== "core") return 1;
    return a.id.localeCompare(b.id);
  });

  const lines: string[] = [];
  const hdr = padRight("Extensions", 38) + padRight("Status", 10) + padRight("Tier", 10) + padRight("Tools", 7) + "Commands";
  lines.push(hdr);
  lines.push("─".repeat(hdr.length));

  for (const m of sorted) {
    const enabled = isEnabled(registry, m.id);
    const status = enabled ? "enabled" : "disabled";
    const toolCount = m.provides?.tools?.length ?? 0;
    const cmdCount = m.provides?.commands?.length ?? 0;
    const label = `${m.id} (${m.name})`;

    lines.push(
      padRight(label, 38) +
      padRight(status, 10) +
      padRight(m.tier, 10) +
      padRight(String(toolCount), 7) +
      String(cmdCount),
    );

    if (!enabled) {
      lines.push(`  ↳ gsd extensions enable ${m.id}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleEnable(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions enable <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }

  const registry = loadRegistry();
  if (isEnabled(registry, id)) {
    ctx.ui.notify(`Extension "${id}" is already enabled.`, "info");
    return;
  }

  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = true;
    delete entry.disabledAt;
    delete entry.disabledReason;
  } else {
    registry.entries[id] = { id, enabled: true, source: "bundled" };
  }
  saveRegistry(registry);
  ctx.ui.notify(`Enabled "${id}". Restart GSD to activate.`, "info");
}

function handleDisable(id: string | undefined, reason: string, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions disable <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  const manifest = manifests.get(id) ?? null;

  if (!manifests.has(id)) {
    ctx.ui.notify(`Extension "${id}" not found. Run /gsd extensions list to see available extensions.`, "warning");
    return;
  }

  if (manifest?.tier === "core") {
    ctx.ui.notify(`Cannot disable "${id}" — it is a core extension.`, "warning");
    return;
  }

  const registry = loadRegistry();
  if (!isEnabled(registry, id)) {
    ctx.ui.notify(`Extension "${id}" is already disabled.`, "info");
    return;
  }

  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = false;
    entry.disabledAt = new Date().toISOString();
    entry.disabledReason = reason || undefined;
  } else {
    registry.entries[id] = {
      id,
      enabled: false,
      source: "bundled",
      disabledAt: new Date().toISOString(),
      disabledReason: reason || undefined,
    };
  }
  saveRegistry(registry);
  ctx.ui.notify(`Disabled "${id}". Restart GSD to deactivate.`, "info");
}

function handleInfo(id: string | undefined, ctx: ExtensionCommandContext): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd extensions info <id>", "warning");
    return;
  }

  const manifests = discoverManifests();
  const manifest = manifests.get(id);
  if (!manifest) {
    ctx.ui.notify(`Extension "${id}" not found.`, "warning");
    return;
  }

  const registry = loadRegistry();
  const enabled = isEnabled(registry, id);
  const entry = registry.entries[id];

  const lines: string[] = [
    `${manifest.name} (${manifest.id})`,
    "",
    `  Version:     ${manifest.version}`,
    `  Description: ${manifest.description}`,
    `  Tier:        ${manifest.tier}`,
    `  Status:      ${enabled ? "enabled" : "disabled"}`,
  ];

  if (entry?.disabledAt) {
    lines.push(`  Disabled at: ${entry.disabledAt}`);
  }
  if (entry?.disabledReason) {
    lines.push(`  Reason:      ${entry.disabledReason}`);
  }

  if (manifest.provides) {
    lines.push("");
    lines.push("  Provides:");
    if (manifest.provides.tools?.length) {
      lines.push(`    Tools:     ${manifest.provides.tools.join(", ")}`);
    }
    if (manifest.provides.commands?.length) {
      lines.push(`    Commands:  ${manifest.provides.commands.join(", ")}`);
    }
    if (manifest.provides.hooks?.length) {
      lines.push(`    Hooks:     ${manifest.provides.hooks.join(", ")}`);
    }
    if (manifest.provides.shortcuts?.length) {
      lines.push(`    Shortcuts: ${manifest.provides.shortcuts.join(", ")}`);
    }
  }

  if (manifest.dependencies) {
    lines.push("");
    lines.push("  Dependencies:");
    if (manifest.dependencies.extensions?.length) {
      lines.push(`    Extensions: ${manifest.dependencies.extensions.join(", ")}`);
    }
    if (manifest.dependencies.runtime?.length) {
      lines.push(`    Runtime:    ${manifest.dependencies.runtime.join(", ")}`);
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + " " : str + " ".repeat(len - str.length);
}
