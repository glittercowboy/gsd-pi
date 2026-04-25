/**
 * GSD Command — /gsd extract-learnings
 *
 * Analyses completed milestone artefacts and dispatches an LLM turn that
 * extracts structured knowledge into 4 categories (Decisions · Lessons ·
 * Patterns · Surprises), writes a LEARNINGS.md audit trail, and persists
 * the durable subset into the GSD memory store via capture_thought:
 *
 *   - Patterns  → capture_thought(category="pattern")
 *   - Lessons   → capture_thought(category="gotcha" | "convention")
 *   - Decisions → capture_thought(category="architecture", structuredFields=...)
 *   - Surprises → stay only in LEARNINGS.md (milestone-local context).
 *
 * Per ADR-013 step 6 (cutover), the memories table is the single source of
 * truth for cross-session durable knowledge. The legacy KNOWLEDGE.md table
 * appends and gsd_save_decision call-outs were removed from this flow; the
 * pre-existing decisions table was migrated by the step 5 backfill.
 *
 * The same extraction steps are reused by the complete-milestone prompt
 * via buildExtractionStepsBlock — single source of truth.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";

import { gsdRoot, resolveMilestonePath } from "./paths.js";
import { projectRoot } from "./commands/context.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Resolved paths for the four artefact files that feed a milestone-scoped
 * learnings extraction. Paths are absolute when the file exists; `null`
 * otherwise. `missingRequired` lists the filenames (not full paths) of the
 * required artefacts that could not be found.
 */
export interface PhaseArtifacts {
  /** Absolute path to `{MID}-ROADMAP.md`, or `null` if the file is missing. */
  roadmap: string | null;
  /** Absolute path to `{MID}-SUMMARY.md`, or `null` if the file is missing. */
  summary: string | null;
  /** Absolute path to `{MID}-VERIFICATION.md` (optional), or `null`. */
  verification: string | null;
  /** Absolute path to `{MID}-UAT.md` (optional), or `null`. */
  uat: string | null;
  /** Filenames of required artefacts that could not be resolved. */
  missingRequired: string[];
}

/**
 * Full context required by `buildExtractLearningsPrompt` to construct the
 * manual `/gsd extract-learnings` dispatch prompt. Covers the milestone
 * identity, the output target, the inlined artefact contents, and any
 * missing optional artefacts that should be surfaced to the agent.
 */
export interface ExtractLearningsPromptContext {
  /** Milestone identifier, e.g. `"M001"` or `"M001-ush8s3"` (team mode). */
  milestoneId: string;
  /** Human-readable milestone title, taken from the roadmap H1 when present. */
  milestoneName: string;
  /** Absolute filesystem path at which the LEARNINGS.md file will be written. */
  outputPath: string;
  /** Project-root-relative path for the same file, used in prompt prose. */
  relativeOutputPath: string;
  /** Inlined contents of `{MID}-ROADMAP.md` (required). */
  roadmapContent: string;
  /** Inlined contents of `{MID}-SUMMARY.md` (required). */
  summaryContent: string;
  /** Inlined contents of `{MID}-VERIFICATION.md` when the file exists, else `null`. */
  verificationContent: string | null;
  /** Inlined contents of `{MID}-UAT.md` when the file exists, else `null`. */
  uatContent: string | null;
  /** Filenames of optional artefacts that were not available for inlining. */
  missingArtifacts: string[];
  /** Display name of the enclosing project (from `.gsd/PROJECT.md` or dir basename). */
  projectName: string;
}

/**
 * Minimal context required to render the structured-extraction steps block.
 *
 * The block is milestone-scoped — it only needs the milestone ID (used for
 * `scope` on every capture_thought call) and the LEARNINGS.md output
 * path (both absolute for unambiguous writes and relative for display in the
 * prompt). Artefact content is NOT part of this context because both render
 * sites (manual path and complete-milestone auto path) supply it separately.
 */
