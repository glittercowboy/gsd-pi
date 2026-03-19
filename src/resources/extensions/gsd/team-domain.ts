/**
 * GSD Team Domain Classification — labels slices/workers by domain
 * from file path patterns.
 *
 * Classifies file sets as Frontend, Backend, Infra, Data, Test, or
 * Unclassified using regex pattern matching. Provides roadmap-level
 * analysis that proposes domain-aware worker assignments.
 *
 * Fail-open: unknown patterns → "unclassified" (never throws, never blocks).
 */

import { parseRoadmap, parsePlan, loadFile } from "./files.js";
import { resolveMilestoneFile, resolveSliceFile } from "./paths.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DomainLabel =
  | "frontend"
  | "backend"
  | "infra"
  | "data"
  | "test"
  | "unclassified";

export interface DomainSplitSlice {
  id: string;
  title: string;
  domain: DomainLabel;
  files: string[];
  confidence: number; // 0.0–1.0, 0.0 for unclassified
}

export interface DomainSplitProposal {
  slices: DomainSplitSlice[];
  edges: Array<{ from: string; to: string }>;
  overrides: Map<string, DomainLabel>;
}

// ─── Domain Patterns ─────────────────────────────────────────────────────────

/**
 * Map of DomainLabel → regex patterns that match file paths to that domain.
 * Order matters: first matching domain wins for files matching multiple patterns.
 * Test patterns are checked first since `.test.` and `.spec.` are highly explicit.
 */
export const DOMAIN_PATTERNS: ReadonlyMap<DomainLabel, readonly RegExp[]> = new Map<
  DomainLabel,
  readonly RegExp[]
>([
  [
    "test",
    [
      /\/tests\//,
      /\/test\//,
      /\/__tests__\//,
      /\.test\./,
      /\.spec\./,
      /\/fixtures\//,
    ],
  ],
  [
    "frontend",
    [
      /\/components\//,
      /\/pages\//,
      /\/app\//,
      /\/hooks\//,
      /\/styles\//,
      /\/css\//,
      /\.tsx$/,
      /\.jsx$/,
      /\/ui\//,
      /\/views\//,
      /\/layouts\//,
    ],
  ],
  [
    "backend",
    [
      /\/api\//,
      /\/server\//,
      /\/routes\//,
      /\/controllers\//,
      /\/middleware\//,
      /\/db\//,
      /\/database\//,
      /\/models\//,
      /\/schema\//,
      /\/migrations\//,
    ],
  ],
  [
    "infra",
    [
      /\/infra\//,
      /(^|\/)terraform\//,
      /\/docker\//,
      /\/ci\//,
      /\/deploy\//,
      /(^|\/)\.github\//,
      /(^|\/)Dockerfile/,
      /\/k8s\//,
      /\/helm\//,
    ],
  ],
  [
    "data",
    [
      /\/data\//,
      /\/analytics\//,
      /\/etl\//,
      /\/pipelines\//,
      /\/scripts\/data/,
    ],
  ],
]);

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a single file path to its domain.
 * Returns the first matching domain, or "unclassified" if no pattern matches.
 */
function classifyFile(filePath: string): DomainLabel {
  for (const [domain, patterns] of DOMAIN_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(filePath)) return domain;
    }
  }
  return "unclassified";
}

/**
 * Classify a set of files by majority domain vote.
 *
 * For each file, matches against DOMAIN_PATTERNS. Counts votes per domain.
 * If one domain has strict majority (>50% of classified files), returns it.
 * If no majority or all files are unclassifiable, returns "unclassified".
 *
 * Operates on path strings only — no filesystem access.
 */
export function classifyDomain(files: string[]): DomainLabel {
  if (files.length === 0) return "unclassified";

  const votes = new Map<DomainLabel, number>();
  let classifiedCount = 0;

  for (const file of files) {
    const domain = classifyFile(file);
    if (domain !== "unclassified") {
      classifiedCount++;
      votes.set(domain, (votes.get(domain) ?? 0) + 1);
    }
  }

  if (classifiedCount === 0) return "unclassified";

  // Find domain with the most votes
  let bestDomain: DomainLabel = "unclassified";
  let bestCount = 0;
  for (const [domain, count] of votes) {
    if (count > bestCount) {
      bestCount = count;
      bestDomain = domain;
    }
  }

  // Strict majority: >50% of classified files
  if (bestCount > classifiedCount / 2) return bestDomain;

  return "unclassified";
}

// ─── Split Analysis ──────────────────────────────────────────────────────────

