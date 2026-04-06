/**
 * Real-time tool call evidence collector for auto-mode safety harness.
 * Tracks every bash command, file write, and file edit during a unit execution.
 * Evidence is compared against LLM completion claims in evidence-cross-ref.ts.
 *
 * Follows the same module-level Map pattern as auto-tool-tracking.ts.
 * Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>
 */

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

// ─── Recording (called from register-hooks.ts) ─────────────────────────────

/**
 * Record a tool call at dispatch time (before execution).
 * Exit codes and output are filled in by recordToolResult after execution.
 */
export function recordToolCall(toolName: string, input: Record<string, unknown>): void {
  if (toolName === "bash" || toolName === "Bash") {
    unitEvidence.push({
      kind: "bash",
      toolCallId: "",
      command: String(input.command ?? ""),
      exitCode: -1,
      outputSnippet: "",
      timestamp: Date.now(),
    });
  } else if (toolName === "write" || toolName === "Write") {
    unitEvidence.push({
      kind: "write",
      toolCallId: "",
      path: String(input.file_path ?? input.path ?? ""),
      timestamp: Date.now(),
    });
  } else if (toolName === "edit" || toolName === "Edit") {
    unitEvidence.push({
      kind: "edit",
      toolCallId: "",
      path: String(input.file_path ?? input.path ?? ""),
      timestamp: Date.now(),
    });
  }
}

/**
 * Record a tool execution result. Matches the most recent unresolved entry
 * of the same kind and fills in the toolCallId, exit code, and output.
 */
export function recordToolResult(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const normalizedName = toolName.toLowerCase();

  if (normalizedName === "bash") {
    const entry = findLastUnresolved("bash") as BashEvidence | undefined;
    if (entry) {
      entry.toolCallId = toolCallId;
      const text = extractResultText(result);
      entry.outputSnippet = text.slice(0, 500);
      const exitMatch = text.match(/Command exited with code (\d+)/);
      entry.exitCode = exitMatch ? Number(exitMatch[1]) : (isError ? 1 : 0);
    }
  } else if (normalizedName === "write" || normalizedName === "edit") {
    const entry = findLastUnresolved(normalizedName as "write" | "edit");
    if (entry) {
      entry.toolCallId = toolCallId;
    }
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

function findLastUnresolved(kind: string): EvidenceEntry | undefined {
  for (let i = unitEvidence.length - 1; i >= 0; i--) {
    if (unitEvidence[i].kind === kind && unitEvidence[i].toolCallId === "") {
      return unitEvidence[i];
    }
  }
  return undefined;
}

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