export interface ExtractionStepsContext {
  /** Milestone identifier, e.g. `"M001"` or `"M001-ush8s3"` (team mode). */
  milestoneId: string;
  /** Absolute filesystem path at which the LEARNINGS.md file will be written. */
  outputPath: string;
  /** Project-root-relative path for the same file, used in prompt prose. */
  relativeOutputPath: string;
}

/**
 * Shape of the YAML frontmatter written at the top of `{MID}-LEARNINGS.md`.
 *
 * Produced by `buildFrontmatter` — consumed only by the human-readable audit
 * trail, not by any downstream automated pipeline. The `counts` object and
 * `missing_artifacts` list exist so reviewers can spot truncated extractions
 * at a glance.
 */
export interface FrontmatterContext {
  /** Milestone identifier (becomes the `phase` key). */
  milestoneId: string;
  /** Milestone title (becomes the `phase_name` key). */
  milestoneName: string;
  /** Project display name. */
  projectName: string;
  /** ISO-8601 UTC timestamp of when the extraction was performed. */
  generatedAt: string;
  /** Counts of extracted items per category. */
  counts: {
    decisions: number;
    lessons: number;
    patterns: number;
    surprises: number;
  };
  /** Filenames of optional artefacts that were not available during extraction. */
  missingArtifacts: string[];
}

// ─── Pure functions ───────────────────────────────────────────────────────────

/**
 * Parses the argument string passed to `/gsd extract-learnings`.
 *
 * Returns `{ milestoneId: null }` for empty / whitespace-only input — the
 * handler surfaces a usage hint in that case. A non-empty trimmed value is
 * returned as-is; the handler validates that the milestone actually exists.
 */
export function parseExtractLearningsArgs(args: string): { milestoneId: string | null } {
  const trimmed = args.trim();
  return { milestoneId: trimmed || null };
}

/**
 * Builds the absolute path at which the LEARNINGS.md audit trail should be
 * written for the given milestone.
 */
export function buildLearningsOutputPath(milestoneDir: string, milestoneId: string): string {
  return join(milestoneDir, `${milestoneId}-LEARNINGS.md`);
}

/**
 * Resolves the milestone-scoped artefact paths needed to perform an
 * extraction. The milestone's ROADMAP and SUMMARY files are required; the
 * VERIFICATION and UAT files are optional. Missing required files are
 * reported by filename in `missingRequired` so the handler can surface a
 * precise error without swallowing the cause.
 */
export function resolvePhaseArtifacts(milestoneDir: string, milestoneId: string): PhaseArtifacts {
  const missingRequired: string[] = [];

  const roadmapFile = `${milestoneId}-ROADMAP.md`;
  const summaryFile = `${milestoneId}-SUMMARY.md`;
  const verificationFile = `${milestoneId}-VERIFICATION.md`;
  const uatFile = `${milestoneId}-UAT.md`;

  const roadmapPath = join(milestoneDir, roadmapFile);
  const summaryPath = join(milestoneDir, summaryFile);
  const verificationPath = join(milestoneDir, verificationFile);
  const uatPath = join(milestoneDir, uatFile);

  const roadmap = existsSync(roadmapPath) ? roadmapPath : null;
  const summary = existsSync(summaryPath) ? summaryPath : null;
  const verification = existsSync(verificationPath) ? verificationPath : null;
  const uat = existsSync(uatPath) ? uatPath : null;

  if (!roadmap) missingRequired.push(roadmapFile);
  if (!summary) missingRequired.push(summaryFile);

  return { roadmap, summary, verification, uat, missingRequired };
}

/**
 * Canonical structured-extraction instructions.
 *
 * Used in two places — kept in sync by construction:
 *   1. /gsd extract-learnings manual path (buildExtractLearningsPrompt).
 *   2. complete-milestone auto path ({{extractLearningsSteps}} placeholder,
 *      injected by auto-prompts::buildCompleteMilestonePrompt).
 *
 * The block assumes the LLM already has the milestone artefacts available —
 * either inlined directly in the manual path, or via {{inlinedContext}} in
 * complete-milestone. It does not re-inline artefacts.
 */
