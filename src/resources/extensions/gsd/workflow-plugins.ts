/**
 * workflow-plugins.ts — Unified discovery for workflow plugins.
 *
 * Discovers workflow definitions from three tiers (project > global > bundled)
 * in both YAML and markdown formats. Each plugin declares an execution mode
 * that controls how `/gsd workflow <name>` dispatches it:
 *
 *   oneshot         — prompt-only, no state or scaffolding
 *   yaml-step       — CustomWorkflowEngine run with GRAPH.yaml
 *   markdown-phase  — STATE.json + phase gates (current md template behavior)
 *   auto-milestone  — hooks into /gsd auto pipeline (full-project only)
 *
 * Precedence: project > global > bundled. Same-named file wins.
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

import { loadRegistry, type TemplateEntry, type WorkflowMode } from "./workflow-templates.js";

export type { WorkflowMode } from "./workflow-templates.js";

export type PluginSource = "project" | "global" | "bundled";
export type PluginFormat = "yaml" | "md";

export interface WorkflowPluginMeta {
  displayName: string;
  description?: string;
  mode: WorkflowMode;
  phases?: string[];
  triggers?: string[];
  complexity?: string;
  artifactDir?: string | null;
  requiresProject?: boolean;
}

export interface WorkflowPlugin {
  name: string;
  path: string;
  format: PluginFormat;
  source: PluginSource;
  meta: WorkflowPluginMeta;
  /** Populated if the plugin failed validation — discovery still succeeds. */
  error?: string;
}

// ─── Path resolution ─────────────────────────────────────────────────────

function resolveBundledDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const local = join(moduleDir, "workflow-templates");
  if (existsSync(local)) return local;
  const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
  const agentGsdDir = join(gsdHome, "agent", "extensions", "gsd", "workflow-templates");
  if (existsSync(agentGsdDir)) return agentGsdDir;
  return local;
}

function globalPluginsDir(): string {
  const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
  return join(gsdHome, "workflows");
}

function projectPluginsDir(basePath: string): string {
  return join(basePath, ".gsd", "workflows");
}

function legacyDefsDir(basePath: string): string {
  return join(basePath, ".gsd", "workflow-defs");
}

// ─── Markdown frontmatter parsing ────────────────────────────────────────

/**
 * Parse the `<template_meta>` block from bundled/user markdown workflow files.
 * Returns a loose key-value map (strings only).
 */
function parseTemplateMeta(content: string): Record<string, string> {
  const match = content.match(/<template_meta>([\s\S]*?)<\/template_meta>/);
  if (!match) return {};

  const body = match[1];
  const result: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    result[key] = value;
  }
  return result;
}

function parsePhasesFromMarkdown(content: string): string[] {
  const match = content.match(/<phases>([\s\S]*?)<\/phases>/);
  if (!match) return [];
  const phases: string[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^\s*\d+\.\s*(\S+)/);
    if (m) phases.push(m[1]);
  }
  return phases;
}

function firstHeading(content: string): string | undefined {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : undefined;
}

function isValidMode(v: unknown): v is WorkflowMode {
  return v === "oneshot" || v === "yaml-step" || v === "markdown-phase" || v === "auto-milestone";
}

// ─── Single-file plugin loaders ──────────────────────────────────────────

function loadMarkdownPlugin(filePath: string, source: PluginSource): WorkflowPlugin | null {
  const name = basenameNoExt(filePath);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const meta = parseTemplateMeta(content);
  const phases = parsePhasesFromMarkdown(content);
  const declaredMode = meta.mode;
  const mode: WorkflowMode = isValidMode(declaredMode) ? declaredMode : "markdown-phase";

  const triggers = meta.triggers
    ? meta.triggers.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const artifactDirValue = meta.artifact_dir === "null" || meta.artifact_dir === "" ? null : meta.artifact_dir;

  return {
    name,
    path: filePath,
    format: "md",
    source,
    meta: {
      displayName: meta.name || firstHeading(content) || name,
      description: meta.description,
      mode,
      phases: phases.length > 0 ? phases : undefined,
      triggers,
      complexity: meta.complexity,
      artifactDir: artifactDirValue ?? undefined,
      requiresProject: meta.requires_project === "true",
    },
  };
}

function loadYamlPlugin(filePath: string, source: PluginSource): WorkflowPlugin | null {
  const name = basenameNoExt(filePath);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return {
      name,
      path: filePath,
      format: "yaml",
      source,
      meta: { displayName: name, mode: "yaml-step" },
      error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (parsed == null || typeof parsed !== "object") {
    return {
      name,
      path: filePath,
      format: "yaml",
      source,
      meta: { displayName: name, mode: "yaml-step" },
      error: "Definition is not an object",
    };
  }

  const def = parsed as Record<string, unknown>;
  const declaredMode = def.mode;
  const mode: WorkflowMode = isValidMode(declaredMode) ? declaredMode : "yaml-step";

  const steps = Array.isArray(def.steps) ? (def.steps as Array<Record<string, unknown>>) : [];
  const phases = steps.map((s) => String(s.id ?? "")).filter(Boolean);

  return {
    name,
    path: filePath,
    format: "yaml",
    source,
    meta: {
      displayName: typeof def.name === "string" && def.name.trim() ? def.name : name,
      description: typeof def.description === "string" ? def.description : undefined,
      mode,
      phases: phases.length > 0 ? phases : undefined,
    },
  };
}

function basenameNoExt(filePath: string): string {
  const ext = extname(filePath);
  return basename(filePath, ext);
}

// ─── Directory walkers ───────────────────────────────────────────────────

const PLUGIN_EXTENSIONS = new Set([".yaml", ".yml", ".md"]);

function walkPluginDir(dir: string, source: PluginSource, out: Map<string, WorkflowPlugin>): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const ext = extname(entry).toLowerCase();
    if (!PLUGIN_EXTENSIONS.has(ext)) continue;

    const plugin = ext === ".md"
      ? loadMarkdownPlugin(full, source)
      : loadYamlPlugin(full, source);
    if (!plugin) continue;
    out.set(plugin.name, plugin);
  }
}

