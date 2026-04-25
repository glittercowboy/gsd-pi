// GSD Watch — Header renderer: ASCII logo, session info, MCP status, remote questions
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { visibleWidth, truncateToWidth } from "@gsd/pi-tui";
import { loadEffectiveGSDPreferences } from "../preferences.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * GSD ASCII logo — inlined here because the canonical src/logo.ts is outside
 * the resources rootDir and cannot be imported directly.
 */
const GSD_LOGO: readonly string[] = [
  '   ██████╗ ███████╗██████╗ ',
  '  ██╔════╝ ██╔════╝██╔══██╗',
  '  ██║  ███╗███████╗██║  ██║',
  '  ██║   ██║╚════██║██║  ██║',
  '  ╚██████╔╝███████║██████╔╝',
  '   ╚═════╝ ╚══════╝╚═════╝ ',
];

/** Separator character for the horizontal divider line. */
const SEPARATOR_CHAR = "─";

/** Vertical bar between logo and info panel. */
const PANEL_DIVIDER = "│";

/** Label column width for Model/Provider/Directory/Branch rows. */
const LABEL_COL_WIDTH = 10;

// ─── Data Readers ─────────────────────────────────────────────────────────────

/**
 * Read the configured execution model from GSD preferences.
 * Falls back through execution -> planning -> research -> first found.
 * Returns "default" if nothing is configured.
 */
export function readModelFromPreferences(): string {
  try {
    const prefs = loadEffectiveGSDPreferences();
    if (!prefs?.preferences.models) return "default";
    const m = prefs.preferences.models as Record<string, unknown>;
    // Try common phases in priority order
    for (const phase of ["execution", "planning", "research", "discuss", "subagent"]) {
      const val = m[phase];
      if (typeof val === "string") return val;
      if (val && typeof val === "object" && "model" in val) {
        const model = (val as { model: string }).model;
        if (typeof model === "string") return model;
      }
    }
  } catch {
    // Non-fatal
  }
  return "default";
}

/**
 * Derive provider name from model ID prefix.
 */
export function deriveProvider(modelId: string): string {
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
  if (modelId.startsWith("gemini")) return "google";
  if (modelId.startsWith("deepseek")) return "deepseek";
  if (modelId === "default") return "anthropic";
  return "unknown";
}

/**
 * Shorten a directory path by replacing the home directory with ~.
 */
export function shortenPath(fullPath: string): string {
  const home = homedir();
  if (fullPath.startsWith(home)) {
    return "~" + fullPath.slice(home.length);
  }
  return fullPath;
}

/**
 * Read the current git branch name. Returns "unknown" on failure.
 */
