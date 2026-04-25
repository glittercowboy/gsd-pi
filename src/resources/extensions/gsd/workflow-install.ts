/**
 * workflow-install.ts — Fetch, validate, and install remote workflow plugins.
 *
 * Accepts:
 *   - Full URL (https://raw.githubusercontent.com/... or gist raw URL)
 *   - gist:abc123           → https://gist.githubusercontent.com/anonymous/abc123/raw
 *   - gh:owner/repo/path[@ref] → raw.githubusercontent.com/owner/repo/<ref>/path
 *
 * Installed files land in `~/.gsd/workflows/<name>.<ext>` by default, or
 * `.gsd/workflows/<name>.<ext>` with the `--project` flag.
 *
 * A provenance file `~/.gsd/workflows/.installed.json` (or project equivalent)
 * records source URL, timestamp, and sha256 so `/gsd workflow uninstall` can
 * clean up and future `/gsd workflow update` can refresh.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve, sep as pathSep } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

import { validateDefinition } from "./definition-loader.js";

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const PROVENANCE_FILE = ".installed.json";

// ─── Provenance ──────────────────────────────────────────────────────────

export interface ProvenanceEntry {
  source: string;
  installedAt: string;
  sha256: string;
  filename: string;
}

type Provenance = Record<string, ProvenanceEntry>;

function provenancePath(dir: string): string {
  return join(dir, PROVENANCE_FILE);
}

function readProvenance(dir: string): Provenance {
  const path = provenancePath(dir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Provenance;
  } catch {
    return {};
  }
}

function writeProvenance(dir: string, data: Provenance): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(provenancePath(dir), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ─── Install targets ─────────────────────────────────────────────────────

export interface InstallTarget {
  dir: string;
  scope: "global" | "project";
}

export function globalInstallDir(): string {
  const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
  return join(gsdHome, "workflows");
}

export function projectInstallDir(basePath: string): string {
  return join(basePath, ".gsd", "workflows");
}

/**
 * Reject plugin names that could escape the workflows directory.
 * Allows a-z, A-Z, 0-9, dot, underscore, hyphen — no separators, no dot-segments.
 */
function assertSafePluginName(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid plugin name: "${name}"`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid plugin name "${name}". Allowed characters: letters, digits, dot, underscore, hyphen.`,
    );
  }
}

/**
 * Resolve `child` inside `dir` and refuse any result that escapes `dir`.
 */
function safeResolveInDir(dir: string, child: string): string {
  const resolvedDir = resolve(dir);
  const resolvedPath = resolve(resolvedDir, child);
  if (
    resolvedPath !== resolvedDir &&
    !resolvedPath.startsWith(resolvedDir + pathSep)
  ) {
    throw new Error(`Refusing to operate outside ${dir}: ${child}`);
  }
  return resolvedPath;
}

// ─── Source URL resolution ───────────────────────────────────────────────

/**
 * Turn a user-supplied source specifier into a fetchable HTTPS URL.
 * Throws on clearly unsafe inputs (file://, unsupported schemes).
 */
export function resolveSourceUrl(source: string): string {
  const trimmed = source.trim();

  // gist:<id>
  if (trimmed.startsWith("gist:")) {
    const id = trimmed.slice("gist:".length).trim();
    if (!/^[a-f0-9]{6,}$/i.test(id)) {
      throw new Error(`Invalid gist id: ${id}`);
    }
    return `https://gist.githubusercontent.com/anonymous/${id}/raw`;
  }

  // gh:owner/repo/path[@ref]
  if (trimmed.startsWith("gh:")) {
    const rest = trimmed.slice("gh:".length);
    const atIdx = rest.lastIndexOf("@");
    const pathPart = atIdx === -1 ? rest : rest.slice(0, atIdx);
    const ref = atIdx === -1 ? "main" : rest.slice(atIdx + 1);
    const parts = pathPart.split("/");
    if (parts.length < 3) {
      throw new Error(`Expected gh:<owner>/<repo>/<path>: ${trimmed}`);
    }
    const [owner, repo, ...filePath] = parts;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.join("/")}`;
  }

  // file:// — reject
  if (trimmed.startsWith("file:")) {
    throw new Error("file:// sources are not supported for security reasons.");
  }

  // Must be https:// (or http://localhost for dev)
  if (trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("http://")) {
    const url = new URL(trimmed);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return trimmed;
    }
    throw new Error("http:// is only allowed for localhost. Use https://.");
  }

  throw new Error(
    `Unsupported source format: ${trimmed}\n` +
    `Use one of: https://..., gist:<id>, gh:<owner>/<repo>/<path>[@ref]`,
  );
}

