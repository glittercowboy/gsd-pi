// GSD Community Hooks — Management Command
//
// Provides the `/gsd hooks` subcommands for listing, toggling, and viewing
// stats for community hooks. Integrates with the existing hooks command.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { getAllStats, resetStats, type HookStats } from "./stats.js";

interface CommunityHookConfig {
  [key: string]: boolean | undefined;
}

/** Hook metadata for display. */
interface HookMeta {
  key: string;
  name: string;
  hookType: string;
  description: string;
}

const HOOK_METADATA: HookMeta[] = [
  { key: "secretScanner",     name: "Secret Scanner",     hookType: "tool_call",          description: "Block writes containing API keys, tokens, secrets" },
  { key: "fileGuardrails",    name: "File Guardrails",    hookType: "tool_call",          description: "Protect critical files from modification" },
  { key: "dependencyAuditor", name: "Dependency Auditor", hookType: "tool_result",        description: "Audit packages after install for vulnerabilities" },
  { key: "autoTestRunner",    name: "Auto Test Runner",   hookType: "agent_end",          description: "Run tests after code changes" },
  { key: "diffSummarizer",    name: "Diff Summarizer",    hookType: "agent_end",          description: "Summarize file changes after each run" },
  { key: "undoCheckpoint",    name: "Undo Checkpoint",    hookType: "before_agent_start", description: "Git stash checkpoint before agent runs" },
  { key: "costTracker",       name: "Cost Tracker",       hookType: "turn_end",           description: "Track token usage and costs with budgets" },
  { key: "contextLoader",     name: "Context Loader",     hookType: "before_agent_start", description: "Auto-inject relevant docs based on paths" },
  { key: "styleEnforcer",     name: "Style Enforcer",     hookType: "tool_result",        description: "Run linters on written files" },
  { key: "sessionLogger",     name: "Session Logger",     hookType: "session_shutdown",   description: "Log session activity for team visibility" },
];

function getSettingsPath(scope: "project" | "global"): string {
  const configDir = process.env.PI_CONFIG_DIR || ".gsd";
  if (scope === "project") {
    return join(process.cwd(), configDir, "settings.json");
  }
  return join(homedir(), configDir, "agent", "settings.json");
}