export function readGitBranch(projectRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Read MCP server names from .mcp.json or .gsd/mcp.json.
 * Returns array of server name strings.
 */
export function readMcpServerNames(projectRoot: string): string[] {
  const configPaths = [
    join(projectRoot, ".mcp.json"),
    join(projectRoot, ".gsd", "mcp.json"),
  ];
  const names: string[] = [];
  const seen = new Set<string>();

  for (const configPath of configPaths) {
    try {
      if (!existsSync(configPath)) continue;
      const raw = readFileSync(configPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = (data.mcpServers ?? data.servers) as
        | Record<string, unknown>
        | undefined;
      if (!mcpServers || typeof mcpServers !== "object") continue;
      for (const name of Object.keys(mcpServers)) {
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return names;
}

// ─── Header Layout ────────────────────────────────────────────────────────────

export interface HeaderData {
  model: string;
  provider: string;
  directory: string;
  branch: string;
  mcpServers: string[];
}

/**
 * Gather all header data from filesystem and preferences.
 */
export function gatherHeaderData(projectRoot: string): HeaderData {
  const model = readModelFromPreferences();
  const provider = deriveProvider(model);
  const directory = shortenPath(projectRoot);
  const branch = readGitBranch(projectRoot);
  const mcpServers = readMcpServerNames(projectRoot);

  return { model, provider, directory, branch, mcpServers };
}

/**
 * Build an info panel line: "Label     value" with proper padding.
 * Returns empty string if value is empty.
 */
function formatInfoLine(label: string, value: string, availableWidth: number): string {
  const bold = `\x1b[1m${label}\x1b[0m`;
  const labelVis = visibleWidth(bold);
  const padding = " ".repeat(Math.max(1, LABEL_COL_WIDTH - labelVis));
  const maxValueWidth = Math.max(1, availableWidth - LABEL_COL_WIDTH);
  const truncValue = truncateToWidth(value, maxValueWidth, "…");
  return bold + padding + truncValue;
}

/**
 * Format MCP server names as a dot-separated row with checkmarks.
 * e.g. "Brave ✓  ·  Answers ✓  ·  Context7 ✓"
 */
export function formatMcpRow(servers: string[], width: number): string {
  if (servers.length === 0) return "";

  // Capitalize first letter of each server name
  const items = servers.map(s => {
    const cap = s.charAt(0).toUpperCase() + s.slice(1);
    return `${cap} ✓`;
  });

  const full = items.join("  ·  ");
  if (visibleWidth(full) <= width) return full;

  // Truncate if too wide
  return truncateToWidth(full, width, "…");
}

/**
 * Render the full header as an array of terminal-safe strings.
 *
 * Layout: GSD ASCII logo on the left, info panel on the right separated by │.
 * Below: MCP server row, remote questions row, separator line.
 */
export function renderHeaderLines(data: HeaderData, width: number): string[] {
  const lines: string[] = [];

  // Logo is 6 lines tall. Info panel has: title + blank + model + provider + directory + branch = 6 lines
  const logoLines = GSD_LOGO;
  const logoWidth = Math.max(...logoLines.map(l => visibleWidth(l)));

  // Calculate available width for the info panel
  // Layout: logo + " " + "│" + " " = logoWidth + 3
  const dividerOverhead = 3; // " │ "
  const infoPanelWidth = width - logoWidth - dividerOverhead;

  // If terminal is too narrow for side-by-side, fall back to stacked layout
  if (infoPanelWidth < 20) {
    return renderStackedHeader(data, width);
  }

  // Build info panel lines (6 lines to match logo height)
  const infoLines: string[] = [
    `\x1b[1mGet Shit Done\x1b[0m`,
    "",
    formatInfoLine("Model", data.model, infoPanelWidth),
    formatInfoLine("Provider", data.provider, infoPanelWidth),
    formatInfoLine("Directory", data.directory, infoPanelWidth),
    formatInfoLine("Branch", data.branch, infoPanelWidth),
  ];

  // Merge logo and info panel side by side
  const maxLines = Math.max(logoLines.length, infoLines.length);
  for (let i = 0; i < maxLines; i++) {
    const logoLine = i < logoLines.length ? logoLines[i] : "";
    const infoLine = i < infoLines.length ? infoLines[i] : "";

    // Pad logo line to consistent width
    const logoPad = " ".repeat(Math.max(0, logoWidth - visibleWidth(logoLine)));
    lines.push(`${logoLine}${logoPad} ${PANEL_DIVIDER} ${infoLine}`);
  }

  // Blank line after logo+info block
  lines.push("");

  // MCP server row
  const mcpRow = formatMcpRow(data.mcpServers, width);
  if (mcpRow) {
    lines.push(` ${mcpRow}`);
  }

  // Separator line
  lines.push(SEPARATOR_CHAR.repeat(width));

  return lines;
}

/**
 * Fallback stacked layout for narrow terminals (< 20 cols for info panel).
 */
function renderStackedHeader(data: HeaderData, width: number): string[] {
  const lines: string[] = [];

  // Title
  lines.push(`\x1b[1mGet Shit Done\x1b[0m`);
  lines.push("");

  // Info
  lines.push(formatInfoLine("Model", data.model, width));
  lines.push(formatInfoLine("Provider", data.provider, width));
  lines.push(formatInfoLine("Directory", data.directory, width));
  lines.push(formatInfoLine("Branch", data.branch, width));
  lines.push("");

  // MCP
  const mcpRow = formatMcpRow(data.mcpServers, width);
  if (mcpRow) lines.push(` ${mcpRow}`);

  // Separator
  lines.push(SEPARATOR_CHAR.repeat(width));

  return lines;
}