function loadBundledPlugins(out: Map<string, WorkflowPlugin>): void {
  const bundledDir = resolveBundledDir();
  if (!existsSync(bundledDir)) return;

  const registry = loadRegistry();
  for (const [id, entry] of Object.entries(registry.templates)) {
    const filePath = join(bundledDir, entry.file);
    if (!existsSync(filePath)) continue;
    const ext = extname(entry.file).toLowerCase();
    const format: PluginFormat = ext === ".md" ? "md" : "yaml";
    const mode: WorkflowMode = isValidMode(entry.mode)
      ? entry.mode
      : (format === "yaml" ? "yaml-step" : "markdown-phase");
    out.set(id, {
      name: id,
      path: filePath,
      format,
      source: "bundled",
      meta: {
        displayName: entry.name,
        description: entry.description,
        mode,
        phases: Array.isArray(entry.phases) && entry.phases.length > 0 ? entry.phases : undefined,
        triggers: Array.isArray(entry.triggers) ? entry.triggers : undefined,
        complexity: entry.estimated_complexity,
        artifactDir: entry.artifact_dir,
        requiresProject: entry.requires_project,
      },
    });
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Discover all workflow plugins. Project overrides global overrides bundled.
 *
 * The legacy `.gsd/workflow-defs/*.yaml` directory is also scanned as a
 * fallback YAML source so existing user definitions keep working.
 */
export function discoverPlugins(basePath: string): Map<string, WorkflowPlugin> {
  const out = new Map<string, WorkflowPlugin>();

  loadBundledPlugins(out);
  walkPluginDir(globalPluginsDir(), "global", out);
  walkPluginDir(legacyDefsDir(basePath), "project", out);
  walkPluginDir(projectPluginsDir(basePath), "project", out);

  return out;
}

/**
 * Resolve a plugin by name using the precedence chain.
 * Returns null if no plugin by that name exists anywhere.
 */
export function resolvePlugin(basePath: string, name: string): WorkflowPlugin | null {
  const plugins = discoverPlugins(basePath);
  return plugins.get(name) ?? null;
}

/**
 * Format all discovered plugins for display, grouped by mode.
 */
export function listPluginsFormatted(basePath: string): string {
  const plugins = discoverPlugins(basePath);
  if (plugins.size === 0) {
    return "No workflow plugins found.\n\nRun /gsd workflow new to author one.";
  }

  const groups: Record<WorkflowMode, WorkflowPlugin[]> = {
    "oneshot": [],
    "yaml-step": [],
    "markdown-phase": [],
    "auto-milestone": [],
  };
  for (const p of plugins.values()) {
    groups[p.meta.mode].push(p);
  }

  const lines: string[] = ["Workflow Plugins\n"];

  const order: WorkflowMode[] = ["markdown-phase", "yaml-step", "oneshot", "auto-milestone"];
  for (const mode of order) {
    const list = groups[mode].slice().sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) continue;
    lines.push(`  [${mode}]`);
    for (const p of list) {
      const tag = `${p.source}/${p.format}`;
      const desc = p.meta.description ? ` — ${p.meta.description}` : "";
      lines.push(`    ${p.name.padEnd(22)} ${tag.padEnd(16)}${desc}`);
    }
    lines.push("");
  }

  lines.push("Usage:");
  lines.push("  /gsd workflow <name>          Run a plugin directly");
  lines.push("  /gsd workflow info <name>     Show plugin details");
  lines.push("  /gsd workflow install <src>   Install a plugin from a URL");

  return lines.join("\n");
}

/**
 * Format a single plugin's metadata for `/gsd workflow info <name>`.
 */
export function formatPluginInfo(plugin: WorkflowPlugin): string {
  const lines = [
    `Plugin: ${plugin.meta.displayName} (${plugin.name})`,
    "",
    `Source:   ${plugin.source}`,
    `Format:   ${plugin.format}`,
    `Mode:     ${plugin.meta.mode}`,
    `Path:     ${plugin.path}`,
  ];
  if (plugin.meta.description) {
    lines.push(`About:    ${plugin.meta.description}`);
  }
  if (plugin.meta.complexity) {
    lines.push(`Complexity: ${plugin.meta.complexity}`);
  }
  if (plugin.meta.phases && plugin.meta.phases.length > 0) {
    lines.push("", "Phases/Steps:");
    plugin.meta.phases.forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));
  }
  if (plugin.meta.triggers && plugin.meta.triggers.length > 0) {
    lines.push("", `Triggers: ${plugin.meta.triggers.join(", ")}`);
  }
  if (plugin.meta.artifactDir) {
    lines.push("", `Artifacts: ${plugin.meta.artifactDir}`);
  }
  if (plugin.error) {
    lines.push("", `⚠ Error: ${plugin.error}`);
  }
  return lines.join("\n");
}

/**
 * Get the plugin directory paths for the project/global/bundled tiers.
 * Exposed for the install command and tests.
 */
export function getPluginDirs(basePath: string): { project: string; global: string; bundled: string; legacy: string } {
  return {
    project: projectPluginsDir(basePath),
    global: globalPluginsDir(),
    bundled: resolveBundledDir(),
    legacy: legacyDefsDir(basePath),
  };
}
