/**
 * Context budget engine — proportional allocation, section-boundary truncation,
 * and executor context window resolution.
 *
 * All functions are pure or near-pure (dependency-injected). No global state, no I/O.
 * Budget ratios are module-level constants for easy tuning.
 *
 * @see D001 (module location), D002 (200K fallback), D003 (section-boundary truncation)
 */

import { type TokenProvider, getCharsPerToken } from "./token-counter.js";
import { compressToTarget } from "./prompt-compressor.js";

// ─── Budget ratio constants ──────────────────────────────────────────────────
// Percentages of total context window allocated to each budget category.
// These are applied after tokens→chars conversion.

/** Proportion of context window for dependency/prior-task summaries */
const SUMMARY_RATIO = 0.15;

/** Proportion of context window for inline context (plans, decisions, code) */
const INLINE_CONTEXT_RATIO = 0.40;

/** Proportion of context window for verification sections in prompts */
const VERIFICATION_RATIO = 0.10;

/** Approximate chars-per-token conversion factor */
const CHARS_PER_TOKEN = 4;

/** Default context window when none can be resolved (D002) */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Percentage of context consumed before suggesting a continue-here checkpoint */
const CONTINUE_THRESHOLD_PERCENT = 70;

// ─── Task count bounds ───────────────────────────────────────────────────────
// Task count range scales with context window. Smaller windows get fewer tasks
// to avoid overloading the executor.

const TASK_COUNT_MIN = 2;

