// GSD2 — Ecosystem extension loader for ./.gsd/extensions/
// Discovers and registers single-file extensions that consume GSDExtensionAPI.
// Trust-gated (mirrors pi's `.pi/extensions/` model) and isolated from pi's
// own loader chain — handlers run in GSD's own dispatch step, not pi's.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { getAgentDir } from "@gsd/pi-coding-agent";

import { logWarning } from "../workflow-logger.js";
import {
  createGSDExtensionAPI,
  type GSDEcosystemBeforeAgentStartHandler,
  type GSDExtensionAPI,
} from "./gsd-extension-api.js";

// ─── Trust check (inlined; pi does not export isProjectTrusted from its
// package root, and constraint forbids modifying packages/pi-coding-agent/) ─

const TRUSTED_PROJECTS_FILE = "trusted-projects.json";

function isProjectTrusted(projectPath: string, agentDir: string): boolean {
  const canonical = path.resolve(projectPath);
  const trustedPath = path.join(agentDir, TRUSTED_PROJECTS_FILE);
  try {
    const content = fs.readFileSync(trustedPath, "utf-8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.includes(canonical);
    }
  } catch {
    // missing or malformed — treat as untrusted
  }
  return false;
}

// ─── Ready-promise singleton ────────────────────────────────────────────

let _readyPromise: Promise<void> | null = null;
let _untrustedWarned = false;

/**
 * Discover and register ecosystem extensions from `./.gsd/extensions/`.
 * Idempotent: subsequent calls with the same arguments return the same
 * pending promise (no double-load).
 */
export function loadEcosystemExtensions(
  pi: ExtensionAPI,
  sharedHandlers: GSDEcosystemBeforeAgentStartHandler[],
  cwd: string = process.cwd(),
): Promise<void> {
  if (_readyPromise) return _readyPromise;
  _readyPromise = _loadEcosystemExtensionsImpl(pi, sharedHandlers, cwd);
  return _readyPromise;
}

/**
 * Returns a promise that resolves when ecosystem loading has completed.
 * If loading was never kicked off this returns a resolved promise so the
 * `before_agent_start` handler can `await` unconditionally.
 */
export function getEcosystemReadyPromise(): Promise<void> {
  return _readyPromise ?? Promise.resolve();
}

/** Test-only: clear the singleton so tests can re-run loading. */
export function _resetEcosystemLoader(): void {
  _readyPromise = null;
  _untrustedWarned = false;
}

// ─── Implementation ─────────────────────────────────────────────────────

async function _loadEcosystemExtensionsImpl(
  pi: ExtensionAPI,
  sharedHandlers: GSDEcosystemBeforeAgentStartHandler[],
  cwd: string,
): Promise<void> {
  const extDir = path.join(cwd, ".gsd", "extensions");
  if (!fs.existsSync(extDir)) return;

  // Trust gate: refuse to load arbitrary code from untrusted project dirs.
  if (!isProjectTrusted(cwd, getAgentDir())) {
    if (!_untrustedWarned) {
      _untrustedWarned = true;
      logWarning(
        "ecosystem",
        ".gsd/extensions present but project is not trusted — skipping ecosystem extensions. Run `pi trust` to opt in.",
      );
    }
    return;
  }

  // Resolve realpath ONCE so symlink-escape detection has a stable anchor.
  let realExtDir: string;
  try {
    realExtDir = fs.realpathSync(extDir);
  } catch (err) {
    logWarning(
      "ecosystem",
      `failed to resolve extensions dir: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  let entries: string[];
  try {
    entries = fs
      .readdirSync(extDir)
      .filter((f) => f.endsWith(".js") || f.endsWith(".ts"))
      .sort(); // deterministic load order
  } catch (err) {
    logWarning(
      "ecosystem",
      `failed to read extensions dir: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // The wrapper api is built once per loader run and shared by all extensions
  // so they all read from the same module-level snapshot.
  const api: GSDExtensionAPI = createGSDExtensionAPI(pi, sharedHandlers);

  for (const entry of entries) {
    await _loadOne(extDir, realExtDir, entry, api);
  }
}

async function _loadOne(
  extDir: string,
  realExtDir: string,
  entry: string,
  api: GSDExtensionAPI,
): Promise<void> {
  const fullPath = path.join(extDir, entry);

  // Symlink-escape guard: reject entries whose realpath is not under realExtDir.
  let realFullPath: string;
  try {
    realFullPath = fs.realpathSync(fullPath);
  } catch (err) {
    logWarning(
      "ecosystem",
      `failed to resolve ${entry}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const realExtDirWithSep = realExtDir.endsWith(path.sep) ? realExtDir : realExtDir + path.sep;
  if (
    realFullPath !== realExtDir &&
    !realFullPath.startsWith(realExtDirWithSep)
  ) {
    logWarning("ecosystem", `rejecting ${entry}: realpath escapes extensions dir`);
    return;
  }

  // For .ts files, require a sibling compiled .js — we do not run a TS loader
  // in production. Drop mtime heuristics: if .js exists, prefer it; otherwise warn.
  let importPath = realFullPath;
  if (entry.endsWith(".ts")) {
    const jsSibling = realFullPath.slice(0, -3) + ".js";
    if (fs.existsSync(jsSibling)) {
      importPath = jsSibling;
    } else {
      logWarning(
        "ecosystem",
        `${entry}: TypeScript source has no compiled .js sibling — compile it first`,
      );
      return;
    }
  }

  let mod: any;
  try {
    mod = await import(pathToFileURL(importPath).href);
  } catch (err) {
    logWarning(
      "ecosystem",
      `failed to import ${entry}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const factory = mod?.default;
  if (typeof factory !== "function") {
    logWarning("ecosystem", `${entry}: default export is not a function`);
    return;
  }

  try {
    await factory(api);
  } catch (err) {
    logWarning(
      "ecosystem",
      `factory threw for ${entry}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
