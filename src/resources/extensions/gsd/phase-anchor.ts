/**
 * Phase handoff anchors — compact structured summaries written between
 * GSD auto-mode phases so downstream agents inherit decisions, blockers,
 * and intent without re-inferring from scratch.
 */

import { join } from "node:path";
import { gsdRoot } from "./paths.js";
import { loadJsonFileOrNull, saveJsonFile } from "./json-persistence.js";

export interface PhaseAnchor {
  phase: string;
  milestoneId: string;
  generatedAt: string;
  intent: string;
  decisions: string[];
  blockers: string[];
  nextSteps: string[];
}

function anchorsDir(basePath: string, milestoneId: string): string {
  return join(gsdRoot(basePath), "milestones", milestoneId, "anchors");
}

function anchorPath(basePath: string, milestoneId: string, phase: string): string {
  return join(anchorsDir(basePath, milestoneId), `${phase}.json`);
}

export function writePhaseAnchor(basePath: string, milestoneId: string, anchor: PhaseAnchor): void {
  saveJsonFile(anchorPath(basePath, milestoneId, anchor.phase), anchor);
}

const isPhaseAnchor = (d: unknown): d is PhaseAnchor =>
  d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).phase === "string";

export function readPhaseAnchor(basePath: string, milestoneId: string, phase: string): PhaseAnchor | null {
  return loadJsonFileOrNull(anchorPath(basePath, milestoneId, phase), isPhaseAnchor);
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
