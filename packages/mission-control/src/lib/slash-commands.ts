/**
 * Slash command registry with prefix filtering.
 *
 * Three sources:
 * 1. GSD 2 workflow commands (/gsd subcommands)
 * 2. Native Claude Code commands (/help, /clear, etc.)
 * 3. User custom commands from ~/.claude/commands/ and .claude/commands/
 *
 * Pure data module -- no server imports. Used by ChatInput for autocomplete.
 */

export interface SlashCommand {
  command: string;
  description: string;
  args: string;
  source: "gsd" | "claude" | "custom";
}

export const GSD_COMMANDS: SlashCommand[] = [
  { command: "/gsd", description: "Guided mode — reads project state, shows what's next", args: "", source: "gsd" },
  { command: "/gsd auto", description: "Autonomous mode — research, plan, execute, commit, repeat", args: "", source: "gsd" },
  { command: "/gsd stop", description: "Stop auto mode gracefully", args: "", source: "gsd" },
  { command: "/gsd discuss", description: "Discuss architecture and decisions", args: "", source: "gsd" },
  { command: "/gsd status", description: "Progress dashboard", args: "", source: "gsd" },
  { command: "/gsd queue", description: "Queue future milestones", args: "", source: "gsd" },
  { command: "/gsd prefs", description: "Model selection, timeouts, budget ceiling", args: "", source: "gsd" },
  { command: "/gsd migrate", description: "Migrate v1 .planning/ directory to .gsd/ format", args: "", source: "gsd" },
  { command: "/gsd doctor", description: "Validate .gsd/ integrity, find and fix issues", args: "", source: "gsd" },
];

export const CLAUDE_CODE_COMMANDS: SlashCommand[] = [
  { command: "/help", description: "Show available commands", args: "", source: "claude" },
  { command: "/clear", description: "Clear conversation history", args: "", source: "claude" },
  { command: "/compact", description: "Compact conversation to save context", args: "[instructions]", source: "claude" },
  { command: "/model", description: "Switch or display current model", args: "[model-name]", source: "claude" },
  { command: "/cost", description: "Show token usage and cost", args: "", source: "claude" },
  { command: "/login", description: "Log in to your account", args: "", source: "claude" },
  { command: "/logout", description: "Log out of your account", args: "", source: "claude" },
  { command: "/doctor", description: "Check Claude Code health", args: "", source: "claude" },
  { command: "/permissions", description: "View or modify permissions", args: "", source: "claude" },
  { command: "/memory", description: "Edit CLAUDE.md memory files", args: "", source: "claude" },
  { command: "/review", description: "Review a pull request", args: "[pr-url]", source: "claude" },
  { command: "/terminal-setup", description: "Install terminal integration", args: "", source: "claude" },
  { command: "/bug", description: "Report a bug", args: "", source: "claude" },
  { command: "/status", description: "Show status of current session", args: "", source: "claude" },
  { command: "/config", description: "View or modify configuration", args: "[key] [value]", source: "claude" },
  { command: "/listen", description: "Listen for terminal commands", args: "", source: "claude" },
  { command: "/mcp", description: "Manage MCP servers", args: "[subcommand]", source: "claude" },
  { command: "/vim", description: "Enter vim mode", args: "", source: "claude" },
  { command: "/init", description: "Initialize CLAUDE.md in project", args: "", source: "claude" },
  { command: "/pr-comments", description: "View PR comments", args: "", source: "claude" },
  { command: "/add-dir", description: "Add directory to context", args: "<path>", source: "claude" },
  { command: "/release-notes", description: "Generate release notes", args: "", source: "claude" },
];

/** Mutable store for dynamically discovered custom commands. */
let customCommands: SlashCommand[] = [];

/**
 * Set custom commands discovered from ~/.claude/commands/ and .claude/commands/.
 * Called from server-side discovery, passed to client via initial state or API.
 */
export function setCustomCommands(commands: SlashCommand[]): void {
  customCommands = commands;
}

/**
 * Get all registered custom commands.
 */
export function getCustomCommands(): SlashCommand[] {
  return customCommands;
}

/**
 * Get all available slash commands from all three sources.
 */
export function getAllCommands(): SlashCommand[] {
  return [...GSD_COMMANDS, ...CLAUDE_CODE_COMMANDS, ...customCommands];
}

// Legacy type alias for backward compat
export type GsdCommand = SlashCommand;

/**
 * Filter commands by prefix across all sources (GSD, Claude Code, custom).
 * Returns all commands if input is just "/".
 * Returns empty array if input doesn't start with "/".
 */
export function filterCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const all = getAllCommands();
  if (input === "/") return all;
  return all.filter((c) => c.command.startsWith(input));
}
