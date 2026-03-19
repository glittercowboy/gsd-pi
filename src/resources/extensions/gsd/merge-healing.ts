/**
 * GSD Merge-Healing Pipeline — Three-tier conflict resolution.
 *
 * Tier 1: Deterministic — `.gsd/` files resolved by accepting worktree version
 * Tier 2: LLM-guided — Code conflicts resolved via callback with confidence scoring
 * Tier 3: User escalation — Low-confidence or unresolvable conflicts
 *
 * All resolutions are logged to `.gsd/MERGE-LOG.md` as an append-only audit trail.
 * This module is intentionally separate from `parallel-merge.ts` to isolate
 * the high-risk LLM code from the stable merge flow.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";

import { nativeCheckoutTheirs, nativeAddPaths } from "./native-git-bridge.js";
import { loadPrompt } from "./prompt-loader.js";
import { truncateAtSectionBoundary } from "./context-budget.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface FileResolution {
  filePath: string;
  tier: 1 | 2 | 3;
  resolution: "applied" | "escalated" | "rejected";
  content?: string;
  explanation?: string;
  confidence?: number;
}

export interface HealingAttempt {
  tier: 1 | 2 | 3;
  filesAttempted: string[];
  filesResolved: string[];
  filesEscalated: string[];
}

export interface MergeHealResult {
  resolved: boolean;
  tier: 1 | 2 | 3;
  resolutions: FileResolution[];
  confidence?: number;
  healingAttempts: HealingAttempt[];
  unresolvedFiles: string[];
  log: string;
}

export interface MergeLogEntry {
  timestamp: string;
  milestoneId: string;
  tier: 1 | 2 | 3;
  filePath: string;
  resolution: string;
  explanation: string;
  confidence?: number;
  outcome: "applied" | "escalated" | "rejected";
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

// ─── Conflict Parser ───────────────────────────────────────────────────────

/**
 * Read a file with git conflict markers and extract both sides.
 * Handles multiple conflict regions in a single file by concatenating
 * each region's content with newline separators.
 *
 * Returns null if no conflict markers are found.
 */
export function readConflictContent(
  filePath: string,
): { ours: string; theirs: string } | null {
  const raw = readFileSync(filePath, "utf-8");

  const oursChunks: string[] = [];
  const theirsChunks: string[] = [];

  let inOurs = false;
  let inTheirs = false;
  let foundConflict = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("<<<<<<<")) {
      inOurs = true;
      inTheirs = false;
      foundConflict = true;
      continue;
    }
    if (line.startsWith("=======") && inOurs) {
      inOurs = false;
      inTheirs = true;
      continue;
    }
    if (line.startsWith(">>>>>>>") && inTheirs) {
      inTheirs = false;
      continue;
    }

    if (inOurs) {
      oursChunks.push(line);
    } else if (inTheirs) {
      theirsChunks.push(line);
    }
  }

  if (!foundConflict) return null;

  return {
    ours: oursChunks.join("\n"),
    theirs: theirsChunks.join("\n"),
  };
}

// ─── MERGE-LOG.md Writer ───────────────────────────────────────────────────

const MERGE_LOG_HEADER = `# MERGE-LOG

Append-only audit log of merge conflict resolutions.
Each entry records which tier resolved a file, the resolution applied, and the outcome.

`;

/**
 * Append a structured entry to `.gsd/MERGE-LOG.md`.
 * Creates the file with a header on first write.
 */
export function appendMergeLog(basePath: string, entry: MergeLogEntry): void {
  const logPath = join(basePath, ".gsd", "MERGE-LOG.md");

  // Ensure .gsd directory exists
  const gsdDir = dirname(logPath);
  if (!existsSync(gsdDir)) {
    mkdirSync(gsdDir, { recursive: true });
  }

  // Create file with header on first write
  if (!existsSync(logPath)) {
    writeFileSync(logPath, MERGE_LOG_HEADER, "utf-8");
  }

  // Format resolution excerpt: first 5 lines
  const resolutionLines = entry.resolution.split("\n");
  const excerpt =
    resolutionLines.length > 5
      ? resolutionLines.slice(0, 5).join("\n") + "\n  ..."
      : entry.resolution;

  // Build entry
  const parts = [
    `## [${entry.timestamp}] tier-${entry.tier}: ${entry.filePath}`,
    "",
    `- **Milestone:** ${entry.milestoneId}`,
    `- **Resolution:**`,
    `  \`\`\``,
    `  ${excerpt}`,
    `  \`\`\``,
    `- **Explanation:** ${entry.explanation}`,
  ];

  if (entry.confidence !== undefined) {
    parts.push(`- **Confidence:** ${entry.confidence}`);
  }

  parts.push(`- **Outcome:** ${entry.outcome}`);
  parts.push(""); // trailing newline

  appendFileSync(logPath, parts.join("\n") + "\n", "utf-8");
}