export function buildExtractionStepsBlock(ctx: ExtractionStepsContext): string {
  return `## Structured Learnings Extraction

Perform the following steps IN ORDER. Each step is mandatory unless explicitly
marked optional. These instructions are the single source of truth shared by
\`/gsd extract-learnings\` and the auto-mode milestone-completion turn.

### Step 1 — Classify findings into four categories

Review the milestone artefacts (roadmap, slice summaries, verification report,
UAT report) and structure your findings into exactly four categories:

- **Decisions** — architectural or design choices made during this milestone, including rationale and alternatives considered.
- **Lessons** — technical discoveries, process insights, knowledge gaps that were filled.
- **Patterns** — reusable approaches or solutions that emerged and should be applied in future work.
- **Surprises** — unexpected challenges, discoveries, or outcomes that deviated from assumptions.

Every item MUST carry a \`Source:\` line using the format
\`Source: {artifact-filename}/{section}\` (e.g.
\`Source: ${ctx.milestoneId}-ROADMAP.md/Architecture Decisions\`).
Items without a source attribution are invalid — drop them.

### Step 2 — Write the LEARNINGS.md audit trail

Using the \`write\` tool, persist the full structured report to
\`${ctx.relativeOutputPath}\` with this shape:

- YAML frontmatter with keys: \`phase\`, \`phase_name\`, \`project\`, \`generated\` (ISO-8601 UTC), \`counts\` (decisions / lessons / patterns / surprises), \`missing_artifacts\`.
- Four H3 sections (\`### Decisions\`, \`### Lessons\`, \`### Patterns\`, \`### Surprises\`) containing bullet points. Each bullet is followed by its \`Source:\` line.

LEARNINGS.md is the full, cited audit trail. Write it first — subsequent steps
feed from its content.

### Step 3 — Optionally pre-query the memory store for semantic duplicates

Before persisting any extracted item in Steps 4–6, you may call
\`memory_query\` with 2–3 keywords from the item to check whether the
memory store already holds a semantically equivalent entry at high
confidence. Skip those items in their respective steps. The memory store
is the single source of truth for cross-session durable knowledge — no
other persistence call is part of this flow.

### Step 4 — Persist Patterns via \`capture_thought\`

For each extracted Pattern, call \`capture_thought\` exactly once with:
- \`category: "pattern"\`
- \`content\`: a 1–2 sentence restatement combining the Pattern, Where, and any non-obvious notes
- \`scope: "${ctx.milestoneId}"\`

Skip the call if a high-confidence semantic duplicate is already present
(see Step 7 dedup rule).

### Step 5 — Persist Lessons via \`capture_thought\`

For each extracted Lesson, call \`capture_thought\` exactly once with:
- \`category: "gotcha"\` when the Lesson describes a pitfall, surprise root cause, or recurring failure mode; \`category: "convention"\` when it describes a project-wide rule or normative practice
- \`content\`: a 1–3 sentence restatement of What Happened + Root Cause + Fix
- \`scope: "${ctx.milestoneId}"\`

Skip the call if a high-confidence semantic duplicate is already present
(see Step 7 dedup rule).

### Step 6 — Persist Decisions via \`capture_thought\`

For each extracted Decision, call \`capture_thought\` exactly once with:
- \`category: "architecture"\`
- \`content\`: a 1–3 sentence restatement combining decision + choice + rationale (e.g. "Chose X over Y because Z")
- \`scope: "${ctx.milestoneId}"\`
- \`structuredFields\`: an object preserving the original decision schema:
  \`{ scope: "${ctx.milestoneId}", decision: <question>, choice: <option>, rationale: <why>, made_by: "agent", revisable: "yes" | "no" | omit }\`

Skip the call if a high-confidence semantic duplicate is already present.

The structured payload is required for architecture-category memories so
later projection back to a human-visible decisions register stays lossless
(ADR-013 source-of-truth boundaries).

### Step 7 — Deduplication rule (applies to Steps 4, 5, 6)

Before each \`capture_thought\` call, optionally call \`memory_query\` with 2–3
keywords from the entry. If a semantically equivalent memory is returned at
high confidence, skip the capture entirely. Prefer skipping a near-duplicate
over creating a second slightly-different row — redundancy degrades the
signal.

### Step 8 — Surprises stay only in LEARNINGS.md

Surprises are milestone-local context and are NOT cross-session-reusable. Do
not persist them via \`capture_thought\` or any other MCP tool. They are
captured only in the LEARNINGS.md file written in Step 2.`;
}

