import { importExtensionModule, type ExtensionAPI, type ExtensionCommandContext } from "@gsd/pi-coding-agent";

const TOP_LEVEL_SUBCOMMANDS = [
  { cmd: "help", desc: "Categorized command reference with descriptions" },
  { cmd: "next", desc: "Explicit step mode (same as /gsd)" },
  { cmd: "auto", desc: "Autonomous mode — research, plan, execute, commit, repeat" },
  { cmd: "stop", desc: "Stop auto mode gracefully" },
  { cmd: "pause", desc: "Pause auto-mode (preserves state, /gsd auto to resume)" },
  { cmd: "status", desc: "Progress dashboard" },
  { cmd: "visualize", desc: "Open workflow visualizer" },
  { cmd: "queue", desc: "Queue and reorder future milestones" },
  { cmd: "quick", desc: "Execute a quick task without full planning overhead" },
  { cmd: "discuss", desc: "Discuss architecture and decisions" },
  { cmd: "capture", desc: "Fire-and-forget thought capture" },
  { cmd: "changelog", desc: "Show categorized release notes" },
  { cmd: "triage", desc: "Manually trigger triage of pending captures" },
  { cmd: "dispatch", desc: "Dispatch a specific phase directly" },
  { cmd: "history", desc: "View execution history" },
  { cmd: "undo", desc: "Revert last completed unit" },
  { cmd: "skip", desc: "Prevent a unit from auto-mode dispatch" },
  { cmd: "export", desc: "Export milestone or slice results" },
  { cmd: "cleanup", desc: "Remove merged branches or snapshots" },
  { cmd: "mode", desc: "Switch workflow mode (solo/team)" },
  { cmd: "prefs", desc: "Manage preferences" },
  { cmd: "config", desc: "Set API keys for external tools" },
  { cmd: "keys", desc: "API key manager" },
  { cmd: "hooks", desc: "Show configured hooks" },
  { cmd: "run-hook", desc: "Manually trigger a specific hook" },
  { cmd: "skill-health", desc: "Skill lifecycle dashboard" },
  { cmd: "doctor", desc: "Runtime health checks with auto-fix" },
  { cmd: "logs", desc: "Browse activity logs, debug logs, and metrics" },
  { cmd: "forensics", desc: "Examine execution logs" },
  { cmd: "init", desc: "Project init wizard" },
  { cmd: "setup", desc: "Global setup status and configuration" },
  { cmd: "migrate", desc: "Migrate a v1 .planning directory to .gsd format" },
  { cmd: "remote", desc: "Control remote auto-mode" },
  { cmd: "steer", desc: "Hard-steer plan documents during execution" },
  { cmd: "inspect", desc: "Show SQLite DB diagnostics" },
  { cmd: "knowledge", desc: "Add persistent project knowledge" },
  { cmd: "new-milestone", desc: "Create a milestone from a specification document" },
  { cmd: "parallel", desc: "Parallel milestone orchestration" },
  { cmd: "park", desc: "Park a milestone" },
  { cmd: "unpark", desc: "Reactivate a parked milestone" },
  { cmd: "update", desc: "Update GSD to the latest version" },
  { cmd: "start", desc: "Start a workflow template" },
  { cmd: "templates", desc: "List available workflow templates" },
  { cmd: "extensions", desc: "Manage extensions" },
  { cmd: "codebase", desc: "Generate, refresh, and inspect the codebase map cache" },
] as const;

function filterStartsWith(
  partial: string,
  options: ReadonlyArray<{ cmd: string; desc: string }>,
  prefix = "",
) {
  const normalizedPrefix = prefix.length > 0 ? `${prefix} ` : "";
  return options
    .filter((option) => option.cmd.startsWith(partial))
    .map((option) => ({
      value: `${normalizedPrefix}${option.cmd}`,
      label: option.cmd,
      description: option.desc,
    }));
}

