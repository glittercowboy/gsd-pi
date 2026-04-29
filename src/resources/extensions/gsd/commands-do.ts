/**
 * GSD Command — /gsd do
 *
 * Routes freeform natural language to the correct /gsd subcommand
 * using keyword matching. Falls back to /gsd quick for task-like input.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

export interface DoRoute {
  keywords: string[];
  command: string;
  acceptsArgs?: boolean;
}

export const ROUTES: DoRoute[] = [
  { keywords: ["progress", "status", "dashboard", "how far", "where are we", "show me progress"], command: "status" },
  { keywords: ["auto", "autonomous", "run all", "keep going", "start auto", "run autonomously"], command: "auto", acceptsArgs: true },
  { keywords: ["stop", "halt", "abort"], command: "stop" },
  { keywords: ["pause", "break", "take a break"], command: "pause" },
  { keywords: ["history", "past", "what happened", "previous"], command: "history", acceptsArgs: true },
  { keywords: ["doctor", "health", "diagnose", "check health"], command: "doctor", acceptsArgs: true },
  { keywords: ["clean up", "cleanup", "remove old", "prune", "tidy"], command: "cleanup" },
  { keywords: ["export", "report", "share results"], command: "export", acceptsArgs: true },
  { keywords: ["ship", "pull request", "create pr", "open pr", "merge"], command: "ship", acceptsArgs: true },
  { keywords: ["discuss", "talk about", "architecture", "design"], command: "discuss" },
  { keywords: ["undo", "revert", "rollback", "take back"], command: "undo" },
  { keywords: ["skip", "skip task", "skip this"], command: "skip", acceptsArgs: true },
  { keywords: ["queue", "reorder", "milestone order", "order milestones"], command: "queue" },
  { keywords: ["visualize", "viz", "graph", "chart", "show graph"], command: "visualize" },
  { keywords: ["capture", "note", "idea", "thought", "remember"], command: "capture", acceptsArgs: true },
  { keywords: ["inspect", "database", "sqlite", "db state"], command: "inspect" },
  { keywords: ["knowledge", "rule", "pattern", "lesson"], command: "knowledge", acceptsArgs: true },
  { keywords: ["session report", "session summary", "cost summary", "how much"], command: "session-report", acceptsArgs: true },
  { keywords: ["backlog", "parking lot", "later", "someday"], command: "backlog" },
  { keywords: ["pr branch", "clean branch", "filter commits"], command: "pr-branch" },
  { keywords: ["add tests", "write tests", "generate tests", "test coverage"], command: "add-tests", acceptsArgs: true },
  { keywords: ["next", "step", "next step", "what's next"], command: "next", acceptsArgs: true },
  { keywords: ["migrate", "migration", "convert", "upgrade"], command: "migrate", acceptsArgs: true },
  { keywords: ["steer", "change direction", "pivot", "redirect"], command: "steer", acceptsArgs: true },
  { keywords: ["park", "shelve", "set aside"], command: "park", acceptsArgs: true },
  { keywords: ["widget", "toggle widget"], command: "widget", acceptsArgs: true },
  { keywords: ["logs", "debug logs", "log files"], command: "logs", acceptsArgs: true },
  { keywords: ["debug", "debug session", "investigate", "troubleshoot", "diagnose issue"], command: "debug", acceptsArgs: true },
];

export interface MatchResult {
  command: string;
  remainingArgs: string;
  score: number;
}

interface CompiledRoute extends DoRoute {
  patterns: Array<{ keyword: string; regex: RegExp }>;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function keywordPattern(keyword: string, acceptsArgs: boolean): RegExp {
  const escaped = keyword
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  return acceptsArgs
    ? new RegExp(`^${escaped}(?:\\s+(.+))?$`, "i")
    : new RegExp(`^${escaped}$`, "i");
}

const COMPILED_ROUTES: CompiledRoute[] = ROUTES.map((route) => ({
  ...route,
  patterns: route.keywords.map((keyword) => ({
    keyword,
    regex: keywordPattern(keyword, route.acceptsArgs === true),
  })),
}));

export function matchRoute(input: string): MatchResult | null {
  const trimmed = input.trim();
  let bestMatch: MatchResult | null = null;

  for (const route of COMPILED_ROUTES) {
    for (const { keyword, regex } of route.patterns) {
      const match = trimmed.match(regex);
      if (match) {
        const score = keyword.length; // Longer match = higher confidence
        if (!bestMatch || score > bestMatch.score) {
          const remaining = route.acceptsArgs === true ? (match[1] ?? "").trim() : "";
          bestMatch = { command: route.command, remainingArgs: remaining, score };
        }
      }
    }
  }

  return bestMatch;
}

export async function handleDo(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!args.trim()) {
    ctx.ui.notify(
      "Usage: /gsd do <what you want to do>\n\n" +
      "Examples:\n" +
      "  /gsd do show me progress\n" +
      "  /gsd do run autonomously\n" +
      "  /gsd do clean up old branches\n" +
      "  /gsd do fix the login bug",
      "warning",
    );
    return;
  }

  const match = matchRoute(args);

  if (match) {
    const fullCommand = match.remainingArgs
      ? `${match.command} ${match.remainingArgs}`
      : match.command;

    ctx.ui.notify(`→ /gsd ${fullCommand}`, "info");

    // Re-dispatch through the main dispatcher
    const { handleGSDCommand } = await import("./commands/dispatcher.js");
    await handleGSDCommand(fullCommand, ctx, pi);
    return;
  }

  // No keyword match → treat as quick task
  ctx.ui.notify(`→ /gsd quick ${args}`, "info");
  const { handleQuick } = await import("./quick.js");
  await handleQuick(args, ctx, pi);
}
