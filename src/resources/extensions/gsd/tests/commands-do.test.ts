import test from "node:test";
import assert from "node:assert/strict";

// ─── Mock dispatcher to capture routed commands ─────────────────────────

let lastRouted: string | null = null;
let lastQuick: string | null = null;

const mockCtx = {
  ui: {
    notify: (_msg: string, _level: string) => {},
  },
} as any;

// We test the keyword matching logic directly since the handler imports
// the dispatcher dynamically (which requires the full extension runtime).

// Inline the route-matching logic from commands-do.ts for unit testing.
interface Route {
  keywords: string[];
  command: string;
  acceptsArgs?: boolean;
}

const ROUTES: Route[] = [
  { keywords: ["progress", "status", "dashboard", "how far", "where are we", "show me progress"], command: "status" },
  { keywords: ["auto", "autonomous", "run all", "keep going", "start auto", "run autonomously"], command: "auto", acceptsArgs: true },
  { keywords: ["stop", "halt", "abort"], command: "stop" },
  { keywords: ["pause", "break", "take a break"], command: "pause" },
  { keywords: ["history", "past", "what happened", "previous"], command: "history", acceptsArgs: true },
  { keywords: ["doctor", "health", "diagnose", "check health"], command: "doctor", acceptsArgs: true },
  { keywords: ["clean up", "cleanup", "remove old", "prune", "tidy"], command: "cleanup" },
  { keywords: ["ship", "pull request", "create pr", "open pr", "merge"], command: "ship", acceptsArgs: true },
  { keywords: ["discuss", "talk about", "architecture", "design"], command: "discuss" },
  { keywords: ["undo", "revert", "rollback", "take back"], command: "undo" },
  { keywords: ["skip", "skip task", "skip this"], command: "skip", acceptsArgs: true },
  { keywords: ["visualize", "viz", "graph", "chart", "show graph"], command: "visualize" },
  { keywords: ["capture", "note", "idea", "thought", "remember"], command: "capture", acceptsArgs: true },
  { keywords: ["inspect", "database", "sqlite", "db state"], command: "inspect" },
  { keywords: ["session report", "session summary", "cost summary", "how much"], command: "session-report", acceptsArgs: true },
  { keywords: ["backlog", "parking lot", "later", "someday"], command: "backlog" },
  { keywords: ["add tests", "write tests", "generate tests", "test coverage"], command: "add-tests", acceptsArgs: true },
  { keywords: ["next", "step", "next step", "what's next"], command: "next", acceptsArgs: true },
  { keywords: ["logs", "debug logs", "log files"], command: "logs", acceptsArgs: true },
  { keywords: ["debug", "debug session", "investigate", "troubleshoot", "diagnose issue"], command: "debug", acceptsArgs: true },
];

interface MatchResult {
  command: string;
  remainingArgs: string;
  score: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPattern(keyword: string, acceptsArgs: boolean): RegExp {
  const escaped = keyword
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  return acceptsArgs
    ? new RegExp(`^${escaped}(?:\\s+(.+))?$`, "i")
    : new RegExp(`^${escaped}$`, "i");
}

function matchRoute(input: string): MatchResult | null {
  const trimmed = input.trim();
  let bestMatch: MatchResult | null = null;

  for (const route of ROUTES) {
    for (const keyword of route.keywords) {
      const match = trimmed.match(keywordPattern(keyword, route.acceptsArgs === true));
      if (match) {
        const score = keyword.length;
        if (!bestMatch || score > bestMatch.score) {
          const remaining = route.acceptsArgs === true ? (match[1] ?? "").trim() : "";
          bestMatch = { command: route.command, remainingArgs: remaining, score };
        }
      }
    }
  }

  return bestMatch;
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("/gsd do: routes exact progress intent to status", () => {
  const match = matchRoute("show me progress");
  assert.ok(match);
  assert.equal(match.command, "status");
});

test("/gsd do: routes bare auto intent to auto", () => {
  const match = matchRoute("run autonomously");
  assert.ok(match);
  assert.equal(match.command, "auto");
});

test("/gsd do: routes bare cleanup intent to cleanup", () => {
  const match = matchRoute("clean up");
  assert.ok(match);
  assert.equal(match.command, "cleanup");
  assert.equal(match.remainingArgs, "");
});

test("/gsd do: does not route no-arg cleanup when sentence has extra words", () => {
  const match = matchRoute("clean up old branches");
  assert.equal(match, null);
});

test("/gsd do: routes 'create pr for milestone' to ship", () => {
  const match = matchRoute("create pr for milestone");
  assert.ok(match);
  assert.equal(match.command, "ship");
});

test("/gsd do: routes 'add tests for S03' to add-tests", () => {
  const match = matchRoute("add tests for S03");
  assert.ok(match);
  assert.equal(match.command, "add-tests");
});

test("/gsd do: routes 'what is next' to next", () => {
  const match = matchRoute("what's next");
  assert.ok(match);
  assert.equal(match.command, "next");
});

test("/gsd do: returns null for unrecognized input", () => {
  const match = matchRoute("florbinate the gizmo");
  assert.equal(match, null);
});

test("/gsd do: prefers longer keyword match", () => {
  // "check health" (12 chars) should beat "health" (6 chars)
  const match = matchRoute("check health of the system");
  assert.ok(match);
  assert.equal(match.command, "doctor");
  assert.ok(match.score >= 12);
});

test("/gsd do: routes debug troubleshooting intent to debug", () => {
  const match = matchRoute("debug this flaky oauth callback");
  assert.ok(match);
  assert.equal(match.command, "debug");
});

test("/gsd do: keeps 'debug logs' routed to logs (longer keyword wins)", () => {
  const match = matchRoute("debug logs for today");
  assert.ok(match);
  assert.equal(match.command, "logs");
});

test("/gsd do: routes 'session report' to session-report", () => {
  const match = matchRoute("session report");
  assert.ok(match);
  assert.equal(match.command, "session-report");
});

test("/gsd do: routes 'diagnose issue' to debug (not doctor)", () => {
  // 'diagnose issue' is an explicit keyword on the debug route to distinguish
  // session-level issue diagnosis from /gsd doctor health checks.
  const match = matchRoute("diagnose issue with oauth callback");
  assert.ok(match);
  assert.equal(match.command, "debug");
});

test("/gsd do: routes 'investigate flaky test' to debug", () => {
  const match = matchRoute("investigate flaky test in CI");
  assert.ok(match);
  assert.equal(match.command, "debug");
});

test("/gsd do: 'debug logs' keyword wins over bare 'debug' (longer keyword precedence)", () => {
  // 'debug logs' (10 chars) > 'debug' (5 chars)
  const logsMatch = matchRoute("debug logs for the last run");
  assert.ok(logsMatch);
  assert.equal(logsMatch.command, "logs");
  assert.ok(logsMatch.score >= 10, `expected score >= 10, got ${logsMatch.score}`);

  // Bare 'debug' without 'logs' should still route to debug.
  const debugMatch = matchRoute("debug the payment timeout issue");
  assert.ok(debugMatch);
  assert.equal(debugMatch.command, "debug");
});

test("/gsd do: 'diagnose' alone routes to doctor (health check), not debug", () => {
  // 'diagnose' maps to the doctor route; 'diagnose issue' maps to debug.
  const match = matchRoute("diagnose my project");
  assert.ok(match);
  assert.equal(match.command, "doctor");
});

test("/gsd do: full task sentence falls back instead of token-routing to command", () => {
  const match = matchRoute("review tickets on linear and update the ticket status as you work");
  assert.equal(match, null);
});