/**
 * Compute confidence for a domain classification.
 * Ratio of majority-domain files to total files (0.0–1.0).
 * Returns 0.0 when domain is "unclassified".
 */
function computeConfidence(files: string[], domain: DomainLabel): number {
  if (domain === "unclassified" || files.length === 0) return 0;

  let majorityCount = 0;
  for (const file of files) {
    if (classifyFile(file) === domain) majorityCount++;
  }
  return majorityCount / files.length;
}

/**
 * Analyze a milestone's roadmap and propose domain-aware worker assignments.
 *
 * Reads the roadmap, collects per-slice files from their plans, classifies
 * each slice, and returns a structured proposal with domain assignments,
 * dependency edges, and confidence scores.
 *
 * Fail-open: missing roadmap/plans → empty proposal. Per-slice errors are
 * silently skipped (slice gets unclassified with empty files).
 */
export async function analyzeDomainSplit(
  basePath: string,
  milestoneId: string,
): Promise<DomainSplitProposal> {
  const emptyProposal: DomainSplitProposal = {
    slices: [],
    edges: [],
    overrides: new Map(),
  };

  // Load roadmap
  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!roadmapPath) return emptyProposal;

  const roadmapContent = await loadFile(roadmapPath);
  if (!roadmapContent) return emptyProposal;

  const roadmap = parseRoadmap(roadmapContent);
  const sliceResults: DomainSplitSlice[] = [];
  const edges: Array<{ from: string; to: string }> = [];

  for (const slice of roadmap.slices) {
    // Collect per-slice files from plan
    let files: string[] = [];
    try {
      const planPath = resolveSliceFile(basePath, milestoneId, slice.id, "PLAN");
      if (planPath) {
        const planContent = await loadFile(planPath);
        if (planContent) {
          const plan = parsePlan(planContent);
          files = plan.filesLikelyTouched;
        }
      }
    } catch {
      // Fail-open: skip this slice's files on error
    }

    const domain = classifyDomain(files);
    const confidence = computeConfidence(files, domain);

    sliceResults.push({
      id: slice.id,
      title: slice.title,
      domain,
      files,
      confidence,
    });

    // Extract dependency edges
    if (slice.depends) {
      for (const dep of slice.depends) {
        edges.push({ from: dep, to: slice.id });
      }
    }
  }

  return {
    slices: sliceResults,
    edges,
    overrides: new Map(),
  };
}

// ─── Override ────────────────────────────────────────────────────────────────

/**
 * Apply manual domain overrides to a split proposal.
 *
 * Returns a new proposal where overridden slices get the specified domain
 * with confidence 1.0. Non-overridden slices are unchanged.
 */
export function applyDomainOverride(
  proposal: DomainSplitProposal,
  overrides: Record<string, DomainLabel>,
): DomainSplitProposal {
  const overrideMap = new Map<string, DomainLabel>(Object.entries(overrides) as [string, DomainLabel][]);

  // Merge with any existing overrides
  for (const [key, value] of proposal.overrides) {
    if (!overrideMap.has(key)) overrideMap.set(key, value);
  }

  const slices = proposal.slices.map((slice) => {
    const overrideDomain = overrides[slice.id];
    if (overrideDomain) {
      return { ...slice, domain: overrideDomain, confidence: 1.0 };
    }
    return slice;
  });

  return {
    slices,
    edges: proposal.edges,
    overrides: overrideMap,
  };
}

// ─── Proposal Formatter ──────────────────────────────────────────────────────

/**
 * Format a DomainSplitProposal as a readable report for CLI display.
 */
export function formatSplitProposal(proposal: DomainSplitProposal): string {
  const lines: string[] = ["# Domain Split Proposal", ""];

  if (proposal.slices.length === 0) {
    lines.push("No slices found in this milestone.");
    return lines.join("\n");
  }

  for (const slice of proposal.slices) {
    const domain = slice.domain.charAt(0).toUpperCase() + slice.domain.slice(1);
    lines.push(`- **${slice.id}: ${slice.title}** → ${domain} (confidence: ${slice.confidence.toFixed(2)})`);
  }

  if (proposal.edges.length > 0) {
    lines.push("");
    lines.push(`Dependencies: ${proposal.edges.map((e) => `${e.from} → ${e.to}`).join(", ")}`);
  }

  lines.push("");
  lines.push("Use `/gsd parallel split <mid> --override S01=frontend` to manually assign domains.");

  return lines.join("\n");
}
