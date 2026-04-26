import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { loadRegistry } from "../workflow-templates.js";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");

export interface GsdCommandDefinition {
  cmd: string;
  desc: string;
}

type CompletionMap = Record<string, readonly GsdCommandDefinition[]>;

export const GSD_COMMAND_DESCRIPTION =
  "GSD — Get Shit Done: /gsd help|start|templates|next|auto|stop|pause|status|widget|visualize|queue|quick|discuss|capture|triage|dispatch|history|undo|undo-task|reset-slice|rate|skip|export|cleanup|model|mode|prefs|config|keys|hooks|run-hook|skill-health|doctor|debug|logs|forensics|changelog|migrate|remote|steer|knowledge|new-milestone|parallel|cmux|park|unpark|init|setup|onboarding|inspect|extensions|update|fast|mcp|rethink|workflow|codebase|notifications|ship|do|session-report|backlog|pr-branch|add-tests|scan|language";

export const TOP_LEVEL_SUBCOMMANDS: readonly GsdCommandDefinition[] = [
  { cmd: "help", desc: "Categorized command reference with descriptions" },
  { cmd: "next", desc: "Explicit step mode (same as /gsd)" },
  { cmd: "auto", desc: "Autonomous mode — research, plan, execute, commit, repeat" },
  { cmd: "stop", desc: "Stop auto mode gracefully" },
  { cmd: "pause", desc: "Pause auto-mode (preserves state, /gsd auto to resume)" },
  { cmd: "status", desc: "Progress dashboard" },
  { cmd: "widget", desc: "Cycle widget: full → small → min → off" },
  { cmd: "visualize", desc: "Open 10-tab workflow visualizer (progress, timeline, deps, metrics, health, agent, changes, knowledge, captures, export)" },
  { cmd: "queue", desc: "Queue and reorder future milestones" },
  { cmd: "quick", desc: "Execute a quick task without full planning overhead" },
  { cmd: "discuss", desc: "Discuss architecture and decisions" },
  { cmd: "capture", desc: "Fire-and-forget thought capture" },
  { cmd: "changelog", desc: "Show categorized release notes" },
  { cmd: "triage", desc: "Manually trigger triage of pending captures" },
  { cmd: "dispatch", desc: "Dispatch a specific phase directly" },
  { cmd: "history", desc: "View execution history" },
  { cmd: "undo", desc: "Revert last completed unit" },
  { cmd: "undo-task", desc: "Reset a specific task's completion state (DB + markdown)" },
  { cmd: "reset-slice", desc: "Reset a slice and all its tasks (DB + markdown)" },
  { cmd: "rate", desc: "Rate last unit's model tier (over/ok/under) — improves adaptive routing" },
  { cmd: "skip", desc: "Prevent a unit from auto-mode dispatch" },
  { cmd: "export", desc: "Export milestone/slice results" },
  { cmd: "cleanup", desc: "Remove merged branches or snapshots" },
  { cmd: "model", desc: "Switch the active session model or open a picker" },
  { cmd: "mode", desc: "Switch workflow mode (solo/team)" },
  { cmd: "prefs", desc: "Manage preferences (model selection, timeouts, etc.)" },
  { cmd: "config", desc: "(deprecated) Set tool API keys — use /gsd keys instead" },
  { cmd: "keys", desc: "API key manager — list, add, remove, test, rotate, doctor" },
  { cmd: "hooks", desc: "Show configured post-unit and pre-dispatch hooks" },
  { cmd: "run-hook", desc: "Manually trigger a specific hook" },
  { cmd: "skill-health", desc: "Skill lifecycle dashboard" },
  { cmd: "notifications", desc: "View, filter, and clear persistent notification history" },
  { cmd: "doctor", desc: "Runtime health checks with auto-fix" },
  { cmd: "logs", desc: "Browse activity logs, debug logs, and metrics" },
  { cmd: "debug", desc: "Create and inspect persistent /gsd debug sessions" },
  { cmd: "forensics", desc: "Examine execution logs" },
  { cmd: "init", desc: "Project init wizard — detect, configure, bootstrap .gsd/" },
  { cmd: "setup", desc: "Configuration hub: status + sub-routes (llm, model, search, remote, keys, prefs, onboarding)" },
  { cmd: "onboarding", desc: "Re-run the setup wizard  [--resume|--reset|--step <name>]" },
  { cmd: "migrate", desc: "Migrate a v1 .planning directory to .gsd format" },
  { cmd: "remote", desc: "Control remote auto-mode" },
  { cmd: "steer", desc: "Hard-steer plan documents during execution" },
  { cmd: "inspect", desc: "Show SQLite DB diagnostics" },
  { cmd: "knowledge", desc: "Add persistent project knowledge (rule, pattern, or lesson)" },
  { cmd: "new-milestone", desc: "Create a milestone from a specification document (headless)" },
  { cmd: "parallel", desc: "Parallel milestone orchestration (start, status, stop, merge, watch)" },
  { cmd: "cmux", desc: "Manage cmux integration (status, sidebar, notifications, splits)" },
  { cmd: "park", desc: "Park a milestone — skip without deleting" },
  { cmd: "unpark", desc: "Reactivate a parked milestone" },
  { cmd: "update", desc: "Update GSD to the latest version" },
  { cmd: "start", desc: "Start a workflow template (bugfix, spike, feature, etc.)" },
  { cmd: "templates", desc: "List available workflow templates" },
  { cmd: "extensions", desc: "Manage extensions (list, enable, disable, info)" },
  { cmd: "fast", desc: "Toggle OpenAI service tier (on/off/flex/status)" },
  { cmd: "mcp", desc: "MCP server status, connectivity, and local config bootstrap (status, check, init)" },
  { cmd: "rethink", desc: "Conversational project reorganization — reorder, park, discard, add milestones" },
  { cmd: "workflow", desc: "Custom workflow lifecycle (new, run, list, info, install, uninstall, validate, pause, resume) or run <name> directly" },
  { cmd: "codebase", desc: "Generate, refresh, and inspect the codebase map cache (.gsd/CODEBASE.md)" },
  { cmd: "ship", desc: "Create PR from milestone artifacts and open for review" },
  { cmd: "do", desc: "Route freeform text to the right GSD command" },
  { cmd: "session-report", desc: "Session cost, tokens, and work summary" },
  { cmd: "backlog", desc: "Manage backlog items (add, promote, remove, list)" },
  { cmd: "pr-branch", desc: "Create clean PR branch filtering .gsd/ commits" },
  { cmd: "add-tests", desc: "Generate tests for completed slices" },
  { cmd: "scan", desc: "Rapid codebase assessment — lightweight alternative to full map (--focus tech|arch|quality|concerns|tech+arch)" },
  { cmd: "language", desc: "Set or clear the global response language (e.g. /gsd language Chinese)" },
];

