/**
 * Real-time tool call evidence collector for auto-mode safety harness.
 * Tracks every bash command, file write, and file edit during a unit execution.
 * Evidence is compared against LLM completion claims in evidence-cross-ref.ts.
 *
 * Evidence is persisted to .gsd/safety/evidence-<mid>-<sid>-<tid>.json so it
 * survives session restarts (pause/resume, crash recovery). On unit start,
 * call resetEvidence() then loadEvidenceFromDisk(). On every new tool call,
 * saveEvidenceToDisk() is called automatically by recordToolCall/recordToolResult.
 *
 * Follows the same module-level Map pattern as auto-tool-tracking.ts.
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BashEvidence {
  kind: "bash";
  toolCallId: string;
  command: string;
  exitCode: number;
  outputSnippet: string;
  timestamp: number;
}

export interface FileWriteEvidence {
  kind: "write";
  toolCallId: string;
  path: string;
  timestamp: number;
}

export interface FileEditEvidence {
  kind: "edit";
  toolCallId: string;
  path: string;
  timestamp: number;
}

export type EvidenceEntry = BashEvidence | FileWriteEvidence | FileEditEvidence;

// ─── Module State ───────────────────────────────────────────────────────────

let unitEvidence: EvidenceEntry[] = [];

// ─── Public API ─────────────────────────────────────────────────────────────

/** Reset all evidence for a new unit. Call at unit start. */
export function resetEvidence(): void {
  unitEvidence = [];
}

/** Get a read-only view of all evidence collected for the current unit. */
export function getEvidence(): readonly EvidenceEntry[] {
  return unitEvidence;
}

/** Get only bash evidence entries. */
export function getBashEvidence(): readonly BashEvidence[] {
  return unitEvidence.filter((e): e is BashEvidence => e.kind === "bash");
}

/** Get all file paths touched (write + edit). */
export function getFilePaths(): string[] {
  return unitEvidence
    .filter((e): e is FileWriteEvidence | FileEditEvidence => e.kind === "write" || e.kind === "edit")
    .map(e => e.path);
}

// ─── Persistence (Bug #4385 — evidence must survive session restarts) ────────

/**
 * Build the path for the evidence JSON file for a given unit.
 * Lives under .gsd/safety/ which is gitignored and session-scoped.
 */
function evidencePath(basePath: string, milestoneId: string, sliceId: string, taskId: string): string {
  return join(basePath, ".gsd", "safety", `evidence-${milestoneId}-${sliceId}-${taskId}.json`);
}

/**
 * Validate that a parsed value is an array of EvidenceEntry objects.
 * Rejects corrupt / schema-mismatch data rather than letting it poison state.
 */
function isEvidenceArray(data: unknown): data is EvidenceEntry[] {
  if (!Array.isArray(data)) return false;
  return data.every((e) => {
    if (e === null || typeof e !== "object") return false;
    const rec = e as Record<string, unknown>;
    if (typeof rec.toolCallId !== "string") return false;
    if (typeof rec.timestamp !== "number") return false;
    if (rec.kind === "bash") {
      return (
        typeof rec.command === "string" &&
        typeof rec.exitCode === "number" &&
        typeof rec.outputSnippet === "string"
      );
    }
    if (rec.kind === "write" || rec.kind === "edit") {
      return typeof rec.path === "string";
    }
    return false;
  });
}

/**
 * Persist the current in-memory evidence to disk so it survives a session
 * restart. Called from saveEvidenceToDisk after recordToolCall/recordToolResult.
 * Non-fatal — persistence failures must never break unit execution.
 */
export function saveEvidenceToDisk(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): void {
  try {
    const path = evidencePath(basePath, milestoneId, sliceId, taskId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(unitEvidence, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch {
    // Non-fatal — don't let persistence failures break unit execution
  }
}

/**
 * Load persisted evidence from disk into the in-memory array.
 * Call after resetEvidence() on session resume to restore context for a
 * partially-executed unit. If the file does not exist (fresh unit), this
 * is a no-op — getEvidence() will return [] which is correct.
 */
export function loadEvidenceFromDisk(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): void {
  try {
    const path = evidencePath(basePath, milestoneId, sliceId, taskId);
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (isEvidenceArray(parsed)) {
      unitEvidence = parsed;
    }
  } catch {
    // Non-fatal — corrupt / missing file is treated as empty evidence
  }
}

/**
 * Delete the persisted evidence file for a unit after it has been fully
 * processed. Prevents stale evidence from affecting future retries of
 * the same unit ID.
 */
export function clearEvidenceFromDisk(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
): void {
  try {
    const path = evidencePath(basePath, milestoneId, sliceId, taskId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Non-fatal
  }
}

// ─── Recording (called from register-hooks.ts) ─────────────────────────────

/**
 * Record a tool call at dispatch time (before execution).
 * Exit codes and output are filled in by recordToolResult after execution.
 */
export function recordToolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
  if (toolName === "bash" || toolName === "Bash") {
    unitEvidence.push({
      kind: "bash",
      toolCallId,
      command: String(input.command ?? ""),
      exitCode: -1,
      outputSnippet: "",
      timestamp: Date.now(),
    });
  } else if (toolName === "write" || toolName === "Write") {
    unitEvidence.push({
      kind: "write",
      toolCallId,
      path: String(input.file_path ?? input.path ?? ""),
      timestamp: Date.now(),
    });
  } else if (toolName === "edit" || toolName === "Edit") {
    unitEvidence.push({
      kind: "edit",
      toolCallId,
      path: String(input.file_path ?? input.path ?? ""),
      timestamp: Date.now(),
    });
  }
}

/**
 * Record a tool execution result. Matches the entry by toolCallId (assigned
 * at dispatch time) and fills in exit code + output. Prior versions matched
 * by `kind + empty-string` which corrupted parallel tool calls.
 */
export function recordToolResult(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const entry = unitEvidence.find(e => e.toolCallId === toolCallId);
  if (!entry) return;

  if (entry.kind === "bash") {
    const text = extractResultText(result);
    entry.outputSnippet = text.slice(0, 500);
    const exitMatch = text.match(/Command exited with code (\d+)/);
    entry.exitCode = exitMatch ? Number(exitMatch[1]) : (isError ? 1 : 0);
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const textBlock = r.content.find(
        (c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
      ) as Record<string, unknown> | undefined;
      if (textBlock && typeof textBlock.text === "string") return textBlock.text;
    }
    if (typeof r.text === "string") return r.text;
  }
  return String(result ?? "");
}