// ─── Fetching ────────────────────────────────────────────────────────────

export interface FetchedContent {
  url: string;
  filename: string;
  ext: ".yaml" | ".yml" | ".md";
  content: string;
  sha256: string;
}

/**
 * Fetch the resolved URL with a timeout and a max response size.
 * Injects a simple User-Agent so GitHub doesn't 403.
 */
export async function fetchWorkflowSource(url: string): Promise<FetchedContent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "gsd-workflow-install" },
    });

    if (!res.ok) {
      throw new Error(`Fetch failed (${res.status} ${res.statusText}): ${url}`);
    }

    // Cap size: read as a stream and bail if it exceeds MAX_RESPONSE_BYTES.
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Response too large (${buf.byteLength} bytes, max ${MAX_RESPONSE_BYTES}): ${url}`,
      );
    }

    const content = new TextDecoder().decode(buf);

    // Prefer the final response URL after redirects (e.g., gist /raw → /raw/<sha>/file.ext).
    const finalUrl = typeof res.url === "string" && res.url ? res.url : url;
    let pathname: string;
    try {
      pathname = new URL(finalUrl).pathname;
    } catch {
      pathname = new URL(url).pathname;
    }
    let basename = pathname.slice(pathname.lastIndexOf("/") + 1);
    let rawExt = extname(basename).toLowerCase();

    let ext: ".yaml" | ".yml" | ".md";
    if (rawExt === ".yaml" || rawExt === ".yml" || rawExt === ".md") {
      ext = rawExt;
    } else {
      // Fallback: sniff content. Gist /raw and similar URLs have no extension.
      if (/<template_meta>[\s\S]*?<\/template_meta>/.test(content)) {
        ext = ".md";
      } else {
        let parsed: unknown;
        try {
          parsed = parseYaml(content);
        } catch {
          parsed = undefined;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          ext = ".yaml";
        } else {
          throw new Error(
            `Cannot determine workflow type from ${url}. ` +
            `Expected .yaml/.yml/.md URL, a markdown file with <template_meta>, ` +
            `or a YAML document.`,
          );
        }
      }
      // Synthesize a filename so downstream sanitizers have something to chew on.
      if (!basename) basename = "workflow";
      basename = `${basename}${ext}`;
    }

    const filename = basename;
    const sha256 = createHash("sha256").update(content).digest("hex");

    return { url, filename, ext, content, sha256 };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Validation ──────────────────────────────────────────────────────────

/**
 * Validate fetched content: YAML must pass validateDefinition, markdown must
 * have a `<template_meta>` block with at least `name`.
 */
export function validateFetchedContent(fetched: FetchedContent): void {
  if (fetched.ext === ".yaml" || fetched.ext === ".yml") {
    let parsed: unknown;
    try {
      parsed = parseYaml(fetched.content);
    } catch (err) {
      throw new Error(
        `Installed YAML failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = validateDefinition(parsed);
    if (!result.valid) {
      throw new Error(
        `Installed YAML failed validation:\n  - ${result.errors.join("\n  - ")}`,
      );
    }
    // Optional: validate `mode:` if present.
    if (parsed && typeof parsed === "object") {
      const mode = (parsed as Record<string, unknown>).mode;
      if (mode !== undefined && mode !== "oneshot" && mode !== "yaml-step") {
        throw new Error(
          `YAML plugins must declare mode: oneshot or yaml-step (got "${String(mode)}")`,
        );
      }
    }
    return;
  }

  // Markdown: require a <template_meta> block with at least a name.
  const metaMatch = fetched.content.match(/<template_meta>([\s\S]*?)<\/template_meta>/);
  if (!metaMatch) {
    throw new Error("Installed markdown must contain a <template_meta>…</template_meta> block.");
  }
  if (!/\bname\s*:/i.test(metaMatch[1])) {
    throw new Error("Installed markdown <template_meta> must declare at least `name:`.");
  }
  // Optional: validate `mode:` if declared.
  const modeLine = metaMatch[1].match(/\bmode\s*:\s*(\S+)/i);
  if (modeLine) {
    const mode = modeLine[1];
    if (mode !== "oneshot" && mode !== "markdown-phase") {
      throw new Error(
        `Markdown plugins must declare mode: oneshot or markdown-phase (got "${mode}")`,
      );
    }
  }
}