// ─── Tier-1: Deterministic Resolver ────────────────────────────────────────

/**
 * Check if a file path is under `.gsd/`.
 * Matches paths starting with `.gsd/` or containing `/.gsd/`.
 */
function isGsdPath(filePath: string): boolean {
  return filePath.startsWith(".gsd/") || filePath.includes("/.gsd/");
}

/**
 * Tier-1 deterministic resolver: resolve `.gsd/` files by accepting
 * the worktree's ("theirs") version.
 *
 * Per D038, worktree isolation makes `.gsd/` conflicts structurally
 * unnecessary. The incoming version is always authoritative.
 */
export function resolveDeterministic(
  basePath: string,
  conflictFiles: string[],
  milestoneId: string,
): FileResolution[] {
  const gsdFiles = conflictFiles.filter(isGsdPath);
  const resolutions: FileResolution[] = [];

  for (const file of gsdFiles) {
    // Accept worktree version ("theirs" in merge context)
    nativeCheckoutTheirs(basePath, [file]);
    nativeAddPaths(basePath, [file]);

    const explanation =
      "Deterministic: accept worktree version for .gsd/ file";

    // Log the resolution
    appendMergeLog(basePath, {
      timestamp: new Date().toISOString(),
      milestoneId,
      tier: 1,
      filePath: file,
      resolution: "(worktree version accepted — content not logged for deterministic tier)",
      explanation,
      outcome: "applied",
    });

    resolutions.push({
      filePath: file,
      tier: 1,
      resolution: "applied",
      explanation,
    });
  }

  return resolutions;
}

// ─── Tier-2: LLM Merge-Heal Prompt Builder ─────────────────────────────────

/** Maximum character budget for the assembled merge-heal prompt. */
const MERGE_HEAL_PROMPT_BUDGET = 12000;

/**
 * Build an LLM prompt for resolving a merge conflict.
 *
 * Assembles the conflict diff with clear labels, file path, and optional
 * context (slice summaries, domain context). Truncates least-critical
 * sections (domain context first, then slice summaries) when the prompt
 * exceeds the character budget.
 */
export function buildMergeHealPrompt(
  conflictContent: { ours: string; theirs: string },
  filePath: string,
  sliceSummaries?: string,
  domainContext?: string,
): string {
  // Assemble a clear conflict diff with labeled sides
  const conflictDiff = [
    "### Ours (current branch):",
    "```",
    conflictContent.ours,
    "```",
    "",
    "### Theirs (incoming branch):",
    "```",
    conflictContent.theirs,
    "```",
  ].join("\n");

  // Budget-trim optional sections — domain context is least critical
  let effectiveDomainContext = domainContext ?? "(none)";
  let effectiveSliceSummaries = sliceSummaries ?? "(none)";

  // Estimate core prompt size (file path + diff + template chrome)
  const coreSize = filePath.length + conflictDiff.length + 500; // 500 for template text
  const remaining = MERGE_HEAL_PROMPT_BUDGET - coreSize;

  if (remaining < effectiveDomainContext.length + effectiveSliceSummaries.length) {
    // Truncate domain context first
    const domainBudget = Math.max(0, remaining - effectiveSliceSummaries.length);
    if (domainBudget < effectiveDomainContext.length && domainBudget > 0) {
      effectiveDomainContext = truncateAtSectionBoundary(effectiveDomainContext, domainBudget).content;
    } else if (domainBudget <= 0) {
      effectiveDomainContext = "(truncated — over budget)";
      // Truncate slice summaries with all remaining budget
      const summaryBudget = Math.max(0, remaining);
      if (summaryBudget < effectiveSliceSummaries.length && summaryBudget > 0) {
        effectiveSliceSummaries = truncateAtSectionBoundary(effectiveSliceSummaries, summaryBudget).content;
      } else if (summaryBudget <= 0) {
        effectiveSliceSummaries = "(truncated — over budget)";
      }
    }
  }

  return loadPrompt("merge-heal", {
    filePath,
    conflictDiff,
    sliceSummaries: effectiveSliceSummaries,
    domainContext: effectiveDomainContext,
  });
}

