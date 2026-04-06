/**
 * GSD Captures — Fire-and-forget thought capture with triage classification
 *
 * Append-only capture file at `.gsd/CAPTURES.md`. Each capture is an H3 section
 * with bold metadata fields, parseable by the same patterns used in files.ts.
 *
 * Worktree-aware: captures always resolve to the original project root's
 * `.gsd/CAPTURES.md`, not the worktree's local `.gsd/`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { gsdRoot } from "./paths.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Classification = "quick-task" | "inject" | "defer" | "replan" | "note" | "stop" | "backtrack";

export interface CaptureEntry {
  id: string;
  text: string;
  timestamp: string;
  status: "pending" | "triaged" | "resolved";
  classification?: Classification;
  resolution?: string;
  rationale?: string;
  resolvedAt?: string;
  resolvedInMilestone?: string;
  executed?: boolean;
}

export interface TriageResult {
  captureId: string;
  classification: Classification;
  rationale: string;
  affectedFiles?: string[];
  targetSlice?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CAPTURES_FILENAME = "CAPTURES.md";
const VALID_CLASSIFICATIONS: readonly string[] = [
  "quick-task", "inject", "defer", "replan", "note", "stop", "backtrack",
];

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the path to CAPTURES.md, aware of worktree context.
 *
 * In worktree-isolated mode, basePath is `.gsd/worktrees/<MID>/`.
 * Captures must resolve to the *original* project root's `.gsd/CAPTURES.md`,
 * not the worktree-local `.gsd/`. This ensures all captures go to one file
 * regardless of which worktree the agent is running in.
 *
 * Detection: if basePath contains `/.gsd/worktrees/`, walk up to the
 * directory that contains `.gsd/worktrees/` — that's the project root.
 */
export function resolveCapturesPath(basePath: string): string {
  const resolved = resolve(basePath);
  // Direct layout: /.gsd/worktrees/
  const worktreeMarker = `${sep}.gsd${sep}worktrees${sep}`;
  let idx = resolved.indexOf(worktreeMarker);
  if (idx === -1) {
    // Symlink-resolved layout: /.gsd/projects/<hash>/worktrees/
    const symlinkRe = new RegExp(
      `\\${sep}\\.gsd\\${sep}projects\\${sep}[a-f0-9]+\\${sep}worktrees\\${sep}`,
    );
    const match = resolved.match(symlinkRe);
    if (match && match.index !== undefined) idx = match.index;
  }
  if (idx !== -1) {
    // basePath is inside a worktree — resolve to project root
    const projectRoot = resolved.slice(0, idx);
    return join(projectRoot, ".gsd", CAPTURES_FILENAME);
  }
  return join(gsdRoot(basePath), CAPTURES_FILENAME);
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

/**
 * Append a new capture entry to CAPTURES.md.
 * Creates `.gsd/` and the file if they don't exist.
 * Returns the generated capture ID.
 */
export function appendCapture(basePath: string, text: string): string {
  const filePath = resolveCapturesPath(basePath);
  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const id = `CAP-${randomUUID().slice(0, 8)}`;
  const timestamp = new Date().toISOString();

  const entry = [
    `### ${id}`,
    `**Text:** ${text}`,
    `**Captured:** ${timestamp}`,
    `**Status:** pending`,
    "",
  ].join("\n");

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, existing.trimEnd() + "\n\n" + entry, "utf-8");
  } else {
    const header = `# Captures\n\n`;
    writeFileSync(filePath, header + entry, "utf-8");
  }

  return id;
}

/**
 * Parse all capture entries from CAPTURES.md.
 * Returns entries in file order (oldest first).
 */
export function loadAllCaptures(basePath: string): CaptureEntry[] {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  return parseCapturesContent(content);
}

/**
 * Load only pending (unresolved) captures.
 */
export function loadPendingCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(c => c.status === "pending");
}

/**
 * Fast check for pending captures without full parse.
 * Reads the file and scans for `**Status:** pending` via regex.
 * Returns false if the file doesn't exist.
 */
