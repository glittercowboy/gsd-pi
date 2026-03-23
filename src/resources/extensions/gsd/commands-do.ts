/**
 * GSD Command — /gsd do
 *
 * Routes freeform natural language to the correct /gsd subcommand
 * using keyword matching. Falls back to /gsd quick for task-like input.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

interface Route {
  keywords: string[];
  command: string;
}

const ROUTES: Route[] = [
  { keywords: ["progress", "status", "dashboard", "how far", "where are we"], command: "status" },
  { keywords: ["auto", "autonomous", "run all", "keep going", "start auto"], command: "auto" },
  { keywords: ["stop", "halt", "abort"], command: "stop" },
  { keywords: ["pause", "break", "take a break"], command: "pause" },
  { keywords: ["history", "past", "what happened", "previous"], command: "history" },
  { keywords: ["doctor", "health", "diagnose", "check health"], command: "doctor" },
  { keywords: ["clean up", "cleanup", "remove old", "prune", "tidy"], command: "cleanup" },
  { keywords: ["export", "report", "share results"], command: "export" },
  { keywords: ["ship", "pull request", "create pr", "open pr", "merge"], command: "ship" },
  { keywords: ["discuss", "talk about", "architecture", "design"], command: "discuss" },
  { keywords: ["undo", "revert", "rollback", "take back"], command: "undo" },
  { keywords: ["skip", "skip task", "skip this"], command: "skip" },
  { keywords: ["queue", "reorder", "milestone order", "order milestones"], command: "queue" },
  { keywords: ["visualize", "viz", "graph", "chart", "show graph"], command: "visualize" },
  { keywords: ["capture", "note", "idea", "thought", "remember"], command: "capture" },
  { keywords: ["inspect", "database", "sqlite", "db state"], command: "inspect" },
  { keywords: ["knowledge", "rule", "pattern", "lesson"], command: "knowledge" },
  { keywords: ["session report", "session summary", "cost summary", "how much"], command: "session-report" },
  { keywords: ["backlog", "parking lot", "later", "someday"], command: "backlog" },
  { keywords: ["pr branch", "clean branch", "filter commits"], command: "pr-branch" },
  { keywords: ["add tests", "write tests", "generate tests", "test coverage"], command: "add-tests" },
  { keywords: ["next", "step", "next step", "what's next"], command: "next" },
  { keywords: ["migrate", "migration", "convert", "upgrade"], command: "migrate" },
  { keywords: ["steer", "change direction", "pivot", "redirect"], command: "steer" },
  { keywords: ["park", "shelve", "set aside"], command: "park" },
  { keywords: ["widget", "toggle widget"], command: "widget" },
  { keywords: ["logs", "debug logs", "log files"], command: "logs" },
];

interface MatchResult {
  command: string;
  remainingArgs: string;
  score: number;
}

function matchRoute(input: string): MatchResult | null {
  const lower = input.toLowerCase();
  let bestMatch: MatchResult | null = null;

  for (const route of ROUTES) {
    for (const keyword of route.keywords) {
      if (lower.includes(keyword)) {
        const score = keyword.length; // Longer match = higher confidence
        if (!bestMatch || score > bestMatch.score) {
          // Strip the matched keyword from input to get remaining args
          const idx = lower.indexOf(keyword);
          const remaining = (input.slice(0, idx) + input.slice(idx + keyword.length)).trim();
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