const NESTED_COMPLETIONS: CompletionMap = {
  auto: [
    { cmd: "--verbose", desc: "Show detailed execution output" },
    { cmd: "--debug", desc: "Enable debug logging" },
  ],
  next: [
    { cmd: "--verbose", desc: "Show detailed step output" },
    { cmd: "--dry-run", desc: "Preview next step without executing" },
    { cmd: "--debug", desc: "Enable debug logging" },
  ],
  widget: [
    { cmd: "full", desc: "Full widget display" },
    { cmd: "small", desc: "Compact widget display" },
    { cmd: "min", desc: "Minimal widget display" },
    { cmd: "off", desc: "Hide widget" },
  ],
  mode: [
    { cmd: "global", desc: "Edit global workflow mode" },
    { cmd: "project", desc: "Edit project-specific workflow mode" },
  ],
  parallel: [
    { cmd: "start", desc: "Start parallel milestone orchestration" },
    { cmd: "status", desc: "Show parallel worker statuses" },
    { cmd: "stop", desc: "Stop all parallel workers" },
    { cmd: "pause", desc: "Pause a specific worker" },
    { cmd: "resume", desc: "Resume a paused worker" },
    { cmd: "merge", desc: "Merge completed milestone branches" },
    { cmd: "watch", desc: "Live TUI dashboard monitoring all workers" },
  ],
  setup: [
    { cmd: "llm", desc: "Configure LLM provider & auth" },
    { cmd: "model", desc: "Pick default model for the active provider" },
    { cmd: "search", desc: "Configure web search provider" },
    { cmd: "remote", desc: "Configure remote integrations (Discord/Slack/Telegram)" },
    { cmd: "keys", desc: "Manage API keys (alias for /gsd keys)" },
    { cmd: "prefs", desc: "Global preferences wizard (alias for /gsd prefs)" },
    { cmd: "onboarding", desc: "Run the full onboarding wizard (alias for /gsd onboarding)" },
  ],
  onboarding: [
    { cmd: "--resume", desc: "Resume from the last completed step" },
    { cmd: "--reset", desc: "Reset onboarding state and start over (does not clear API keys)" },
    { cmd: "--step", desc: "Run a single step: llm|model|search|remote|tool-keys|prefs|skills|doctor|project" },
  ],
  notifications: [
    { cmd: "clear", desc: "Clear all notifications" },
    { cmd: "tail", desc: "Show last N notifications (default: 20)" },
    { cmd: "filter", desc: "Filter by severity (error|warning|info|success)" },
  ],
  logs: [
    { cmd: "debug", desc: "List or view debug log files" },
    { cmd: "tail", desc: "Show last N activity log summaries" },
    { cmd: "clear", desc: "Remove old activity and debug logs" },
  ],
  debug: [
    { cmd: "list", desc: "List persisted debug sessions" },
    { cmd: "status", desc: "Show status for one debug session slug" },
    { cmd: "continue", desc: "Resume an existing debug session slug" },
    { cmd: "--diagnose", desc: "Inspect malformed artifacts and session health" },
  ],
  keys: [
    { cmd: "list", desc: "Show key status dashboard" },
    { cmd: "add", desc: "Add a key for a provider" },
    { cmd: "remove", desc: "Remove a key" },
    { cmd: "test", desc: "Validate key(s) with API call" },
    { cmd: "rotate", desc: "Replace an existing key" },
    { cmd: "doctor", desc: "Health check all keys" },
  ],
  prefs: [
    { cmd: "global", desc: "Edit global preferences file" },
    { cmd: "project", desc: "Edit project preferences file" },
    { cmd: "status", desc: "Show effective preferences" },
    { cmd: "wizard", desc: "Interactive preferences wizard" },
    { cmd: "setup", desc: "First-time preferences setup" },
    { cmd: "import-claude", desc: "Import settings from Claude Code" },
  ],
  remote: [
    { cmd: "slack", desc: "Configure Slack integration" },
    { cmd: "discord", desc: "Configure Discord integration" },
    { cmd: "status", desc: "Show remote connection status" },
    { cmd: "disconnect", desc: "Disconnect remote integrations" },
  ],
  history: [
    { cmd: "--cost", desc: "Show cost breakdown per entry" },
    { cmd: "--phase", desc: "Filter by phase type" },
    { cmd: "--model", desc: "Filter by model used" },
    { cmd: "10", desc: "Show last 10 entries" },
    { cmd: "20", desc: "Show last 20 entries" },
    { cmd: "50", desc: "Show last 50 entries" },
  ],
  export: [
    { cmd: "--json", desc: "Export as JSON" },
    { cmd: "--markdown", desc: "Export as Markdown" },
    { cmd: "--html", desc: "Export as HTML" },
    { cmd: "--html --all", desc: "Export all milestones as HTML" },
  ],
  cleanup: [
    { cmd: "branches", desc: "Remove merged milestone and legacy branches" },
    { cmd: "snapshots", desc: "Remove old execution snapshots" },
    { cmd: "worktrees", desc: "Remove merged/safe-to-delete worktrees" },
    { cmd: "projects", desc: "Audit orphaned ~/.gsd/projects/ state directories" },
    { cmd: "projects --fix", desc: "Delete orphaned project state directories (cannot be undone)" },
  ],
  knowledge: [
    { cmd: "rule", desc: "Add a project rule (always/never do X)" },
    { cmd: "pattern", desc: "Add a code pattern to follow" },
    { cmd: "lesson", desc: "Record a lesson learned" },
  ],
  start: [
    { cmd: "bugfix", desc: "Triage, fix, test, and ship a bug fix" },
    { cmd: "small-feature", desc: "Lightweight feature with optional discussion" },
    { cmd: "spike", desc: "Research, prototype, and document findings" },
    { cmd: "hotfix", desc: "Minimal: fix it, test it, ship it" },
    { cmd: "refactor", desc: "Inventory, plan waves, migrate, verify" },
    { cmd: "security-audit", desc: "Scan, triage, remediate, re-scan" },
    { cmd: "dep-upgrade", desc: "Assess, upgrade, fix breaks, verify" },
    { cmd: "full-project", desc: "Complete GSD workflow with full ceremony" },
    { cmd: "resume", desc: "Resume an in-progress workflow" },
    { cmd: "--list", desc: "List all available templates" },
    { cmd: "--dry-run", desc: "Preview workflow without executing" },
  ],
  templates: [
    { cmd: "info", desc: "Show detailed template info" },
  ],
  extensions: [
    { cmd: "list", desc: "List all extensions and their status" },
    { cmd: "enable", desc: "Enable a disabled extension" },
    { cmd: "disable", desc: "Disable an extension" },
    { cmd: "info", desc: "Show extension details" },
  ],
  fast: [
    { cmd: "on", desc: "Priority tier (2x cost, faster)" },
    { cmd: "off", desc: "Disable service tier" },
    { cmd: "flex", desc: "Flex tier (0.5x cost, slower)" },
    { cmd: "status", desc: "Show current service tier setting" },
  ],
  mcp: [
    { cmd: "status", desc: "Show all MCP server statuses (default)" },
    { cmd: "check", desc: "Detailed status for a specific server" },
    { cmd: "init", desc: "Write .mcp.json for the local GSD workflow MCP server" },
  ],
  doctor: [
    { cmd: "fix", desc: "Auto-fix detected issues" },
    { cmd: "heal", desc: "AI-driven deep healing" },
    { cmd: "audit", desc: "Run health audit without fixing" },
    { cmd: "--dry-run", desc: "Show what --fix would change without applying" },
    { cmd: "--json", desc: "Output report as JSON (CI/tooling friendly)" },
    { cmd: "--build", desc: "Include slow build health check (npm run build)" },
    { cmd: "--test", desc: "Include slow test health check (npm test)" },
  ],
  dispatch: [
    { cmd: "research", desc: "Run research phase" },
    { cmd: "plan", desc: "Run planning phase" },
    { cmd: "execute", desc: "Run execution phase" },
    { cmd: "complete", desc: "Run completion phase" },
    { cmd: "reassess", desc: "Reassess current progress" },
    { cmd: "uat", desc: "Run user acceptance testing" },
    { cmd: "replan", desc: "Replan the current slice" },
  ],
  rate: [
    { cmd: "over", desc: "Model was overqualified for this task" },
    { cmd: "ok", desc: "Model was appropriate for this task" },
    { cmd: "under", desc: "Model was underqualified for this task" },
  ],
  workflow: [
    { cmd: "new", desc: "Create a new workflow definition (via skill)" },
    { cmd: "run", desc: "Create a YAML run and start auto-mode" },
    { cmd: "list", desc: "List workflow runs" },
    { cmd: "info", desc: "Show plugin details (source, mode, phases)" },
    { cmd: "install", desc: "Install a plugin from a URL / gist: / gh:" },
    { cmd: "uninstall", desc: "Remove an installed plugin" },
    { cmd: "validate", desc: "Validate a workflow definition YAML" },
    { cmd: "pause", desc: "Pause custom workflow auto-mode" },
    { cmd: "resume", desc: "Resume paused custom workflow auto-mode" },
  ],
  codebase: [
    { cmd: "generate", desc: "Generate or regenerate CODEBASE.md" },
    { cmd: "generate --max-files", desc: "Generate with custom file limit (default: 500)" },
    { cmd: "generate --collapse-threshold", desc: "Generate with custom collapse threshold (default: 20)" },
    { cmd: "update", desc: "Refresh the CODEBASE.md cache immediately (preserves descriptions)" },
    { cmd: "update --max-files", desc: "Update with custom file limit" },
    { cmd: "update --collapse-threshold", desc: "Update with custom collapse threshold" },
    { cmd: "stats", desc: "Show file count, description coverage, and generation time" },
    { cmd: "help", desc: "Show usage and available subcommands" },
  ],
  ship: [
    { cmd: "--dry-run", desc: "Preview PR without creating" },
    { cmd: "--draft", desc: "Open as draft PR" },
    { cmd: "--base", desc: "Override target branch (default: main)" },
    { cmd: "--force", desc: "Ship even with pending tasks" },
  ],
  "session-report": [
    { cmd: "--json", desc: "Machine-readable JSON output" },
    { cmd: "--save", desc: "Save report to .gsd/reports/" },
  ],
  backlog: [
    { cmd: "add", desc: "Add item to backlog" },
    { cmd: "promote", desc: "Promote backlog item to active slice" },
    { cmd: "remove", desc: "Remove backlog item" },
  ],
  "pr-branch": [
    { cmd: "--dry-run", desc: "Preview what would be filtered" },
    { cmd: "--name", desc: "Custom branch name" },
  ],
  scan: [
    { cmd: "--focus tech", desc: "Technology stack and external integrations" },
    { cmd: "--focus arch", desc: "Architecture patterns and directory structure" },
    { cmd: "--focus quality", desc: "Coding conventions and testing patterns" },
    { cmd: "--focus concerns", desc: "Technical debt and risk areas" },
    { cmd: "--focus tech+arch", desc: "Tech + Architecture (default)" },
  ],
  language: [
    { cmd: "off",   desc: "Clear the language preference (revert to default)" },
    { cmd: "clear", desc: "Alias for off — clear the language preference" },
  ],
};