export function hasPendingCaptures(basePath: string): boolean {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, "utf-8");
    return /\*\*Status:\*\*\s*pending/i.test(content);
  } catch {
    return false;
  }
}

/**
 * Count pending captures without full parse — single file read.
 * Uses regex to count `**Status:** pending` occurrences.
 * Returns 0 if file doesn't exist or on error.
 */
export function countPendingCaptures(basePath: string): number {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return 0;
  try {
    const content = readFileSync(filePath, "utf-8");
    const matches = content.match(/\*\*Status:\*\*\s*pending/gi);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Mark a capture as resolved with classification and rationale.
 * Rewrites the entry in place, preserving other entries.
 */
export function markCaptureResolved(
  basePath: string,
  captureId: string,
  classification: Classification,
  resolution: string,
  rationale: string,
  milestoneId?: string,
): void {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf-8");
  const resolvedAt = new Date().toISOString();

  // Find the section for this capture ID and rewrite its fields
  const sectionRegex = new RegExp(
    `(### ${escapeRegex(captureId)}\\n(?:(?!### ).)*?)(?=### |$)`,
    "s",
  );
  const match = sectionRegex.exec(content);
  if (!match) return;

  let section = match[1];

  // Update Status field
  section = section.replace(
    /\*\*Status:\*\*\s*.+/,
    `**Status:** resolved`,
  );

  // Append classification, resolution, rationale, and timestamp if not present
  const newFields = [
    `**Classification:** ${classification}`,
    `**Resolution:** ${resolution}`,
    `**Rationale:** ${rationale}`,
    `**Resolved:** ${resolvedAt}`,
  ];
  if (milestoneId) {
    newFields.push(`**Milestone:** ${milestoneId}`);
  }

  // Remove any existing classification/resolution/rationale/resolved/milestone fields
  // (in case of re-triage)
  section = section.replace(/\*\*Classification:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Resolution:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Rationale:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Resolved:\*\*\s*.+\n?/g, "");
  section = section.replace(/\*\*Milestone:\*\*\s*.+\n?/g, "");

  // Add new fields after Status line
  section = section.trimEnd() + "\n" + newFields.join("\n") + "\n";

  const updated = content.replace(sectionRegex, section);
  writeFileSync(filePath, updated, "utf-8");
}

/**
 * Mark a resolved capture as executed — its resolution action was carried out.
 * Appends `**Executed:** <timestamp>` to the capture's section in CAPTURES.md.
 */
export function markCaptureExecuted(basePath: string, captureId: string): void {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf-8");
  const executedAt = new Date().toISOString();

  const sectionRegex = new RegExp(
    `(### ${escapeRegex(captureId)}\\n(?:(?!### ).)*?)(?=### |$)`,
    "s",
  );
  const match = sectionRegex.exec(content);
  if (!match) return;

  let section = match[1];

  // Remove any existing Executed field (in case of re-execution)
  section = section.replace(/\*\*Executed:\*\*\s*.+\n?/g, "");

  // Append Executed timestamp
  section = section.trimEnd() + "\n" + `**Executed:** ${executedAt}` + "\n";

  const updated = content.replace(sectionRegex, section);
  writeFileSync(filePath, updated, "utf-8");
}

/**
 * Load resolved captures that have actionable classifications (inject, replan,
 * quick-task) but have NOT yet been executed.
 * These are captures whose resolutions need to be carried out.
 *
 * When `currentMilestoneId` is provided, captures resolved in a *different*
 * milestone are treated as stale and excluded.  This prevents quick-task
 * captures from a prior milestone re-executing after the underlying issues
 * were already fixed by planned milestone work (#2872).
 *
 * Captures that have no `resolvedInMilestone` (legacy captures resolved before
 * this field was introduced) are always included for backward compatibility.
 */
export function loadActionableCaptures(basePath: string, currentMilestoneId?: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(
    c =>
      c.status === "resolved" &&
      !c.executed &&
      (c.classification === "inject" ||
        c.classification === "replan" ||
        c.classification === "quick-task") &&
      // Staleness gate: exclude captures resolved in a different milestone (#2872)
      (!currentMilestoneId ||
        !c.resolvedInMilestone ||
        c.resolvedInMilestone === currentMilestoneId),
  );
}

/**
 * Load unexecuted stop captures — user directives to halt auto-mode.
 * These are checked in the pre-dispatch guard pipeline (runGuards) to
 * pause auto-mode before the next unit is dispatched.
 */
export function loadStopCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(
    c => c.status === "resolved" && !c.executed &&
      (c.classification === "stop" || c.classification === "backtrack"),
  );
}

/**
 * Load unexecuted backtrack captures specifically — captures directing
 * auto-mode to abandon current milestone and return to a previous one.
 */
export function loadBacktrackCaptures(basePath: string): CaptureEntry[] {
  return loadAllCaptures(basePath).filter(
    c => c.status === "resolved" && !c.executed && c.classification === "backtrack",
  );
}

/**
 * Revert captures that were silenced by non-triage agents.
 *
 * When an execute-task or other non-triage agent writes `**Status:** resolved`
 * to CAPTURES.md, it bypasses the triage pipeline entirely. This function
 * detects such captures (resolved but missing the Classification field that
 * triage always writes) and reverts them to pending so the triage sidecar
 * picks them up properly.
 *
 * Returns the number of captures reverted.
 */
export function revertExecutorResolvedCaptures(basePath: string): number {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return 0;

  let content = readFileSync(filePath, "utf-8");
  let reverted = 0;

  const all = loadAllCaptures(basePath);
  for (const capture of all) {
    // A properly triaged capture has both resolved status AND a classification.
    // An executor-silenced capture has resolved status but NO classification.
    if (capture.status === "resolved" && !capture.classification) {
      const sectionRegex = new RegExp(
        `(### ${escapeRegex(capture.id)}\\n(?:(?!### ).)*?)(?=### |$)`,
        "s",
      );
      const match = sectionRegex.exec(content);
      if (match) {
        let section = match[1];
        section = section.replace(
          /\*\*Status:\*\*\s*resolved/i,
          "**Status:** pending",
        );
        content = content.replace(sectionRegex, section);
        reverted++;
      }
    }
  }

  if (reverted > 0) {
    writeFileSync(filePath, content, "utf-8");
  }

  return reverted;
}

/**
 * Retroactively stamp a capture with a milestone ID.
 *
 * Used by executeTriageResolutions() as a safety net when the triage LLM
 * resolves a capture without writing the **Milestone:** field.  This ensures
 * the staleness gate in loadActionableCaptures() works correctly even for
 * captures resolved before the prompt was updated (#2872).
 */
export function stampCaptureMilestone(basePath: string, captureId: string, milestoneId: string): void {
  const filePath = resolveCapturesPath(basePath);
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf-8");

  const sectionRegex = new RegExp(
    `(### ${escapeRegex(captureId)}\\n(?:(?!### ).)*?)(?=### |$)`,
    "s",
  );
  const match = sectionRegex.exec(content);
  if (!match) return;

  let section = match[1];

  // Only stamp if not already present
  if (/\*\*Milestone:\*\*/.test(section)) return;

  // Insert after the Resolved field (or at end of section)
  const resolvedFieldEnd = section.search(/\*\*Resolved:\*\*\s*.+\n?/);
  if (resolvedFieldEnd !== -1) {
    const resolvedMatch = section.match(/\*\*Resolved:\*\*\s*.+\n?/);
    const insertPos = resolvedFieldEnd + (resolvedMatch?.[0]?.length ?? 0);
    section = section.slice(0, insertPos) + `**Milestone:** ${milestoneId}\n` + section.slice(insertPos);
  } else {
    section = section.trimEnd() + "\n" + `**Milestone:** ${milestoneId}` + "\n";
  }

  const updated = content.replace(sectionRegex, section);
  writeFileSync(filePath, updated, "utf-8");
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse CAPTURES.md content into CaptureEntry array.
 */
function parseCapturesContent(content: string): CaptureEntry[] {
  const entries: CaptureEntry[] = [];

  // Split on H3 headings
  const sections = content.split(/^### /m).slice(1); // skip content before first H3

  for (const section of sections) {
    const lines = section.split("\n");
    const id = lines[0]?.trim();
    if (!id) continue;

    const body = lines.slice(1).join("\n");
    const text = extractBoldField(body, "Text");
    const timestamp = extractBoldField(body, "Captured");
    const statusRaw = extractBoldField(body, "Status");
    const classification = extractBoldField(body, "Classification") as Classification | null;
    const resolution = extractBoldField(body, "Resolution");
    const rationale = extractBoldField(body, "Rationale");
    const resolvedAt = extractBoldField(body, "Resolved");
    const milestoneId = extractBoldField(body, "Milestone");
    const executedAt = extractBoldField(body, "Executed");

    if (!text || !timestamp) continue;

    const status = (statusRaw === "resolved" || statusRaw === "triaged")
      ? statusRaw
      : "pending";

    entries.push({
      id,
      text,
      timestamp,
      status,
      ...(classification && VALID_CLASSIFICATIONS.includes(classification) ? { classification } : {}),
      ...(resolution ? { resolution } : {}),
      ...(rationale ? { rationale } : {}),
      ...(resolvedAt ? { resolvedAt } : {}),
      ...(milestoneId ? { resolvedInMilestone: milestoneId } : {}),
      ...(executedAt ? { executed: true } : {}),
    });
  }

  return entries;
}

/**
 * Extract value from a bold-prefixed line like "**Key:** Value".
 * Local copy of the pattern from files.ts to keep this module self-contained.
 */
function extractBoldField(text: string, key: string): string | null {
  const regex = new RegExp(`^\\*\\*${escapeRegex(key)}:\\*\\*\\s*(.+)$`, "m");
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Triage Output Parser ─────────────────────────────────────────────────────

/**
 * Parse LLM triage output into TriageResult array.
 *
 * Handles:
 * - Clean JSON array
 * - JSON wrapped in fenced code block (```json ... ```)
 * - JSON with leading/trailing prose
 * - Single object (not array) — wraps in array
 * - Malformed JSON — returns empty array (caller should fall back to note)
 * - Partial results — valid entries are kept, invalid skipped
 */
export function parseTriageOutput(llmResponse: string): TriageResult[] {
  if (!llmResponse || !llmResponse.trim()) return [];

  // Try to extract JSON from fenced code blocks first
  const fenced = llmResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const jsonStr = fenced ? fenced[1] : extractJsonSubstring(llmResponse);

  if (!jsonStr) return [];

  try {
    const parsed = JSON.parse(jsonStr);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter(isValidTriageResult)
      .map(normalizeTriageResult);
  } catch {
    return [];
  }
}

/**
 * Try to find a JSON array or object substring in prose text.
 * Looks for the first [ or { and finds its matching bracket.
 */
function extractJsonSubstring(text: string): string | null {
  // Find first [ or {
  const arrStart = text.indexOf("[");
  const objStart = text.indexOf("{");

  let start: number;
  let openChar: string;
  let closeChar: string;

  if (arrStart === -1 && objStart === -1) return null;
  if (arrStart === -1) {
    start = objStart;
    openChar = "{";
    closeChar = "}";
  } else if (objStart === -1) {
    start = arrStart;
    openChar = "[";
    closeChar = "]";
  } else {
    start = Math.min(arrStart, objStart);
    openChar = start === arrStart ? "[" : "{";
    closeChar = start === arrStart ? "]" : "}";
  }

  // Find matching bracket
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

function isValidTriageResult(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.captureId === "string" &&
    typeof o.classification === "string" &&
    VALID_CLASSIFICATIONS.includes(o.classification) &&
    typeof o.rationale === "string"
  );
}

function normalizeTriageResult(obj: Record<string, unknown>): TriageResult {
  return {
    captureId: obj.captureId as string,
    classification: obj.classification as Classification,
    rationale: obj.rationale as string,
    ...(Array.isArray(obj.affectedFiles) ? { affectedFiles: obj.affectedFiles as string[] } : {}),
    ...(typeof obj.targetSlice === "string" ? { targetSlice: obj.targetSlice } : {}),
  };
}