/**
 * Build the full dispatch prompt for the manual `/gsd extract-learnings` path.
 *
 * Composes a header block (title, project, output file), the inlined milestone
 * artefacts (roadmap, summary, optional verification and UAT reports), and the
 * canonical {@link buildExtractionStepsBlock} procedure. The same procedure is
 * rendered verbatim in the auto-mode `complete-milestone` turn via the
 * `{{extractLearningsSteps}}` placeholder, guaranteeing a single source of
 * truth for how learnings flow into the GSD memory store via capture_thought.
 *
 * Missing optional artefacts are surfaced as a note at the end of the artefact
 * section so the LLM can mark them explicitly in the LEARNINGS frontmatter.
 */
export function buildExtractLearningsPrompt(ctx: ExtractLearningsPromptContext): string {
  const optionalSections: string[] = [];

  if (ctx.verificationContent) {
    optionalSections.push(`### Verification Report\n\n${ctx.verificationContent}`);
  }
  if (ctx.uatContent) {
    optionalSections.push(`### UAT Report\n\n${ctx.uatContent}`);
  }

  const missingNote = ctx.missingArtifacts.length > 0
    ? `\nNote: the following optional artefacts were not available: ${ctx.missingArtifacts.join(", ")}\n`
    : "";

  const stepsBlock = buildExtractionStepsBlock({
    milestoneId: ctx.milestoneId,
    outputPath: ctx.outputPath,
    relativeOutputPath: ctx.relativeOutputPath,
  });

  return `# Extract Learnings — ${ctx.milestoneId}: ${ctx.milestoneName}

**Project:** ${ctx.projectName}
**Output file:** ${ctx.outputPath}

## Your Task

Analyse the milestone artefacts inlined below and follow the Structured
Learnings Extraction procedure in full. The procedure writes LEARNINGS.md
as the milestone-local audit trail and persists the durable subset into the
GSD memory store via \`capture_thought\` (categories: pattern, gotcha or
convention, architecture). The memory store is the single source of truth
for cross-session durable knowledge (ADR-013).

---

## Artefacts

### Roadmap

${ctx.roadmapContent}

---

### Summary

${ctx.summaryContent}
${optionalSections.length > 0 ? `\n---\n\n${optionalSections.join("\n\n---\n\n")}\n` : ""}${missingNote}
---

${stepsBlock}
`;
}

/**
 * Serialises the YAML frontmatter block prepended to `{MID}-LEARNINGS.md`.
 *
 * The output begins and ends with a `---` fence so it can be concatenated
 * directly with the body. Empty `missingArtifacts` is rendered as an
 * inline empty list (`missing_artifacts: []`) to keep the frontmatter valid
 * YAML in every case.
 */
export function buildFrontmatter(ctx: FrontmatterContext): string {
  const missingList = ctx.missingArtifacts.length > 0
    ? ctx.missingArtifacts.map((a) => `  - ${a}`).join("\n")
    : "  []";

  const missingValue = ctx.missingArtifacts.length > 0
    ? `\n${missingList}`
    : " []";

  return `---
phase: ${ctx.milestoneId}
phase_name: ${ctx.milestoneName}
project: ${ctx.projectName}
generated: ${ctx.generatedAt}
counts:
  decisions: ${ctx.counts.decisions}
  lessons: ${ctx.counts.lessons}
  patterns: ${ctx.counts.patterns}
  surprises: ${ctx.counts.surprises}
missing_artifacts:${missingValue}
---`;
}

