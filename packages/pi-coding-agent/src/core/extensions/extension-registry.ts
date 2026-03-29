/**
 * Extension Registry — manages manifest reading, registry persistence, and enable/disable state.
 *
 * Extensions without manifests always load (backwards compatible).
 * A fresh install has an empty registry — all extensions enabled by default.
 * The only way an extension stops loading is an explicit `gsd extensions disable <id>`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { getAgentDir } from "../../config.js";
import { dirname, join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtensionManifest {
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

export interface ExtensionRegistryEntry {
  id: string;
  enabled: boolean;
  source: "bundled" | "user" | "project";
  disabledAt?: string;
  disabledReason?: string;
  version?: string;           // From manifest, used for semver comparison
  installedFrom?: string;     // Original specifier: npm package name, git URL, or local path
  installType?: "npm" | "git" | "local";  // Explicit source type
}

export interface ExtensionRegistry {
  version: 1;
  entries: Record<string, ExtensionRegistryEntry>;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function isRegistry(data: unknown): data is ExtensionRegistry {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.version === 1 && typeof obj.entries === "object" && obj.entries !== null;
}

function isManifest(data: unknown): data is ExtensionManifest {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.version === "string" &&
    typeof obj.tier === "string"
  );
}

// ─── Registry Path ──────────────────────────────────────────────────────────

export function getRegistryPath(): string {
  return join(dirname(getAgentDir()), "extensions", "registry.json");
}

// ─── Registry I/O ───────────────────────────────────────────────────────────

function defaultRegistry(): ExtensionRegistry {
  return { version: 1, entries: {} };
}

export function loadRegistry(): ExtensionRegistry {
  const filePath = getRegistryPath();
  try {
    if (!existsSync(filePath)) return defaultRegistry();
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRegistry(parsed) ? parsed : defaultRegistry();
  } catch {
    return defaultRegistry();
  }
}

export function saveRegistry(registry: ExtensionRegistry): void {
  const filePath = getRegistryPath();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch {
    // Non-fatal — don't let persistence failures break operation
  }
}

// ─── Query ──────────────────────────────────────────────────────────────────

/** Returns true if the extension is enabled (missing entries default to enabled). */
export function isExtensionEnabled(registry: ExtensionRegistry, id: string): boolean {
  const entry = registry.entries[id];
  if (!entry) return true;
  return entry.enabled;
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export function enableExtension(registry: ExtensionRegistry, id: string): void {
  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = true;
    delete entry.disabledAt;
    delete entry.disabledReason;
  } else {
    registry.entries[id] = { id, enabled: true, source: "bundled" };
  }
}

/**
 * Disable an extension. Returns an error string if the extension is core (cannot disable),
 * or null on success.
 */
export function disableExtension(
  registry: ExtensionRegistry,
  id: string,
  manifest: ExtensionManifest | null,
  reason?: string,
): string | null {
  if (manifest?.tier === "core") {
    return `Cannot disable "${id}" — it is a core extension.`;
  }
  const entry = registry.entries[id];
  if (entry) {
    entry.enabled = false;
    entry.disabledAt = new Date().toISOString();
    entry.disabledReason = reason;
  } else {
    registry.entries[id] = {
      id,
      enabled: false,
      source: "bundled",
      disabledAt: new Date().toISOString(),
      disabledReason: reason,
    };
  }
  return null;
}

// ─── Manifest Reading ───────────────────────────────────────────────────────

/** Read extension-manifest.json from a directory. Returns null if missing or invalid. */
export function readManifest(extensionDir: string): ExtensionManifest | null {
  const manifestPath = join(extensionDir, "extension-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return isManifest(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Given an entry path (e.g. `.../extensions/browser-tools/index.ts`),
 * resolve the parent directory and read its manifest.
 */
export function readManifestFromEntryPath(entryPath: string): ExtensionManifest | null {
  const dir = dirname(entryPath);
  return readManifest(dir);
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Scan all subdirectories of extensionsDir for manifests. Returns a Map<id, manifest>. */
export function discoverAllManifests(extensionsDir: string): Map<string, ExtensionManifest> {
  const manifests = new Map<string, ExtensionManifest>();
  if (!existsSync(extensionsDir)) return manifests;

  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(extensionsDir, entry.name));
    if (manifest) {
      manifests.set(manifest.id, manifest);
    }
  }
  return manifests;
}

/**
 * Auto-populate registry entries for newly discovered extensions.
 * Extensions already in the registry are left untouched.
 */
export function ensureRegistryEntries(extensionsDir: string): void {
  const manifests = discoverAllManifests(extensionsDir);
  if (manifests.size === 0) return;

  const registry = loadRegistry();
  let changed = false;

  for (const [id, manifest] of manifests) {
    if (!registry.entries[id]) {
      registry.entries[id] = {
        id,
        enabled: true,
        source: "bundled",
      };
      changed = true;
    }
  }

  if (changed) {
    saveRegistry(registry);
  }
}