// ─── Tier-2: LLM Response Parser ──────────────────────────────────────────

/**
 * Parse an LLM response for merge conflict resolution.
 *
 * Extracts:
 *   - Resolved content between ~~~resolved / ~~~ fence markers
 *   - Confidence score from a `Confidence: X.X` line
 *   - Explanation from the remaining text
 *
 * Fault-tolerant: never throws. Returns content: null and confidence: 0.0
 * on parse failure, guaranteeing escalation to tier-3.
 */
export function parseMergeHealResponse(response: string): {
  content: string | null;
  confidence: number;
  explanation: string;
} {
  if (!response || response.trim().length === 0) {
    return { content: null, confidence: 0.0, explanation: "" };
  }

  // Extract fenced content: ~~~resolved ... ~~~
  let content: string | null = null;
  const fenceMatch = response.match(/~~~resolved\s*\n([\s\S]*?)\n~~~/)
  if (fenceMatch) {
    content = fenceMatch[1]!;
  }

  // Extract confidence from `Confidence: X.X` or `Confidence: XX%`
  let confidence = 0.0;
  const confidenceMatch = response.match(/^Confidence:\s*([\d.]+)(%?)/m);
  if (confidenceMatch) {
    const raw = parseFloat(confidenceMatch[1]!);
    if (confidenceMatch[2] === "%") {
      // Explicit percentage format — normalize to 0.0-1.0
      confidence = raw / 100;
    } else {
      confidence = raw;
    }
    // Clamp to [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));
  }

  // If content markers are missing, force confidence to 0.0
  if (content === null) {
    confidence = 0.0;
  }

  // Extract explanation: everything that isn't fenced content or confidence line
  const explanationParts: string[] = [];
  let inFence = false;
  for (const line of response.split("\n")) {
    if (line.trim().startsWith("~~~resolved")) {
      inFence = true;
      continue;
    }
    if (inFence && line.trim() === "~~~") {
      inFence = false;
      continue;
    }
    if (inFence) continue;
    if (/^Confidence:\s*[\d.]+%?/.test(line)) continue;
    explanationParts.push(line);
  }
  const explanation = explanationParts.join("\n").trim();

  return { content, confidence, explanation };
}

// ─── Three-Tier Orchestrator ───────────────────────────────────────────────

/**
 * Orchestrate three-tier merge conflict resolution.
 *
 * Tier 1: Deterministic — `.gsd/` files resolved by accepting worktree version (always runs)
 * Tier 2: LLM-guided — code conflicts resolved via resolveFn callback (only if provided)
 * Tier 3: User escalation — everything not resolved by tier-1 or tier-2
 *
 * If `resolveFn` is not provided, only tier-1 runs and all code conflicts
 * escalate to tier-3. This preserves backward compatibility for callers
 * without LLM access.
 */
