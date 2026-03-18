/**
 * GSD Session Forensics — Deep analysis of pi session JSONL files
 *
 * Pi's SessionManager persists every entry to disk via appendFileSync as it
 * happens. When a crash occurs, the session JSONL on disk contains every tool
 * call, every assistant response, and every error up to the moment of death.
 *
 * This module reads that file and reconstructs a structured execution trace
 * that tells the recovering agent exactly what happened, what changed, and
 * where to resume.
 *
 * Used by:
 * - Crash recovery (reading the surviving pi session file)
 * - Stuck-retry diagnostics (reading GSD activity log copies)
 *
 * Entry format (verified against real pi session files):
 * - Tool calls: { type: "toolCall", name: "bash", id: "toolu_...", arguments: { command: "..." } }
 * - Tool results: { role: "toolResult", toolCallId: "toolu_...", toolName: "bash", isError: bool, content: ... }
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { truncateWithEllipsis } from "../shared/format-utils.js";
import { nativeParseJsonlTail } from "./native-parser-bridge.js";
import { MAX_JSONL_BYTES, parseJSONL } from "./jsonl-utils.js";
import { nativeWorkingTreeStatus, nativeDiffStat } from "./native-git-bridge.js";
import { getAutoWorktreePath } from "./auto-worktree.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError: boolean;
}

export interface ExecutionTrace {
  /** Ordered list of tool calls with results */
  toolCalls: ToolCall[];
  /** Files written or edited (deduplicated, ordered by first occurrence) */
  filesWritten: string[];
  /** Files read (deduplicated) */
  filesRead: string[];
  /** Shell commands executed with exit status */
  commandsRun: { command: string; failed: boolean }[];
  /** Tool errors encountered */
  errors: string[];
  /** The agent's last reasoning / text output before crash */
  lastReasoning: string;
  /** Total tool calls completed (have matching results) */
  toolCallCount: number;
}

export interface RecoveryBriefing {
  /** What the agent was doing */
  unitType: string;
  unitId: string;
  /** Structured execution trace */
  trace: ExecutionTrace;
  /** Git state: files modified/added/deleted since unit started */
  gitChanges: string | null;
  /** Formatted prompt section ready for injection */
  prompt: string;
}

// ─── JSONL Parsing ────────────────────────────────────────────────────────────
// MAX_JSONL_BYTES and parseJSONL are imported from ./jsonl-utils.js

/**
 * Find the entries belonging to the last session in a JSONL file.
 * Auto-mode creates a new session per unit, so the last session header
 * marks the start of the crashed unit's entries.
 */
function extractLastSession(entries: unknown[]): unknown[] {
  let lastSessionIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown>;
    if (entry.type === "session") {
      lastSessionIdx = i;
      break;
    }
  }
  return lastSessionIdx >= 0 ? entries.slice(lastSessionIdx) : entries;
}

// ─── Trace Extraction ─────────────────────────────────────────────────────────

/**
 * Extract a structured execution trace from raw session entries.
 * Works with both pi session JSONL and GSD activity log JSONL.
 */