// ─── Name inference ──────────────────────────────────────────────────────

/**
 * Infer a plugin name from fetched content. For YAML, prefer the top-level
 * `name:` field. For markdown, prefer `<template_meta>.name`. Fall back to
 * the filename stem.
 */
export function inferPluginName(fetched: FetchedContent): string {
  if (fetched.ext === ".yaml" || fetched.ext === ".yml") {
    try {
      const parsed = parseYaml(fetched.content);
      if (parsed && typeof parsed === "object") {
        const n = (parsed as Record<string, unknown>).name;
        if (typeof n === "string" && n.trim()) return sanitizeName(n);
      }
    } catch {
      // Fall through to filename.
    }
  } else {
    const metaMatch = fetched.content.match(/<template_meta>([\s\S]*?)<\/template_meta>/);
    if (metaMatch) {
      const nameMatch = metaMatch[1].match(/\bname\s*:\s*(\S+)/i);
      if (nameMatch) return sanitizeName(nameMatch[1]);
    }
  }
  const stem = fetched.filename.replace(/\.[^.]+$/, "");
  return sanitizeName(stem);
}

function sanitizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
}

// ─── Install / uninstall ─────────────────────────────────────────────────

export interface InstallResult {
  path: string;
  name: string;
  ext: ".yaml" | ".yml" | ".md";
  source: string;
}

/**
 * Write the fetched plugin to disk and update the provenance file.
 * Does NOT prompt — caller is responsible for confirming with the user first.
 */
export function installPlugin(
  target: InstallTarget,
  fetched: FetchedContent,
  name: string,
): InstallResult {
  assertSafePluginName(name);
  mkdirSync(target.dir, { recursive: true });
  const filename = `${name}${fetched.ext}`;
  const path = safeResolveInDir(target.dir, filename);
  writeFileSync(path, fetched.content, "utf-8");

  const prov = readProvenance(target.dir);
  prov[name] = {
    source: fetched.url,
    installedAt: new Date().toISOString(),
    sha256: fetched.sha256,
    filename,
  };
  writeProvenance(target.dir, prov);

  return { path, name, ext: fetched.ext, source: fetched.url };
}

export interface UninstallResult {
  removed: boolean;
  path?: string;
  warnedNotInProvenance?: boolean;
}

/**
 * Remove an installed plugin and its provenance record.
 * Checks global dir first, then project (same order as install default).
 */
export function uninstallPlugin(basePath: string, name: string): UninstallResult {
  assertSafePluginName(name);
  for (const dir of [globalInstallDir(), projectInstallDir(basePath)]) {
    const prov = readProvenance(dir);
    const entry = prov[name];
    if (entry) {
      // Re-validate the filename recorded in provenance: a malicious provenance
      // file must not trick us into deleting outside `dir`.
      assertSafePluginName(entry.filename.replace(/\.(yaml|yml|md)$/i, ""));
      const path = safeResolveInDir(dir, entry.filename);
      if (existsSync(path)) unlinkSync(path);
      delete prov[name];
      writeProvenance(dir, prov);
      return { removed: true, path };
    }

    // No provenance, but file might still exist.
    for (const ext of [".yaml", ".yml", ".md"]) {
      const candidate = safeResolveInDir(dir, `${name}${ext}`);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        unlinkSync(candidate);
        return { removed: true, path: candidate, warnedNotInProvenance: true };
      }
    }
  }
  return { removed: false };
}

// ─── Preview helpers ─────────────────────────────────────────────────────

/**
 * First N lines of the fetched content, for the install confirmation UI.
 */
export function previewContent(content: string, maxLines = 20): string {
  const lines = content.split(/\r?\n/).slice(0, maxLines);
  return lines.join("\n");
}