export async function resolveMergeConflicts(
  basePath: string,
  milestoneId: string,
  conflictFiles: string[],
  resolveFn?: (prompt: string) => Promise<string>,
  confidenceThreshold?: number,
): Promise<MergeHealResult> {
  const gsdFiles = conflictFiles.filter(isGsdPath);
  const codeFiles = conflictFiles.filter((f) => !isGsdPath(f));

  const healingAttempts: HealingAttempt[] = [];
  const allResolutions: FileResolution[] = [];

  // ── Tier 1: deterministic .gsd/ resolution (always runs) ──
  const tier1Resolutions = resolveDeterministic(basePath, gsdFiles, milestoneId);
  allResolutions.push(...tier1Resolutions);

  if (gsdFiles.length > 0) {
    healingAttempts.push({
      tier: 1,
      filesAttempted: gsdFiles,
      filesResolved: tier1Resolutions
        .filter((r) => r.resolution === "applied")
        .map((r) => r.filePath),
      filesEscalated: tier1Resolutions
        .filter((r) => r.resolution !== "applied")
        .map((r) => r.filePath),
    });
  }

  // ── Tier 2: LLM resolution for code files (only if resolveFn provided) ──
  let tier2Resolved: FileResolution[] = [];
  let tier2Escalated: FileResolution[] = [];

  if (resolveFn && codeFiles.length > 0) {
    const llmResult = await resolveLLM(basePath, codeFiles, resolveFn, {
      milestoneId,
    }, confidenceThreshold);
    tier2Resolved = llmResult.resolved;
    tier2Escalated = llmResult.escalated;
    allResolutions.push(...tier2Resolved, ...tier2Escalated);

    healingAttempts.push({
      tier: 2,
      filesAttempted: codeFiles,
      filesResolved: tier2Resolved.map((r) => r.filePath),
      filesEscalated: tier2Escalated.map((r) => r.filePath),
    });
  } else if (codeFiles.length > 0) {
    // No resolveFn — code files escalate to tier-3 directly
    for (const file of codeFiles) {
      allResolutions.push({
        filePath: file,
        tier: 3,
        resolution: "escalated",
        explanation: "No LLM resolver provided — escalated to user",
      });
    }
  }

  // ── Collect tier-3 unresolved files ──
  const resolvedPaths = new Set(
    allResolutions
      .filter((r) => r.resolution === "applied")
      .map((r) => r.filePath),
  );
  const unresolvedFiles = conflictFiles.filter((f) => !resolvedPaths.has(f));

  return {
    resolved: unresolvedFiles.length === 0,
    tier: healingAttempts.length > 0
      ? healingAttempts[healingAttempts.length - 1]!.tier
      : 1,
    resolutions: allResolutions,
    healingAttempts,
    unresolvedFiles,
    log: "",
  };
}

// ─── Tier-2: LLM Resolver ─────────────────────────────────────────────────

/**
 * Tier-2 LLM resolver: resolve code conflicts via an external LLM callback.
 *
 * For each non-.gsd/ conflicted file:
 *   1. Read conflict markers
 *   2. Build prompt with context
 *   3. Call resolveFn callback
 *   4. Parse response for resolved content, confidence, explanation
 *   5. Apply if confidence >= threshold, escalate otherwise
 *
 * The `resolveFn` callback pattern (D060) keeps the pipeline testable
 * without a real LLM. Production wiring deferred to S05 integration.
 */
