/**
 * Phase handoff anchors — compact structured summaries written between
 * GSD auto-mode phases so downstream agents inherit decisions, blockers,
 * and intent without re-inferring from scratch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";

export interface PhaseAnchor {
  phase: string;
  milestoneId: string;
  sliceId?: string;
  generatedAt: string;
  intent: string;
  decisions: string[];
  blockers: string[];
  nextSteps: string[];
}

function anchorsDir(basePath: string, milestoneId: string): string {
  return join(gsdRoot(basePath), "milestones", milestoneId, "anchors");
}

function anchorFileName(phase: string, sliceId?: string): string {
  // Slice-level phases include the sliceId to prevent collisions across slices
  if (sliceId && (phase === "research-slice" || phase === "plan-slice")) {
    return `${phase}_${sliceId}.json`;
  }
  return `${phase}.json`;
}

function anchorPath(basePath: string, milestoneId: string, phase: string, sliceId?: string): string {
  return join(anchorsDir(basePath, milestoneId), anchorFileName(phase, sliceId));
}

export function writePhaseAnchor(basePath: string, milestoneId: string, anchor: PhaseAnchor): void {
  const dir = anchorsDir(basePath, milestoneId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(anchorPath(basePath, milestoneId, anchor.phase, anchor.sliceId), JSON.stringify(anchor, null, 2), "utf-8");
}

export function readPhaseAnchor(basePath: string, milestoneId: string, phase: string, sliceId?: string): PhaseAnchor | null {
  const path = anchorPath(basePath, milestoneId, phase, sliceId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PhaseAnchor;
  } catch {
    return null;
  }
}

export interface HandoffData {
  intent: string;
  decisions: string[];
  blockers: string[];
  nextSteps: string[];
}

/**
 * Extract structured handoff data from phase artifacts.
 * Reads the artifact file produced by the just-completed phase and parses
 * markdown headings to populate decisions, blockers, and next steps.
 */
export function extractHandoffData(
  basePath: string,
  milestoneId: string,
  unitType: string,
  unitId: string,
  sliceId?: string,
): HandoffData {
  const result: HandoffData = {
    intent: `Completed ${unitType} for ${unitId}`,
    decisions: [],
    blockers: [],
    nextSteps: [],
  };

  try {
    // Determine which artifact file to read based on phase type
    let artifactPath: string | null = null;
    if (unitType === "research-milestone") {
      // Try milestone RESEARCH file
      const dir = join(gsdRoot(basePath), "milestones", milestoneId);
      const candidates = [`${milestoneId}-RESEARCH.md`, "RESEARCH.md"];
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { artifactPath = p; break; }
      }
    } else if (unitType === "research-slice" && sliceId) {
      const dir = join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
      const candidates = [`${sliceId}-RESEARCH.md`, "RESEARCH.md"];
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { artifactPath = p; break; }
      }
    } else if (unitType === "plan-milestone") {
      const dir = join(gsdRoot(basePath), "milestones", milestoneId);
      const candidates = [`${milestoneId}-ROADMAP.md`, "ROADMAP.md"];
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { artifactPath = p; break; }
      }
    } else if (unitType === "plan-slice" && sliceId) {
      const dir = join(gsdRoot(basePath), "milestones", milestoneId, "slices", sliceId);
      const candidates = [`${sliceId}-PLAN.md`, "PLAN.md"];
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { artifactPath = p; break; }
      }
    }

    if (!artifactPath) return result;

    const content = readFileSync(artifactPath, "utf-8");

    // Extract the first heading or first non-empty line as intent
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      result.intent = headingMatch[1].trim();
    }

    // Parse markdown sections for decisions, blockers, and next steps
    const sections = parseSections(content);
    result.decisions = sections.decisions;
    result.blockers = sections.blockers;
    result.nextSteps = sections.nextSteps;
  } catch {
    // Non-fatal — return defaults
  }

  return result;
}

/** Parse markdown content for sections containing decisions, blockers, and next steps. */
function parseSections(content: string): { decisions: string[]; blockers: string[]; nextSteps: string[] } {
  const decisions: string[] = [];
  const blockers: string[] = [];
  const nextSteps: string[] = [];

  const lines = content.split("\n");
  let currentSection: "decisions" | "blockers" | "nextSteps" | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Detect section headings
    if (/^#{1,4}\s/.test(line)) {
      if (lower.includes("decision")) currentSection = "decisions";
      else if (lower.includes("blocker") || lower.includes("risk") || lower.includes("issue")) currentSection = "blockers";
      else if (lower.includes("next step") || lower.includes("next action") || lower.includes("todo")) currentSection = "nextSteps";
      else currentSection = null;
      continue;
    }
    // Collect bullet items under recognized sections
    if (currentSection) {
      const bullet = line.match(/^\s*[-*]\s+(.+)/);
      if (bullet) {
        const target = currentSection === "decisions" ? decisions : currentSection === "blockers" ? blockers : nextSteps;
        target.push(bullet[1].trim());
      }
    }
  }

  return { decisions, blockers, nextSteps };
}

export function formatAnchorForPrompt(anchor: PhaseAnchor): string {
  const lines: string[] = [
    `## Handoff from ${anchor.phase}`,
    "",
    `**Intent:** ${anchor.intent}`,
  ];

  if (anchor.decisions.length > 0) {
    lines.push("", "**Decisions:**");
    for (const d of anchor.decisions) lines.push(`- ${d}`);
  }

  if (anchor.blockers.length > 0) {
    lines.push("", "**Blockers:**");
    for (const b of anchor.blockers) lines.push(`- ${b}`);
  }

  if (anchor.nextSteps.length > 0) {
    lines.push("", "**Next steps:**");
    for (const s of anchor.nextSteps) lines.push(`- ${s}`);
  }

  lines.push("", "---");
  return lines.join("\n");
}