function loadSettings(scope: "project" | "global"): Record<string, unknown> {
  const path = getSettingsPath(scope);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(scope: "project" | "global", settings: Record<string, unknown>): void {
  const path = getSettingsPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

function loadCommunityConfig(): CommunityHookConfig {
  // Project-level takes precedence
  for (const scope of ["project", "global"] as const) {
    const settings = loadSettings(scope);
    if (settings.communityHooks && typeof settings.communityHooks === "object") {
      return settings.communityHooks as CommunityHookConfig;
    }
  }
  return {};
}

function isHookEnabled(key: string, config: CommunityHookConfig): boolean {
  return config[key] ?? true; // Default: enabled
}

function formatStatus(enabled: boolean): string {
  return enabled ? "ON " : "OFF";
}

function formatStatsLine(stats: HookStats): string {
  if (stats.fires === 0) return "";
  const parts: string[] = [`${stats.fires} fires`];
  if (stats.actions > 0) parts.push(`${stats.actions} actions`);
  if (stats.lastDescription) parts.push(stats.lastDescription);
  return parts.join(", ");
}

// ─── Command Handlers ─────────────────────────────────────────────────────

function handleList(ctx: ExtensionCommandContext): void {
  const config = loadCommunityConfig();
  const allStats = getAllStats();

  const lines: string[] = [
    "Community Hooks",
    "═══════════════════════════════════════════════════════════",
    "",
  ];

  for (const hook of HOOK_METADATA) {
    const enabled = isHookEnabled(hook.key, config);
    const status = formatStatus(enabled);
    const stats = allStats.get(hook.key);
    const statsLine = stats ? formatStatsLine(stats) : "";

    lines.push(`  [${status}]  ${hook.name.padEnd(20)} ${hook.hookType.padEnd(18)} ${hook.description}`);
    if (statsLine) {
      lines.push(`          ${" ".padEnd(20)} ${"".padEnd(18)} Session: ${statsLine}`);
    }
  }

  const enabledCount = HOOK_METADATA.filter((h) => isHookEnabled(h.key, config)).length;
  lines.push("");
  lines.push(`${enabledCount}/${HOOK_METADATA.length} hooks active`);
  lines.push("");
  lines.push("Commands:");
  lines.push("  /gsd hooks enable <name>     Enable a hook");
  lines.push("  /gsd hooks disable <name>    Disable a hook");
  lines.push("  /gsd hooks info <name>       Show hook details and config");
  lines.push("  /gsd hooks stats             Show session statistics");
  lines.push("  /gsd hooks reset-stats       Reset session statistics");
  lines.push("  /gsd hooks enable-all        Enable all hooks");
  lines.push("  /gsd hooks disable-all       Disable all hooks");

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleToggle(hookName: string, enable: boolean, ctx: ExtensionCommandContext): void {
  const normalized = hookName.toLowerCase().replace(/[-_ ]/g, "");
  const hook = HOOK_METADATA.find((h) => h.key.toLowerCase() === normalized || h.name.toLowerCase().replace(/\s/g, "") === normalized);

  if (!hook) {
    const available = HOOK_METADATA.map((h) => h.key).join(", ");
    ctx.ui.notify(`Unknown hook: "${hookName}"\nAvailable: ${available}`, "error");
    return;
  }

  // Save to project-level settings
  const settings = loadSettings("project");
  const communityHooks = (settings.communityHooks ?? {}) as CommunityHookConfig;
  communityHooks[hook.key] = enable;
  settings.communityHooks = communityHooks;
  saveSettings("project", settings);

  const action = enable ? "enabled" : "disabled";
  ctx.ui.notify(`${hook.name} ${action}. Takes effect on next session start (/clear or restart).`, "info");
}

function handleToggleAll(enable: boolean, ctx: ExtensionCommandContext): void {
  const settings = loadSettings("project");
  const communityHooks: CommunityHookConfig = {};
  for (const hook of HOOK_METADATA) {
    communityHooks[hook.key] = enable;
  }
  settings.communityHooks = communityHooks;
  saveSettings("project", settings);

  const action = enable ? "enabled" : "disabled";
  ctx.ui.notify(`All community hooks ${action}. Takes effect on next session start.`, "info");
}

function handleInfo(hookName: string, ctx: ExtensionCommandContext): void {
  const normalized = hookName.toLowerCase().replace(/[-_ ]/g, "");
  const hook = HOOK_METADATA.find((h) => h.key.toLowerCase() === normalized || h.name.toLowerCase().replace(/\s/g, "") === normalized);

  if (!hook) {
    ctx.ui.notify(`Unknown hook: "${hookName}"`, "error");
    return;
  }

  const config = loadCommunityConfig();
  const enabled = isHookEnabled(hook.key, config);
  const stats = getAllStats().get(hook.key);

  const lines: string[] = [
    `${hook.name}`,
    `${"─".repeat(hook.name.length)}`,
    "",
    `Status:      ${enabled ? "Enabled" : "Disabled"}`,
    `Hook Type:   ${hook.hookType}`,
    `Config Key:  communityHooks.${hook.key}`,
    `Description: ${hook.description}`,
    "",
  ];

  if (stats && stats.fires > 0) {
    lines.push("Session Stats:");
    lines.push(`  Fires:       ${stats.fires}`);
    lines.push(`  Actions:     ${stats.actions}`);
    if (stats.lastAction) lines.push(`  Last Action: ${stats.lastAction}`);
    if (stats.lastDescription) lines.push(`  Last Detail: ${stats.lastDescription}`);
    lines.push("");
  }

  // Show hook-specific config hints
  const configHints = getConfigHints(hook.key);
  if (configHints) {
    lines.push("Configuration:");
    lines.push(configHints);
    lines.push("");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function getConfigHints(key: string): string | null {
  switch (key) {
    case "fileGuardrails":
      return `  Add to settings.json:
  "fileGuardrails": {
    "protectedFiles": [".env", "package-lock.json", ...],
    "protectedDirs": [".github/workflows", ...],
    "strict": false  // true = block, false = warn
  }`;
    case "costTracker":
      return `  Add to settings.json:
  "costTracker": {
    "budgetUsd": 100,       // Monthly budget (alerts at 50/80/100%)
    "showPerTurn": false    // Show cost per turn in status bar
  }`;
    case "secretScanner":
      return `  Scans for: AWS keys, GitHub/GitLab tokens, API keys, private keys,
  JWTs, Stripe keys, Slack tokens, database URLs, and generic secrets.
  Skips: test files, fixtures, binary files, node_modules.`;
    case "autoTestRunner":
      return `  Auto-detects: npm test, vitest, jest, mocha, pytest, cargo test,
  go test, rspec. Only runs when the agent wrote/edited files.`;
    case "styleEnforcer":
      return `  Auto-detects: ESLint, Biome, Prettier, Ruff, Clippy, golangci-lint.
  Linter warnings are appended to tool results for self-correction.`;
    case "sessionLogger":
      return `  Logs saved to: .gsd/session-logs/ (JSON + Markdown)
  Includes: tool usage, files modified/created, timing, summary.`;
    case "undoCheckpoint":
      return `  Creates git stash snapshots before each agent run.
  Keeps last 20 checkpoints, auto-cleans older ones.
  Recover with: git stash list | grep gsd-checkpoint`;
    case "contextLoader":
      return `  Injects: README.md, ARCHITECTURE.md, CONTRIBUTING.md, DESIGN.md,
  CHANGELOG.md, and recent ADRs found near mentioned file paths.`;
    case "diffSummarizer":
      return `  Shows git diff --numstat summary after each agent run.
  Lists modified and new files with insertion/deletion counts.`;
    case "dependencyAuditor":
      return `  Supports: npm audit, yarn audit, pnpm audit, pip-audit,
  cargo audit, govulncheck. Runs automatically after installs.`;
    default:
      return null;
  }
}

function handleStats(ctx: ExtensionCommandContext): void {
  const allStats = getAllStats();

  if (allStats.size === 0) {
    ctx.ui.notify("No hook activity this session.", "info");
    return;
  }

  const lines: string[] = [
    "Community Hooks — Session Statistics",
    "════════════════════════════════════",
    "",
    `${"Hook".padEnd(22)} ${"Fires".padEnd(8)} ${"Actions".padEnd(10)} Last Activity`,
    `${"─".repeat(22)} ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(30)}`,
  ];

  let totalFires = 0;
  let totalActions = 0;

  for (const hook of HOOK_METADATA) {
    const stats = allStats.get(hook.key);
    if (!stats || stats.fires === 0) continue;

    totalFires += stats.fires;
    totalActions += stats.actions;

    const lastDesc = stats.lastDescription ?? "—";
    lines.push(
      `${hook.name.padEnd(22)} ${String(stats.fires).padEnd(8)} ${String(stats.actions).padEnd(10)} ${lastDesc}`,
    );
  }

  lines.push("");
  lines.push(`Total: ${totalFires} fires, ${totalActions} actions`);

  ctx.ui.notify(lines.join("\n"), "info");
}

function handleResetStats(ctx: ExtensionCommandContext): void {
  resetStats();
  ctx.ui.notify("Session statistics reset.", "info");
}

// ─── Command Router ───────────────────────────────────────────────────────

export function registerHooksCommand(pi: ExtensionAPI): void {
  pi.registerCommand({
    name: "community-hooks",
    aliases: ["ch"],
    description: "Manage community hooks (list, enable, disable, stats)",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      routeCommand(trimmed, ctx);
    },
    completions: (partial) => {
      const subcommands = [
        { value: "list", label: "list", description: "List all hooks with status" },
        { value: "enable", label: "enable", description: "Enable a hook" },
        { value: "disable", label: "disable", description: "Disable a hook" },
        { value: "info", label: "info", description: "Show hook details" },
        { value: "stats", label: "stats", description: "Show session statistics" },
        { value: "reset-stats", label: "reset-stats", description: "Reset session stats" },
        { value: "enable-all", label: "enable-all", description: "Enable all hooks" },
        { value: "disable-all", label: "disable-all", description: "Disable all hooks" },
      ];

      const parts = partial.trim().split(/\s+/);
      if (parts.length <= 1) {
        return subcommands.filter((s) => s.value.startsWith(parts[0] ?? ""));
      }

      // Hook name completions for enable/disable/info
      if (["enable", "disable", "info"].includes(parts[0])) {
        const hookPart = parts[1] ?? "";
        return HOOK_METADATA
          .filter((h) => h.key.toLowerCase().startsWith(hookPart.toLowerCase()))
          .map((h) => ({
            value: `${parts[0]} ${h.key}`,
            label: h.key,
            description: h.name,
          }));
      }

      return [];
    },
  });
}

/** Route from `/gsd hooks` subcommands. Called by the GSD command handler. */
export function routeCommand(args: string, ctx: ExtensionCommandContext): void {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0] ?? "";
  const hookArg = parts.slice(1).join(" ");

  switch (subcommand) {
    case "":
    case "list":
      handleList(ctx);
      break;
    case "enable":
      if (!hookArg) {
        ctx.ui.notify("Usage: /gsd hooks enable <hook-name>", "warning");
      } else {
        handleToggle(hookArg, true, ctx);
      }
      break;
    case "disable":
      if (!hookArg) {
        ctx.ui.notify("Usage: /gsd hooks disable <hook-name>", "warning");
      } else {
        handleToggle(hookArg, false, ctx);
      }
      break;
    case "info":
      if (!hookArg) {
        ctx.ui.notify("Usage: /gsd hooks info <hook-name>", "warning");
      } else {
        handleInfo(hookArg, ctx);
      }
      break;
    case "stats":
      handleStats(ctx);
      break;
    case "reset-stats":
      handleResetStats(ctx);
      break;
    case "enable-all":
      handleToggleAll(true, ctx);
      break;
    case "disable-all":
      handleToggleAll(false, ctx);
      break;
    default:
      // Maybe they passed a hook name directly — treat as "info"
      handleInfo(subcommand, ctx);
      break;
  }
}
