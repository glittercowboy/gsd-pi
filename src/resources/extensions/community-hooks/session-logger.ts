// GSD Community Hooks — Session Logger
//
// Persists a structured log of each session for team visibility. Records what
// files were changed, what tools were used, and key decisions made during the
// session. Logs are stored in .gsd/session-logs/.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

interface ToolUsage {
  name: string;
  count: number;
}

interface SessionLog {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  model: string;
  turns: number;
  toolUsage: ToolUsage[];
  filesModified: string[];
  filesCreated: string[];
  summary: string;
}

function gitDiffFiles(cwd: string): Promise<{ modified: string[]; created: string[] }> {
  return new Promise((resolve) => {
    const modified: string[] = [];
    const created: string[] = [];

    // Get modified files
    execFile("git", ["diff", "--name-only", "HEAD"], { cwd, timeout: 5_000 }, (err, stdout) => {
      if (!err && stdout) {
        modified.push(...stdout.trim().split("\n").filter(Boolean));
      }

      // Get untracked files
      execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd, timeout: 5_000 }, (err2, stdout2) => {
        if (!err2 && stdout2) {
          created.push(...stdout2.trim().split("\n").filter(Boolean));
        }
        resolve({ modified, created });
      });
    });
  });
}

export function registerSessionLogger(pi: ExtensionAPI): void {
  let startTime: number = 0;
  let model = "unknown";
  const toolCounts = new Map<string, number>();
  let turnCount = 0;

  pi.on("session_start", async () => {
    startTime = Date.now();
    toolCounts.clear();
    turnCount = 0;
  });

  pi.on("model_select", async (event) => {
    model = event.model?.id ?? "unknown";
  });

  pi.on("turn_end", async () => {
    turnCount++;
  });

  pi.on("tool_execution_end", async (event) => {
    const current = toolCounts.get(event.toolName) ?? 0;
    toolCounts.set(event.toolName, current + 1);
  });

  pi.on("session_shutdown", async () => {
    if (turnCount === 0) return;

    const endTime = Date.now();
    const cwd = process.cwd();
    const logDir = join(cwd, ".gsd", "session-logs");

    mkdirSync(logDir, { recursive: true });

    const { modified, created } = await gitDiffFiles(cwd);

    const toolUsage: ToolUsage[] = [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const sessionId = new Date(startTime).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const durationMs = endTime - startTime;

    const log: SessionLog = {
      sessionId,
      startedAt: new Date(startTime).toISOString(),
      endedAt: new Date(endTime).toISOString(),
      durationMinutes: Math.round(durationMs / 60_000),
      model,
      turns: turnCount,
      toolUsage,
      filesModified: modified,
      filesCreated: created,
      summary: buildSummary(turnCount, toolUsage, modified, created, durationMs),
    };

    recordFire("sessionLogger");
    recordAction("sessionLogger", `Logged ${turnCount} turns, ${modified.length + created.length} files`);
    const logPath = join(logDir, `${sessionId}.json`);
    writeFileSync(logPath, JSON.stringify(log, null, 2));

    // Also write a human-readable markdown version
    const mdPath = join(logDir, `${sessionId}.md`);
    writeFileSync(mdPath, buildMarkdown(log));
  });
}

function buildSummary(
  turns: number,
  tools: ToolUsage[],
  modified: string[],
  created: string[],
  durationMs: number,
): string {
  const mins = Math.round(durationMs / 60_000);
  const parts = [`${turns} turns over ${mins} min`];

  const writes = (tools.find((t) => t.name === "write")?.count ?? 0)
    + (tools.find((t) => t.name === "edit")?.count ?? 0);
  if (writes > 0) parts.push(`${writes} file writes`);

  const reads = tools.find((t) => t.name === "read")?.count ?? 0;
  if (reads > 0) parts.push(`${reads} file reads`);

  const bashCount = tools.find((t) => t.name === "bash")?.count ?? 0;
  if (bashCount > 0) parts.push(`${bashCount} shell commands`);

  if (modified.length > 0) parts.push(`${modified.length} files modified`);
  if (created.length > 0) parts.push(`${created.length} files created`);

  return parts.join(", ");
}

function buildMarkdown(log: SessionLog): string {
  const lines = [
    `# Session Log: ${log.sessionId}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Started | ${log.startedAt} |`,
    `| Ended | ${log.endedAt} |`,
    `| Duration | ${log.durationMinutes} min |`,
    `| Model | ${log.model} |`,
    `| Turns | ${log.turns} |`,
    "",
    `## Summary`,
    "",
    log.summary,
    "",
  ];

  if (log.toolUsage.length > 0) {
    lines.push("## Tool Usage", "");
    lines.push("| Tool | Count |", "|------|-------|");
    for (const t of log.toolUsage) {
      lines.push(`| ${t.name} | ${t.count} |`);
    }
    lines.push("");
  }

  if (log.filesModified.length > 0) {
    lines.push("## Modified Files", "");
    for (const f of log.filesModified) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  if (log.filesCreated.length > 0) {
    lines.push("## New Files", "");
    for (const f of log.filesCreated) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