export async function resolveLLM(
  basePath: string,
  conflictFiles: string[],
  resolveFn: (prompt: string) => Promise<string>,
  context: {
    milestoneId: string;
    sliceSummaries?: string;
    domainContext?: string;
  },
  confidenceThreshold?: number,
): Promise<{ resolved: FileResolution[]; escalated: FileResolution[] }> {
  const resolved: FileResolution[] = [];
  const escalated: FileResolution[] = [];
  const threshold = confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  // Filter out .gsd/ files — they're handled by tier-1
  const codeFiles = conflictFiles.filter((f) => !isGsdPath(f));

  for (const file of codeFiles) {
    try {
      const filePath = join(basePath, file);
      const conflictContent = readConflictContent(filePath);

      // Skip files with no conflict markers (already resolved or not actually conflicted)
      if (!conflictContent) continue;

      // Build prompt with conflict diff and context
      const prompt = buildMergeHealPrompt(
        conflictContent,
        file,
        context.sliceSummaries,
        context.domainContext,
      );

      // Call LLM via callback
      const response = await resolveFn(prompt);

      // Parse the response
      const parsed = parseMergeHealResponse(response);

      if (parsed.content !== null && parsed.confidence >= threshold) {
        // High confidence — apply resolution
        writeFileSync(filePath, parsed.content, "utf-8");
        nativeAddPaths(basePath, [file]);

        appendMergeLog(basePath, {
          timestamp: new Date().toISOString(),
          milestoneId: context.milestoneId,
          tier: 2,
          filePath: file,
          resolution: parsed.content,
          explanation: parsed.explanation || "LLM resolved conflict",
          confidence: parsed.confidence,
          outcome: "applied",
        });

        resolved.push({
          filePath: file,
          tier: 2,
          resolution: "applied",
          content: parsed.content,
          explanation: parsed.explanation,
          confidence: parsed.confidence,
        });
      } else {
        // Low confidence or unparseable — escalate to tier-3
        const reason = parsed.content === null
          ? "LLM response could not be parsed (missing resolved content markers)"
          : `LLM confidence ${parsed.confidence} below threshold ${threshold}`;

        appendMergeLog(basePath, {
          timestamp: new Date().toISOString(),
          milestoneId: context.milestoneId,
          tier: 2,
          filePath: file,
          resolution: parsed.content ?? "(unparseable response)",
          explanation: `${reason}. ${parsed.explanation}`.trim(),
          confidence: parsed.confidence,
          outcome: "escalated",
        });

        escalated.push({
          filePath: file,
          tier: 2,
          resolution: "escalated",
          explanation: reason,
          confidence: parsed.confidence,
        });
      }
    } catch (err) {
      // resolveFn threw or other error — escalate with error details
      const errorMsg = err instanceof Error ? err.message : String(err);

      appendMergeLog(basePath, {
        timestamp: new Date().toISOString(),
        milestoneId: context.milestoneId,
        tier: 2,
        filePath: file,
        resolution: "(error during LLM resolution)",
        explanation: `resolveFn error: ${errorMsg}`,
        confidence: 0.0,
        outcome: "escalated",
      });

      escalated.push({
        filePath: file,
        tier: 2,
        resolution: "escalated",
        explanation: `resolveFn error: ${errorMsg}`,
        confidence: 0.0,
      });
    }
  }

  return { resolved, escalated };
}

// ─── MERGE-LOG.md Tail Reader (mtime-cached) ──────────────────────────────

export interface MergeLogSummary {
  tier: number;
  file: string;
  outcome: string;
  timestamp: string;
}

let _mergeLogLastMtime = 0;
let _mergeLogCachedEntries: MergeLogSummary[] = [];

/**
 * Read the last ~10 entries from `.gsd/MERGE-LOG.md`.
 * Uses mtime caching — only re-reads the file when it has been modified.
 * Returns empty array if file doesn't exist.
 */
export function parseMergeLogTail(basePath: string): MergeLogSummary[] {
  const logPath = join(basePath, ".gsd", "MERGE-LOG.md");

  if (!existsSync(logPath)) {
    return [];
  }

  // Check mtime — return cached if unchanged
  const mtime = statSync(logPath).mtimeMs;
  if (mtime === _mergeLogLastMtime && _mergeLogCachedEntries.length > 0) {
    return _mergeLogCachedEntries;
  }

  const content = readFileSync(logPath, "utf-8");

  // Split by ## headings (each entry starts with ## [...])
  const chunks = content.split(/^(?=## \[)/m).filter((c) => c.startsWith("## ["));
  const tail = chunks.slice(-10);

  const entries: MergeLogSummary[] = [];
  for (const chunk of tail) {
    // Extract timestamp from header: ## [2026-01-15T10:30:00Z] tier-2: path/file.ts
    const headerMatch = chunk.match(/^## \[([^\]]+)\]\s+tier-(\d+):\s+(.+)/);
    if (!headerMatch) continue;

    const timestamp = headerMatch[1]!;
    const tier = parseInt(headerMatch[2]!, 10);
    const file = headerMatch[3]!.trim();

    // Extract outcome from - **Outcome:** applied|escalated|rejected
    const outcomeMatch = chunk.match(/\*\*Outcome:\*\*\s+(\S+)/);
    const outcome = outcomeMatch ? outcomeMatch[1]! : "unknown";

    entries.push({ tier, file, outcome, timestamp });
  }

  _mergeLogLastMtime = mtime;
  _mergeLogCachedEntries = entries;
  return entries;
}

/** Reset mtime cache — used in tests. */
export function _resetMergeLogCache(): void {
  _mergeLogLastMtime = 0;
  _mergeLogCachedEntries = [];
}
