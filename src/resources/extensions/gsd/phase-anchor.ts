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
  const dir = anchorsDir(basePath, milestoneId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(anchorPath(basePath, milestoneId, anchor.phase), JSON.stringify(anchor, null, 2), "utf-8");
}

export function readPhaseAnchor(basePath: string, milestoneId: string, phase: string): PhaseAnchor | null {
  const path = anchorPath(basePath, milestoneId, phase);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PhaseAnchor;
  } catch {
    return null;
  }
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