/**
 * Extracts the project display name from `.gsd/PROJECT.md` frontmatter.
 *
 * Falls back to the project directory's basename if PROJECT.md is missing,
 * unreadable, or has no `name:` field. Never throws — surfacing the raw
 * directory name is preferable to crashing an extraction over a display
 * string.
 */
export function extractProjectName(basePath: string): string {
  const projectMdPath = join(gsdRoot(basePath), "PROJECT.md");

  if (existsSync(projectMdPath)) {
    try {
      const content = readFileSync(projectMdPath, "utf-8");
      const match = content.match(/^name:\s*(.+)$/m);
      if (match) return match[1].trim();
    } catch {
      // non-fatal
    }
  }

  return basename(basePath);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Handles the `/gsd extract-learnings <MID>` slash command.
 *
 * Resolves and reads the milestone artefacts, constructs the dispatch prompt
 * via {@link buildExtractLearningsPrompt}, and triggers a new LLM turn via
 * `pi.sendMessage({ triggerTurn: true })`. Returns quickly with a UI
 * notification (not an error) when the milestone cannot be found or required
 * artefacts are missing, matching the behaviour of sibling `/gsd` commands.
 */
export async function handleExtractLearnings(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const { milestoneId } = parseExtractLearningsArgs(args);

  if (!milestoneId) {
    ctx.ui.notify("Usage: /gsd extract-learnings <milestoneId>  (e.g. M001)", "warning");
    return;
  }

  // projectRoot() throws GSDNoProjectError if no project found — intentional, handled by dispatcher
  const basePath = projectRoot();
  const milestoneDir = resolveMilestonePath(basePath, milestoneId);

  if (!milestoneDir) {
    ctx.ui.notify(`Milestone not found: ${milestoneId}`, "error");
    return;
  }

  const artifacts = resolvePhaseArtifacts(milestoneDir, milestoneId);

  if (artifacts.missingRequired.length > 0) {
    ctx.ui.notify(
      `Cannot extract learnings — required artefacts missing: ${artifacts.missingRequired.join(", ")}`,
      "error",
    );
    return;
  }

  const roadmapContent = readFileSync(artifacts.roadmap!, "utf-8");
  const summaryContent = readFileSync(artifacts.summary!, "utf-8");

  const verificationContent = artifacts.verification
    ? readFileSync(artifacts.verification, "utf-8")
    : null;
  const uatContent = artifacts.uat
    ? readFileSync(artifacts.uat, "utf-8")
    : null;

  const missingArtifacts: string[] = [];
  if (!artifacts.verification) missingArtifacts.push(`${milestoneId}-VERIFICATION.md`);
  if (!artifacts.uat) missingArtifacts.push(`${milestoneId}-UAT.md`);

  const h1Match = roadmapContent.match(/^#\s+(.+)$/m);
  const milestoneName = h1Match?.[1]?.trim() ?? milestoneId;

  const projectName = extractProjectName(basePath);
  const outputPath = buildLearningsOutputPath(milestoneDir, milestoneId);
  const relativeOutputPath = relative(basePath, outputPath);

  const prompt = buildExtractLearningsPrompt({
    milestoneId,
    milestoneName,
    outputPath,
    relativeOutputPath,
    roadmapContent,
    summaryContent,
    verificationContent,
    uatContent,
    missingArtifacts,
    projectName,
  });

  ctx.ui.notify(`Extracting learnings for ${milestoneId}: "${milestoneName}"...`, "info");

  pi.sendMessage(
    { customType: "gsd-extract-learnings", content: prompt, display: false },
    { triggerTurn: true },
  );
}