function getGsdArgumentCompletions(prefix: string) {
  const parts = prefix.trim().split(/\s+/);

  if (parts.length <= 1) {
    return filterStartsWith(parts[0] ?? "", TOP_LEVEL_SUBCOMMANDS);
  }

  const partial = parts[1] ?? "";

  if (parts[0] === "auto" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--verbose", desc: "Show detailed execution output" },
      { cmd: "--debug", desc: "Enable debug logging" },
    ], "auto");
  }

  if (parts[0] === "next" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--verbose", desc: "Show detailed step output" },
      { cmd: "--dry-run", desc: "Preview next step without executing" },
    ], "next");
  }

  if (parts[0] === "mode" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "global", desc: "Edit global workflow mode" },
      { cmd: "project", desc: "Edit project-specific workflow mode" },
    ], "mode");
  }

  if (parts[0] === "parallel" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "start", desc: "Start parallel milestone orchestration" },
      { cmd: "status", desc: "Show parallel worker statuses" },
      { cmd: "stop", desc: "Stop all parallel workers" },
      { cmd: "pause", desc: "Pause a specific worker" },
      { cmd: "resume", desc: "Resume a paused worker" },
      { cmd: "merge", desc: "Merge completed milestone branches" },
    ], "parallel");
  }

  if (parts[0] === "setup" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "llm", desc: "Configure LLM provider settings" },
      { cmd: "search", desc: "Configure web search provider" },
      { cmd: "remote", desc: "Configure remote integrations" },
      { cmd: "keys", desc: "Manage API keys" },
      { cmd: "prefs", desc: "Configure global preferences" },
    ], "setup");
  }

  if (parts[0] === "logs" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "debug", desc: "List or view debug log files" },
      { cmd: "tail", desc: "Show last N activity log summaries" },
      { cmd: "clear", desc: "Remove old activity and debug logs" },
    ], "logs");
  }

  if (parts[0] === "keys" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "list", desc: "Show key status dashboard" },
      { cmd: "add", desc: "Add a key for a provider" },
      { cmd: "remove", desc: "Remove a key" },
      { cmd: "test", desc: "Validate key(s) with API call" },
      { cmd: "rotate", desc: "Replace an existing key" },
      { cmd: "doctor", desc: "Health check all keys" },
    ], "keys");
  }

  if (parts[0] === "prefs" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "global", desc: "Edit global preferences file" },
      { cmd: "project", desc: "Edit project preferences file" },
      { cmd: "status", desc: "Show effective preferences" },
      { cmd: "wizard", desc: "Interactive preferences wizard" },
      { cmd: "setup", desc: "First-time preferences setup" },
      { cmd: "import-claude", desc: "Import settings from Claude Code" },
    ], "prefs");
  }

  if (parts[0] === "remote" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "slack", desc: "Configure Slack integration" },
      { cmd: "discord", desc: "Configure Discord integration" },
      { cmd: "status", desc: "Show remote connection status" },
      { cmd: "disconnect", desc: "Disconnect remote integrations" },
    ], "remote");
  }

  if (parts[0] === "history" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--cost", desc: "Show cost breakdown per entry" },
      { cmd: "--phase", desc: "Filter by phase type" },
      { cmd: "--model", desc: "Filter by model used" },
      { cmd: "10", desc: "Show last 10 entries" },
      { cmd: "20", desc: "Show last 20 entries" },
      { cmd: "50", desc: "Show last 50 entries" },
    ], "history");
  }

  if (parts[0] === "export" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "--json", desc: "Export as JSON" },
      { cmd: "--markdown", desc: "Export as Markdown" },
      { cmd: "--html", desc: "Export as HTML" },
      { cmd: "--html --all", desc: "Export all milestones as HTML" },
    ], "export");
  }

  if (parts[0] === "cleanup" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "branches", desc: "Remove merged milestone branches" },
      { cmd: "snapshots", desc: "Remove old execution snapshots" },
    ], "cleanup");
  }

  if (parts[0] === "knowledge" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "rule", desc: "Add a project rule" },
      { cmd: "pattern", desc: "Add a code pattern" },
      { cmd: "lesson", desc: "Record a lesson learned" },
    ], "knowledge");
  }

  if (parts[0] === "start" && parts.length <= 2) {
    return filterStartsWith(partial, [
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
    ], "start");
  }

  if (parts[0] === "templates" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "info", desc: "Show detailed template info" },
    ], "templates");
  }

  if (parts[0] === "extensions" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "list", desc: "List all extensions and their status" },
      { cmd: "enable", desc: "Enable a disabled extension" },
      { cmd: "disable", desc: "Disable an extension" },
      { cmd: "info", desc: "Show extension details" },
    ], "extensions");
  }

  if (parts[0] === "codebase" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "generate", desc: "Generate or regenerate CODEBASE.md" },
      { cmd: "update", desc: "Refresh the CODEBASE.md cache immediately" },
      { cmd: "stats", desc: "Show codebase-map coverage and generation time" },
      { cmd: "help", desc: "Show usage and subcommands" },
    ], "codebase");
  }

  if (parts[0] === "doctor" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "fix", desc: "Auto-fix detected issues" },
      { cmd: "heal", desc: "AI-driven deep healing" },
      { cmd: "audit", desc: "Run health audit without fixing" },
    ], "doctor");
  }

  if (parts[0] === "dispatch" && parts.length <= 2) {
    return filterStartsWith(partial, [
      { cmd: "research", desc: "Run research phase" },
      { cmd: "plan", desc: "Run planning phase" },
      { cmd: "execute", desc: "Run execution phase" },
      { cmd: "complete", desc: "Run completion phase" },
      { cmd: "reassess", desc: "Reassess current progress" },
      { cmd: "uat", desc: "Run user acceptance testing" },
      { cmd: "replan", desc: "Replan the current slice" },
    ], "dispatch");
  }

  return null;
}

export function registerLazyGSDCommand(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description: "GSD — Get Shit Done",
    getArgumentCompletions: getGsdArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { handleGSDCommand } = await importExtensionModule<typeof import("./commands.js")>(import.meta.url, "./commands.js");
      await handleGSDCommand(args, ctx, pi);
    },
  });
}