function filterOptions(
  partial: string,
  options: readonly GsdCommandDefinition[],
  prefix = "",
) {
  const normalizedPrefix = prefix ? `${prefix} ` : "";
  return options
    .filter((option) => option.cmd.startsWith(partial))
    .map((option) => ({
      value: `${normalizedPrefix}${option.cmd}`,
      label: option.cmd,
      description: option.desc,
    }));
}

function getExtensionCompletions(prefix: string, action: string) {
  try {
    const extDir = join(gsdHome, "agent", "extensions");
    const ids: Array<{ id: string; name: string }> = [];
    for (const entry of readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(extDir, entry.name, "extension-manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        if (typeof manifest?.id === "string") {
          ids.push({ id: manifest.id, name: manifest.name ?? manifest.id });
        }
      } catch {
        // ignore malformed manifests
      }
    }
    return ids
      .filter((entry) => entry.id.startsWith(prefix))
      .map((entry) => ({
        value: `extensions ${action} ${entry.id}`,
        label: entry.id,
        description: entry.name,
      }));
  } catch {
    return [];
  }
}

function normalizePathForCompare(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function findWorktreeSegment(normalizedPath: string): { gsdIdx: number; afterWorktrees: number } | null {
  const directMarker = "/.gsd/worktrees/";
  const directIdx = normalizedPath.indexOf(directMarker);
  if (directIdx !== -1) {
    return { gsdIdx: directIdx, afterWorktrees: directIdx + directMarker.length };
  }

  const symlinkMatch = normalizedPath.match(/\/\.gsd\/projects\/[a-f0-9]+\/worktrees\//);
  if (symlinkMatch?.index !== undefined) {
    return { gsdIdx: symlinkMatch.index, afterWorktrees: symlinkMatch.index + symlinkMatch[0].length };
  }

  return null;
}

function resolveProjectRootFromGitFile(worktreePath: string): string | null {
  try {
    let dir = worktreePath;
    for (let i = 0; i < 30; i++) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        const content = readFileSync(gitPath, "utf8").trim();
        if (content.startsWith("gitdir: ")) {
          const gitDir = resolve(dir, content.slice(8));
          const dotGitDir = resolve(gitDir, "..", "..");
          if (dotGitDir.endsWith(".git") || dotGitDir.endsWith(".git/") || dotGitDir.endsWith(".git\\")) {
            return resolve(dotGitDir, "..");
          }
          const commonDirPath = join(gitDir, "commondir");
          if (existsSync(commonDirPath)) {
            const commonDir = readFileSync(commonDirPath, "utf8").trim();
            return resolve(resolve(gitDir, commonDir), "..");
          }
        }
        break;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Completion must stay best-effort.
  }
  return null;
}

function resolveProjectRootForCompletion(basePath: string): string {
  if (process.env.GSD_PROJECT_ROOT) return process.env.GSD_PROJECT_ROOT;

  const normalizedPath = normalizePathForCompare(basePath);
  const segment = findWorktreeSegment(normalizedPath);
  if (!segment) return basePath;

  const separator = basePath.includes("\\") ? "\\" : "/";
  const gsdMarker = `${separator}.gsd${separator}`;
  const gsdIdx = basePath.indexOf(gsdMarker);
  const candidate = gsdIdx !== -1 ? basePath.slice(0, gsdIdx) : basePath.slice(0, segment.gsdIdx);

  const normalizedGsdHome = normalizePathForCompare(gsdHome);
  const candidateGsdPath = normalizePathForCompare(join(candidate, ".gsd"));
  if (candidateGsdPath === normalizedGsdHome || candidateGsdPath.startsWith(`${normalizedGsdHome}/`)) {
    return resolveProjectRootFromGitFile(basePath) ?? basePath;
  }

  return candidate;
}

export function getGsdArgumentCompletions(prefix: string) {
  const hasTrailingSpace = prefix.endsWith(" ");
  const parts = prefix.trim().split(/\s+/);
  if (hasTrailingSpace && parts.length >= 1) {
    parts.push("");
  }

  if (parts.length <= 1) {
    return filterOptions(parts[0] ?? "", TOP_LEVEL_SUBCOMMANDS);
  }

  const [command, subcommand = "", third = ""] = parts;

  if (command === "cmux") {
    if (parts.length <= 2) {
      return filterOptions(subcommand, [
        { cmd: "status", desc: "Show cmux detection, prefs, and capabilities" },
        { cmd: "on", desc: "Enable cmux integration" },
        { cmd: "off", desc: "Disable cmux integration" },
        { cmd: "notifications", desc: "Toggle cmux desktop notifications" },
        { cmd: "sidebar", desc: "Toggle cmux sidebar metadata" },
        { cmd: "splits", desc: "Toggle cmux visual subagent splits" },
        { cmd: "browser", desc: "Toggle future browser integration flag" },
      ], "cmux");
    }
    if (parts.length <= 3 && ["notifications", "sidebar", "splits", "browser"].includes(subcommand)) {
      return filterOptions(third, [
        { cmd: "on", desc: "Enable this cmux area" },
        { cmd: "off", desc: "Disable this cmux area" },
      ], `cmux ${subcommand}`);
    }
    return [];
  }

  if (command === "templates" && subcommand === "info" && parts.length <= 3) {
    try {
      const registry = loadRegistry();
      return Object.entries(registry.templates)
        .filter(([id]) => id.startsWith(third))
        .map(([id, entry]) => ({
          value: `templates info ${id}`,
          label: id,
          description: entry.description,
        }));
    } catch {
      return [];
    }
  }

  if (command === "extensions" && parts.length === 3 && ["enable", "disable", "info"].includes(subcommand)) {
    return getExtensionCompletions(third, subcommand);
  }

  if (command === "undo" && parts.length <= 2) {
    return [{ value: "undo --force", label: "--force", description: "Skip confirmation prompt" }];
  }

  // Workflow definition-name completion for `workflow run <name>` and `workflow validate <name>`
  if (command === "workflow" && (subcommand === "run" || subcommand === "validate") && parts.length <= 3) {
    try {
      const defsDir = join(resolveProjectRootForCompletion(process.cwd()), ".gsd", "workflow-defs");
      if (existsSync(defsDir)) {
        return readdirSync(defsDir)
          .filter((f) => f.endsWith(".yaml") && f.startsWith(third))
          .map((f) => {
            const name = f.replace(/\.yaml$/, "");
            return {
              value: `workflow ${subcommand} ${name}`,
              label: name,
              description: `Workflow definition: ${name}`,
            };
          });
      }
    } catch {
      // ignore filesystem errors during completion
    }
    return [];
  }

  // Completion for `/gsd workflow info <name>` — list all discoverable plugins (project + global).
  if (command === "workflow" && subcommand === "info" && parts.length <= 3) {
    const results: GsdCommandDefinition[] = [];
    const seen = new Set<string>();
    const scanDir = (dir: string, source: string) => {
      if (!existsSync(dir)) return;
      try {
        for (const f of readdirSync(dir)) {
          if (!/\.(ya?ml|md)$/i.test(f)) continue;
          const name = f.replace(/\.(ya?ml|md)$/i, "");
          if (!name.startsWith(third)) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          results.push({ cmd: name, desc: `Workflow plugin (${source})` });
        }
      } catch { /* ignore */ }
    };
    try {
      const base = resolveProjectRootForCompletion(process.cwd());
      scanDir(join(base, ".gsd", "workflows"), "project");
      scanDir(join(base, ".gsd", "workflow-defs"), "project-legacy");
      scanDir(join(gsdHome, "workflows"), "global");
    } catch { /* ignore */ }
    // Also include bundled template names.
    try {
      const registry = loadRegistry();
      for (const id of Object.keys(registry.templates)) {
        if (seen.has(id) || !id.startsWith(third)) continue;
        seen.add(id);
        results.push({ cmd: id, desc: "Workflow plugin (bundled)" });
      }
    } catch { /* ignore */ }
    return results.map((r) => ({
      value: `workflow info ${r.cmd}`,
      label: r.cmd,
      description: r.desc,
    }));
  }

  const nested = NESTED_COMPLETIONS[command];
  if (nested && parts.length <= 2) {
    return filterOptions(subcommand, nested, command);
  }

  return [];
}
