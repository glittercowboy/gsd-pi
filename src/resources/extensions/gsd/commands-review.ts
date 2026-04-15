/**
 * GSD Command — /gsd review
 *
 * Invokes external AI CLIs to independently review a milestone's plans.
 * Each CLI receives the same prompt (PROJECT.md context, roadmap, research,
 * decisions) and produces structured feedback. Results are combined into
 * {milestoneId}-REVIEWS.md with a consensus summary.
 *
 * Adapted from get-shit-done v1 `gsd:review` (cross-AI peer review pattern).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { resolveFile, resolveMilestonePath } from "./paths.js";
import { projectRoot } from "./commands/context.js";
import { extractProjectName } from "./commands-extract-learnings.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewArtifacts {
  roadmapPath: string | null;
  contextPath: string | null;
  researchPath: string | null;
  missingRequired: string[];
}

export interface ReviewPromptContext {
  milestoneId: string;
  milestoneName: string;
  outputPath: string;
  relativeOutputPath: string;
  roadmapContent: string;
  contextContent: string | null;
  researchContent: string | null;
  projectName: string;
}

// ─── Pure functions ───────────────────────────────────────────────────────────

export function parseReviewArgs(args: string): { milestoneId: string | null } {
  const first = args.trim().split(/\s+/)[0] ?? "";
  if (!first) return { milestoneId: null };
  // Regex is intentional: milestoneId is interpolated into shell commands in the prompt template.
  // Do NOT relax without auditing all uses in buildReviewPrompt().
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(first)) return { milestoneId: null };
  return { milestoneId: first };
}

export function buildReviewOutputPath(milestoneDir: string, milestoneId: string): string {
  return join(milestoneDir, `${milestoneId}-REVIEWS.md`);
}

export function resolveReviewArtifacts(milestoneDir: string, milestoneId: string): ReviewArtifacts {
  const missingRequired: string[] = [];

  const roadmapName = resolveFile(milestoneDir, milestoneId, "ROADMAP");
  const contextName = resolveFile(milestoneDir, milestoneId, "CONTEXT");
  const researchName = resolveFile(milestoneDir, milestoneId, "RESEARCH");

  const roadmapPath = roadmapName ? join(milestoneDir, roadmapName) : null;
  const contextPath = contextName ? join(milestoneDir, contextName) : null;
  const researchPath = researchName ? join(milestoneDir, researchName) : null;

  if (!roadmapPath) missingRequired.push(`${milestoneId}-ROADMAP.md`);

  return { roadmapPath, contextPath, researchPath, missingRequired };
}

export function buildReviewPrompt(ctx: ReviewPromptContext): string {
  const optionalSections: string[] = [];

  if (ctx.contextContent) {
    optionalSections.push(`## User Decisions (CONTEXT.md)\n\n${ctx.contextContent}`);
  }
  if (ctx.researchContent) {
    optionalSections.push(`## Research Findings\n\n${ctx.researchContent}`);
  }

  const optionalBlock = optionalSections.length > 0
    ? "\n\n" + optionalSections.join("\n\n---\n\n")
    : "";

  return `# Cross-AI Plan Review — ${ctx.milestoneId}: ${ctx.milestoneName}

**Project:** ${ctx.projectName}
**Output file:** ${ctx.outputPath}

## Your Task

Perform a cross-AI peer review of the milestone plans below. Invoke available external AI CLIs
to get independent perspectives, then synthesise the results into a REVIEWS.md file.

---

## Step 1 — Detect available AI CLIs

Run these checks:

\`\`\`bash
command -v gemini   >/dev/null 2>&1 && echo "gemini:available"   || echo "gemini:missing"
# claude/pi is the current agent — always excluded from external review
command -v codex    >/dev/null 2>&1 && echo "codex:available"    || echo "codex:missing"
command -v opencode >/dev/null 2>&1 && echo "opencode:available" || echo "opencode:missing"
command -v qwen     >/dev/null 2>&1 && echo "qwen:available"     || echo "qwen:missing"
command -v cursor   >/dev/null 2>&1 && echo "cursor:available"   || echo "cursor:missing"
\`\`\`

If no external CLI is available, skip to Step 4 and write a self-review instead.

---

## Step 2 — Build the review prompt

Write the following prompt to a temp file at \`/tmp/gsd-review-prompt-${ctx.milestoneId}.md\`:

\`\`\`
# Cross-AI Plan Review Request

You are reviewing implementation plans for a software milestone.
Provide structured feedback on plan quality, completeness, and risks.

## Project: ${ctx.projectName}

## Milestone ${ctx.milestoneId}: ${ctx.milestoneName}

### Roadmap

${ctx.roadmapContent}
${optionalBlock}

## Review Instructions

Analyse the milestone plan and provide:

1. **Summary** — One-paragraph assessment
2. **Strengths** — What is well-designed (bullet points)
3. **Concerns** — Potential issues, gaps, risks (bullet points with severity: HIGH/MEDIUM/LOW)
4. **Suggestions** — Specific improvements (bullet points)
5. **Risk Assessment** — Overall risk level (LOW/MEDIUM/HIGH) with justification

Focus on:
- Missing edge cases or error handling
- Dependency ordering issues
- Scope creep or over-engineering
- Security considerations
- Performance implications
- Whether the plans actually achieve the milestone goals

Output your review in markdown format.
\`\`\`

---

## Step 3 — Invoke each available external CLI sequentially

Use fast/lightweight models for reviews — review tasks don't require the heaviest model.
For each available CLI (skip your own):

**Gemini** (recommended model: gemini-2.0-flash — fast, strong reasoning):
\`\`\`bash
cat /tmp/gsd-review-prompt-${ctx.milestoneId}.md | gemini -m gemini-2.0-flash -p - 2>/dev/null > /tmp/gsd-review-gemini-${ctx.milestoneId}.md
\`\`\`

**Codex** (recommended model: o4-mini — lighter reasoning, sufficient for review):
\`\`\`bash
cat /tmp/gsd-review-prompt-${ctx.milestoneId}.md | codex exec --model o4-mini --skip-git-repo-check - 2>/dev/null > /tmp/gsd-review-codex-${ctx.milestoneId}.md
\`\`\`

**OpenCode** (uses its configured default model):
\`\`\`bash
cat /tmp/gsd-review-prompt-${ctx.milestoneId}.md | opencode run - 2>/dev/null > /tmp/gsd-review-opencode-${ctx.milestoneId}.md
\`\`\`

**Qwen** (uses its configured default model):
\`\`\`bash
cat /tmp/gsd-review-prompt-${ctx.milestoneId}.md | qwen - 2>/dev/null > /tmp/gsd-review-qwen-${ctx.milestoneId}.md
\`\`\`

**Cursor** (uses its configured default model):
\`\`\`bash
cat /tmp/gsd-review-prompt-${ctx.milestoneId}.md | cursor agent -p --mode ask --trust 2>/dev/null > /tmp/gsd-review-cursor-${ctx.milestoneId}.md
\`\`\`

If a CLI fails or returns empty output, log a note and continue with the remaining CLIs.

---

## Step 4 — Write the REVIEWS.md file

Combine all review responses into \`${ctx.outputPath}\`:

The file must follow this structure:

\`\`\`markdown
---
milestone: ${ctx.milestoneId}
milestone_name: ${ctx.milestoneName}
project: ${ctx.projectName}
reviewed_at: {ISO timestamp}
reviewers: [{list of CLIs that responded}]
---

# Cross-AI Plan Review — ${ctx.milestoneId}: ${ctx.milestoneName}

## {CLI Name} Review

{review content}

---

## Consensus Summary

### Agreed Strengths
{strengths mentioned by 2+ reviewers}

### Agreed Concerns
{concerns raised by 2+ reviewers — highest priority first}

### Divergent Views
{where reviewers disagreed}
\`\`\`

If only a self-review is possible (no external CLIs available), write a single-reviewer
REVIEWS.md clearly noting that no external CLIs were available, and perform the review
yourself using the prompt from Step 2.

---

## Step 5 — Clean up temp files

\`\`\`bash
rm -f /tmp/gsd-review-prompt-${ctx.milestoneId}.md /tmp/gsd-review-*-${ctx.milestoneId}.md
\`\`\`

---

## Step 6 — Display results and offer next actions

After writing the file, output the **full contents** of \`${ctx.outputPath}\` to the chat
so the user can read the reviews immediately without opening the file.

Then display this action menu:

\`\`\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 REVIEW COMPLETE — ${ctx.milestoneId}: ${ctx.milestoneName}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Reviewed by {N} AI system(s).  Full report: ${ctx.relativeOutputPath}

What would you like to do with the findings?

  A) Incorporate all agreed concerns into the roadmap
     → /gsd steer update ${ctx.milestoneId} roadmap based on review findings

  B) Discuss a specific concern before acting
     → /gsd discuss <concern from the review>

  C) Re-run with additional reviewers
     → /gsd review ${ctx.milestoneId}

  D) Continue to next step (ignore review)
     → /gsd next
\`\`\`

Wait for the user to choose. If the user says "A" or "incorporate" or similar, apply the
agreed concerns from the Consensus Summary as steering changes to the milestone ROADMAP
by calling \`/gsd steer\` with a precise description of each change.
`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleReview(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const { milestoneId } = parseReviewArgs(args);

  if (!milestoneId) {
    ctx.ui.notify("Usage: /gsd review <milestoneId>  (e.g. M001)", "warning");
    return;
  }

  // projectRoot() throws GSDNoProjectError if no project found — intentional, handled by dispatcher
  const basePath = projectRoot();
  const milestoneDir = resolveMilestonePath(basePath, milestoneId);

  if (!milestoneDir) {
    ctx.ui.notify(`Milestone not found: ${milestoneId}`, "error");
    return;
  }

  const artifacts = resolveReviewArtifacts(milestoneDir, milestoneId);

  if (artifacts.missingRequired.length > 0) {
    ctx.ui.notify(
      `Cannot review — required artefacts missing: ${artifacts.missingRequired.join(", ")}`,
      "error",
    );
    return;
  }

  // Read required artefact — roadmapPath is guaranteed non-null after the missingRequired guard above
  if (!artifacts.roadmapPath) {
    ctx.ui.notify("Internal error: roadmapPath unexpectedly null after validation", "error");
    return;
  }
  const roadmapContent = readFileSync(artifacts.roadmapPath, "utf-8");

  // Read optional artefacts
  const contextContent = artifacts.contextPath
    ? readFileSync(artifacts.contextPath, "utf-8")
    : null;
  const researchContent = artifacts.researchPath
    ? readFileSync(artifacts.researchPath, "utf-8")
    : null;

  // Extract milestone name from Roadmap H1 or fall back to milestoneId
  const h1Match = roadmapContent.match(/^#\s+(.+)$/m);
  const milestoneName = h1Match?.[1]?.trim() ?? milestoneId;

  const projectName = extractProjectName(basePath);
  const outputPath = buildReviewOutputPath(milestoneDir, milestoneId);
  const relativeOutputPath = relative(basePath, outputPath);

  const prompt = buildReviewPrompt({
    milestoneId,
    milestoneName,
    outputPath,
    relativeOutputPath,
    roadmapContent,
    contextContent,
    researchContent,
    projectName,
  });

  ctx.ui.notify(`Starting cross-AI review for ${milestoneId}: "${milestoneName}"...`, "info");

  pi.sendMessage(
    { customType: "gsd-review", content: prompt, display: false },
    { triggerTurn: true },
  );
}