export function extractTrace(entries: unknown[]): ExecutionTrace {
  const toolCalls: ToolCall[] = [];
  const filesWritten: string[] = [];
  const filesRead: string[] = [];
  const commandsRun: { command: string; failed: boolean }[] = [];
  const errors: string[] = [];
  let lastReasoning = "";

  // Track pending tool calls by ID for matching with results
  const pendingTools = new Map<string, { name: string; input: Record<string, unknown> }>();

  const seenWritten = new Set<string>();
  const seenRead = new Set<string>();

  for (const raw of entries) {
    const entry = raw as Record<string, unknown>;
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message as Record<string, unknown>;

    // ── Assistant messages: tool calls + reasoning ──
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as Record<string, unknown>[]) {
        // Text reasoning
        if (part.type === "text" && part.text) {
          lastReasoning = String(part.text);
        }

        // Tool call initiation
        // Pi format: { type: "toolCall", name: "bash", id: "toolu_...", arguments: { command: "..." } }
        if (part.type === "toolCall") {
          const name = String(part.name || "unknown").toLowerCase();
          const input = (part.arguments || part.input || {}) as Record<string, unknown>;
          const id = String(part.id || "");

          if (id) {
            pendingTools.set(id, { name, input });
          }

          // Track file operations
          const path = input.path ? String(input.path) : null;
          if (path) {
            if (name === "write" || name === "edit") {
              if (!seenWritten.has(path)) { seenWritten.add(path); filesWritten.push(path); }
            } else if (name === "read") {
              if (!seenRead.has(path)) { seenRead.add(path); filesRead.push(path); }
            }
          }

          // Track shell commands
          if ((name === "bash" || name === "bg_shell") && input.command) {
            commandsRun.push({ command: String(input.command), failed: false });
          }
        }
      }
    }

    // ── Tool results: match with pending calls ──
    // Pi format: { role: "toolResult", toolCallId: "toolu_...", toolName: "bash", isError: bool, content: ... }
    if (msg.role === "toolResult") {
      const id = String(msg.toolCallId || "");
      const isError = !!msg.isError;
      const resultText = extractResultText(msg);

      const pending = pendingTools.get(id);
      if (pending) {
        toolCalls.push({
          name: pending.name,
          input: redactInput(pending.name, pending.input),
          result: resultText.slice(0, 500),
          isError,
        });
        pendingTools.delete(id);

        // Mark failed commands
        if (isError && (pending.name === "bash" || pending.name === "bg_shell")) {
          const lastCmd = findLast(commandsRun, c => c.command === String(pending.input.command));
          if (lastCmd) lastCmd.failed = true;
        }
      }

      if (isError && resultText) {
        errors.push(resultText.slice(0, 300));
      }
    }
  }

  // Flush any pending tool calls that never got results (crash mid-tool)
  for (const [, pending] of pendingTools) {
    toolCalls.push({
      name: pending.name,
      input: redactInput(pending.name, pending.input),
      isError: false,
    });
  }

  return {
    toolCalls,
    filesWritten,
    filesRead,
    commandsRun,
    errors,
    lastReasoning: lastReasoning.slice(-600).trim(),
    toolCallCount: toolCalls.length,
  };
}

// ─── Git State ────────────────────────────────────────────────────────────────

function getGitChanges(basePath: string): string | null {
  try {
    const status = nativeWorkingTreeStatus(basePath);
    if (!status) return null;

    const diffStat = nativeDiffStat(basePath, "HEAD", "WORKDIR").summary;
    const stagedStat = nativeDiffStat(basePath, "HEAD", "INDEX").summary;

    const parts: string[] = [];
    if (status) parts.push(`Status:\n${status}`);
    if (stagedStat) parts.push(`Staged:\n${stagedStat}`);
    if (diffStat) parts.push(`Unstaged:\n${diffStat}`);
    return parts.join("\n\n");
  } catch {
    return null;
  }
}

// ─── Recovery Briefing ────────────────────────────────────────────────────────

/**
 * Synthesize a full crash recovery briefing.
 *
 * Reads the surviving pi session file (or falls back to the last GSD activity
 * log), deep-parses it into an execution trace, combines with git state, and
 * formats a structured prompt section ready for injection.
 */
export function synthesizeCrashRecovery(
  basePath: string,
  unitType: string,
  unitId: string,
  sessionFile?: string,
  activityDir?: string,
): RecoveryBriefing | null {
  try {
    let trace: ExecutionTrace | null = null;

    // Primary source: surviving pi session file
    if (sessionFile && existsSync(sessionFile)) {
      // Try native JSONL parser first (handles arbitrary file sizes with constant memory)
      const nativeResult = nativeParseJsonlTail(sessionFile, MAX_JSONL_BYTES);
      if (nativeResult) {
        const sessionEntries = extractLastSession(nativeResult.entries);
        trace = extractTrace(sessionEntries);
      } else {
        const stat = statSync(sessionFile, { throwIfNoEntry: false });
        const fileSize = stat?.size ?? 0;
        // Skip files that would blow up memory; fall back to activity log
        if (fileSize <= MAX_JSONL_BYTES * 2) {
          const raw = readFileSync(sessionFile, "utf-8");
          const allEntries = parseJSONL(raw);
          const sessionEntries = extractLastSession(allEntries);
          trace = extractTrace(sessionEntries);
        }
      }
    }

    // Fallback: last GSD activity log
    if (!trace || trace.toolCallCount === 0) {
      const fallbackTrace = readLastActivityLog(activityDir);
      if (fallbackTrace && fallbackTrace.toolCallCount > 0) {
        trace = fallbackTrace;
      }
    }

    // If no trace from either source, still provide git state
    if (!trace) {
      trace = {
        toolCalls: [], filesWritten: [], filesRead: [],
        commandsRun: [], errors: [], lastReasoning: "", toolCallCount: 0,
      };
    }

    const gitChanges = getGitChanges(basePath);
    const prompt = formatRecoveryPrompt(unitType, unitId, trace, gitChanges);

    return { unitType, unitId, trace, gitChanges, prompt };
  } catch {
    return null;
  }
}