/** Task count ceiling tiers: [contextWindowThreshold, maxTasks] */
const TASK_COUNT_TIERS: [number, number][] = [
  [500_000, 8],   // 500K+ tokens → up to 8 tasks
  [200_000, 6],   // 200K+ tokens → up to 6 tasks
  [128_000, 5],   // 128K+ tokens → up to 5 tasks
  [0, 3],         // anything smaller → up to 3 tasks
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TruncationResult {
  /** The (possibly truncated) content string */
  content: string;
  /** Number of sections dropped during truncation; 0 when content fits */
  droppedSections: number;
}

export interface BudgetAllocation {
  /** Character budget for dependency/prior-task summaries */
  summaryBudgetChars: number;
  /** Character budget for inline context (plans, decisions, code snippets) */
  inlineContextBudgetChars: number;
  /** Recommended task count range for the executor at this context window */
  taskCountRange: { min: number; max: number };
  /** Percentage of context consumed before suggesting a continue-here checkpoint */
  continueThresholdPercent: number;
  /** Character budget for verification sections */
  verificationBudgetChars: number;
}

// ─── Minimal interface slices for dependency injection ───────────────────────
// These avoid coupling to full ModelRegistry/GSDPreferences types in tests.

export interface MinimalModel {
  id: string;
  provider: string;
  contextWindow: number;
}

export interface MinimalModelRegistry {
  getAll(): MinimalModel[];
}

export interface MinimalPreferences {
  models?: {
    execution?: string | { model: string; fallbacks?: string[] };
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute proportional budget allocations from a context window size (in tokens).
 *
 * Returns deterministic output for any given input. Invalid inputs (≤ 0)
 * silently default to 200K (D002).
 */
export function computeBudgets(contextWindow: number, provider?: TokenProvider): BudgetAllocation {
  const effectiveWindow = contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  const charsPerToken = provider ? getCharsPerToken(provider) : CHARS_PER_TOKEN;
  const totalChars = effectiveWindow * charsPerToken;

  return {
    summaryBudgetChars: Math.floor(totalChars * SUMMARY_RATIO),
    inlineContextBudgetChars: Math.floor(totalChars * INLINE_CONTEXT_RATIO),
    verificationBudgetChars: Math.floor(totalChars * VERIFICATION_RATIO),
    continueThresholdPercent: CONTINUE_THRESHOLD_PERCENT,
    taskCountRange: {
      min: TASK_COUNT_MIN,
      max: resolveTaskCountMax(effectiveWindow),
    },
  };
}

/**
 * Truncate content at markdown section boundaries to fit within a character budget.
 *
 * Splits on `### ` headings and `---` dividers. Keeps whole sections that fit.
 * Appends `[...truncated N sections]` when content is dropped.
 * Returns content unchanged when it fits within budget.
 *
 * @see D003 — section-boundary truncation is mandatory; mid-section cuts are unacceptable.
 */
export function truncateAtSectionBoundary(content: string, budgetChars: number): TruncationResult {
  if (!content || content.length <= budgetChars) {
    return { content, droppedSections: 0 };
  }

  // Split on section markers: ### headings or --- dividers (on their own line)
  const sections = splitIntoSections(content);

  if (sections.length <= 1) {
    // No section markers — keep as much as fits from the start
    const truncated = content.slice(0, budgetChars);
    return { content: truncated + "\n\n[...truncated 1 sections]", droppedSections: 1 };
  }

  // Greedily keep sections that fit
  let usedChars = 0;
  let keptCount = 0;

  for (const section of sections) {
    const sectionLen = section.length;
    if (usedChars + sectionLen > budgetChars && keptCount > 0) {
      break;
    }
    // Always keep at least the first section (even if it exceeds budget)
    usedChars += sectionLen;
    keptCount++;
    if (usedChars >= budgetChars) break;
  }

  const droppedCount = sections.length - keptCount;
  if (droppedCount === 0) {
    return { content, droppedSections: 0 };
  }

  const kept = sections.slice(0, keptCount).join("");
  return {
    content: kept.trimEnd() + `\n\n[...truncated ${droppedCount} sections]`,
    droppedSections: droppedCount,
  };
}

/**
 * Resolve the executor model's context window size using a fallback chain:
 *
 * 1. Look up the configured executor model ID in preferences → find in registry → return contextWindow
 * 2. Fall back to sessionContextWindow if provided
 * 3. Fall back to 200K default (D002)
 *
 * Supports "provider/model" format in preferences for explicit provider targeting.
 */
export function resolveExecutorContextWindow(
  registry: MinimalModelRegistry | undefined,
  preferences: MinimalPreferences | undefined,
  sessionContextWindow?: number,
): number {
  // Step 1: Try configured executor model
  if (preferences?.models?.execution && registry) {
    const executionConfig = preferences.models.execution;
    const modelId = typeof executionConfig === "string"
      ? executionConfig
      : executionConfig.model;

    if (modelId) {
      const model = findModelById(registry, modelId);
      if (model && model.contextWindow > 0) {
        return model.contextWindow;
      }
    }
  }

  // Step 2: Fall back to session context window
  if (sessionContextWindow && sessionContextWindow > 0) {
    return sessionContextWindow;
  }

  // Step 3: Fall back to default (D002)
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Smart context reduction: compress first, then truncate if still over budget.
 * Returns the content within budget with maximum information preservation.
 */
export function reduceToFit(content: string, budgetChars: number): TruncationResult {
  if (!content || content.length <= budgetChars) {
    return { content, droppedSections: 0 };
  }

  // Step 1: Try compression
  const compressed = compressToTarget(content, budgetChars);
  if (compressed.compressedChars <= budgetChars) {
    return { content: compressed.content, droppedSections: 0 };
  }

  // Step 2: Truncate the compressed content at section boundaries
  return truncateAtSectionBoundary(compressed.content, budgetChars);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Resolve task count ceiling from context window size.
 * Larger windows support more tasks per slice.
 */
function resolveTaskCountMax(contextWindow: number): number {
  for (const [threshold, max] of TASK_COUNT_TIERS) {
    if (contextWindow >= threshold) return max;
  }
  return 3; // fallback — unreachable given tiers include 0
}

/**
 * Split content into sections at `### ` headings or `---` dividers.
 * Each section includes its leading marker.
 */
function splitIntoSections(content: string): string[] {
  // Match section boundaries: ### heading or --- divider at start of line
  const pattern = /^(?=### |\-{3,}\s*$)/m;
  const parts = content.split(pattern).filter(p => p.length > 0);
  return parts;
}

/**
 * Find a model in the registry by ID string.
 * Supports "provider/model" format for explicit provider targeting,
 * or bare model ID (first match wins).
 */
function findModelById(registry: MinimalModelRegistry, modelId: string): MinimalModel | undefined {
  const allModels = registry.getAll();
  const slashIdx = modelId.indexOf("/");

  if (slashIdx !== -1) {
    const provider = modelId.substring(0, slashIdx).toLowerCase();
    const id = modelId.substring(slashIdx + 1).toLowerCase();
    return allModels.find(
      m => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id,
    );
  }

  // Bare ID — first match
  return allModels.find(m => m.id === modelId);
}