/**
 * Deep diagnostic from any JSONL source (activity log or session file).
 * Replaces the old shallow getLastActivityDiagnostic().
 */
export function getDeepDiagnostic(basePath: string): string | null {
  // Try worktree activity logs first if an auto-worktree is active
  let trace: ExecutionTrace | null = null;
  try {
    const mid = readActiveMilestoneId(basePath);
    if (mid) {
      const wtPath = getAutoWorktreePath(basePath, mid);
      if (wtPath) {
        const wtActivityDir = join(wtPath, ".gsd", "activity");
        trace = readLastActivityLog(wtActivityDir);
      }
    }
  } catch { /* non-fatal — fall through to root */ }

  // Fall back to root activity logs
  if (!trace || trace.toolCallCount === 0) {
    const activityDir = join(basePath, ".gsd", "activity");
    trace = readLastActivityLog(activityDir);
  }

  if (!trace || trace.toolCallCount === 0) return null;
  return formatTraceSummary(trace);
}

/**
 * Read the active milestone ID directly from STATE.md without async deriveState().
 * Looks for `**Active Milestone:** M001` pattern.
 */
function readActiveMilestoneId(basePath: string): string | null {
  try {
    const statePath = join(basePath, ".gsd", "STATE.md");
    if (!existsSync(statePath)) return null;
    const content = readFileSync(statePath, "utf-8");
    const match = /\*\*Active Milestone:\*\*\s*(\S+)/i.exec(content);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatRecoveryPrompt(
  unitType: string,
  unitId: string,
  trace: ExecutionTrace,
  gitChanges: string | null,
): string {
  const sections: string[] = [];

  sections.push(
    "## Recovery Briefing",
    "",
    `You are resuming \`${unitType}\` for \`${unitId}\` after an interruption.`,
    `The previous session completed **${trace.toolCallCount} tool calls** before stopping.`,
    "Use this briefing to pick up exactly where it left off. Do NOT redo completed work.",
  );

  // Tool call trace — compact summary
  if (trace.toolCalls.length > 0) {
    sections.push("", "### Completed Tool Calls");
    const summary = compressToolCallTrace(trace.toolCalls);
    sections.push(summary);
  }

  // Files written
  if (trace.filesWritten.length > 0) {
    sections.push(
      "", "### Files Already Written/Edited",
      ...trace.filesWritten.map(f => `- \`${f}\``),
      "",
      "These files exist on disk from the previous run. Verify they look correct before continuing.",
    );
  }

  // Commands run
  const significantCommands = trace.commandsRun.filter(c =>
    !c.command.startsWith("git ") || c.failed,
  );
  if (significantCommands.length > 0) {
    sections.push("", "### Commands Already Run");
    for (const c of significantCommands.slice(-10)) {
      const status = c.failed ? " ❌" : " ✓";
      sections.push(`- \`${truncateWithEllipsis(c.command, 121)}\`${status}`);
    }
  }

  // Errors
  if (trace.errors.length > 0) {
    sections.push(
      "", "### Errors Before Interruption",
      ...trace.errors.slice(-3).map(e => `- ${truncateWithEllipsis(e, 201)}`),
    );
  }

  // Git state
  if (gitChanges) {
    sections.push(
      "", "### Current Git State (filesystem truth)",
      "```", gitChanges, "```",
    );
  }

  // Last reasoning
  if (trace.lastReasoning) {
    sections.push(
      "", "### Last Agent Reasoning Before Interruption",
      `> ${trace.lastReasoning.replace(/\n/g, "\n> ")}`,
    );
  }

  sections.push(
    "",
    "### Resume Instructions",
    "1. Check the task plan for remaining work",
    "2. Verify files listed above exist and look correct on disk",
    "3. Continue from where the previous session left off",
    "4. Do NOT re-read files or re-run commands that already succeeded above",
  );

  return sections.join("\n");
}

/**
 * Compress a tool call trace into a readable summary.
 * Groups consecutive reads, shows write/edit/bash individually.
 */
function compressToolCallTrace(calls: ToolCall[]): string {
  const lines: string[] = [];
  let readBatch: string[] = [];

  function flushReads() {
    if (readBatch.length === 0) return;
    if (readBatch.length <= 2) {
      for (const path of readBatch) lines.push(`  read \`${path}\``);
    } else {
      lines.push(`  read ${readBatch.length} files: ${readBatch.map(p => `\`${basename(p)}\``).join(", ")}`);
    }
    readBatch = [];
  }

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const num = i + 1;

    if (call.name === "read" && call.input.path) {
      readBatch.push(String(call.input.path));
      continue;
    }

    flushReads();

    const err = call.isError ? " ❌" : "";

    if (call.name === "write" || call.name === "edit") {
      lines.push(`${num}. ${call.name} \`${call.input.path || "?"}\`${err}`);
    } else if (call.name === "bash" || call.name === "bg_shell") {
      const cmd = truncateWithEllipsis(String(call.input.command || ""), 81);
      lines.push(`${num}. ${call.name}: \`${cmd}\`${err}`);
    } else {
      lines.push(`${num}. ${call.name}${err}`);
    }
  }

  flushReads();
  return lines.join("\n");
}

function formatTraceSummary(trace: ExecutionTrace): string {
  const parts: string[] = [];
  parts.push(`Tool calls completed: ${trace.toolCallCount}`);

  if (trace.filesWritten.length > 0) {
    parts.push(`Files written: ${trace.filesWritten.map(f => `\`${f}\``).join(", ")}`);
  }
  if (trace.commandsRun.length > 0) {
    const cmds = trace.commandsRun.slice(-5).map(c => `\`${truncateWithEllipsis(c.command, 81)}\`${c.failed ? " ❌" : ""}`);
    parts.push(`Commands run: ${cmds.join(", ")}`);
  }
  if (trace.errors.length > 0) {
    parts.push(`Errors: ${trace.errors.slice(-3).join("; ")}`);
  }
  if (trace.lastReasoning) {
    parts.push(`Last reasoning: "${trace.lastReasoning}"`);
  }
  return parts.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readLastActivityLog(activityDir?: string): ExecutionTrace | null {
  if (!activityDir) return null;
  try {
    if (!existsSync(activityDir)) return null;
    const files = readdirSync(activityDir).filter(f => f.endsWith(".jsonl")).sort();
    if (files.length === 0) return null;

    const lastFile = files[files.length - 1]!;
    const filePath = join(activityDir, lastFile);

    // Try native JSONL parser first
    const nativeResult = nativeParseJsonlTail(filePath, MAX_JSONL_BYTES);
    if (nativeResult) {
      return extractTrace(nativeResult.entries);
    }

    // Fall back to JS parsing
    const raw = readFileSync(filePath, "utf-8");
    return extractTrace(parseJSONL(raw));
  } catch {
    return null;
  }
}

function extractResultText(msg: Record<string, unknown>): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: Record<string, unknown>) => p.type === "text")
      .map((p: Record<string, unknown>) => String(p.text || ""))
      .join(" ");
  }
  return "";
}

/**
 * Redact sensitive fields from tool inputs.
 * Keep paths and commands, drop large content bodies.
 */
function redactInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "content" || key === "oldText" || key === "newText") {
      safe[key] = typeof value === "string" ? truncateWithEllipsis(value, 101) : "[redacted]";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

/** Array.findLast polyfill for older Node versions */
function findLast<T>(arr: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return arr[i];
  }
  return undefined;
}

