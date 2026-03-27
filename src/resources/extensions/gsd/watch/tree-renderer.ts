// GSD Watch — Tree renderer: layout engine, badge formatting, ANSI-safe line construction
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { visibleWidth, truncateToWidth } from "@gsd/pi-tui";
import type { MilestoneNode, PhaseNode, PlanNode, NodeStatus } from "./types.js";

// ─── VisibleNode Types ────────────────────────────────────────────────────────

/** Identifies the type of tree node that a rendered line represents. */
export type VisibleNodeKind = "milestone" | "phase" | "plan";

/**
 * Metadata for a single rendered line — maps line index to tree node identity.
 * Used by cursor navigation to identify collapsible phases and track cursor
 * position across file-change refreshes.
 */
export interface VisibleNode {
  kind: VisibleNodeKind;
  dirName?: string;   // defined when kind === "phase"
  planId?: string;    // defined when kind === "plan"
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<NodeStatus, string> = {
  done:    "✓",
  active:  "◆",
  pending: "○",
  blocked: "✘",
};

const BADGE_FILLED = "●";
const BADGE_EMPTY  = "○";

/** Minimum pane width to show plan-level detail. Below this, only phases shown. Per D-13. */
const MIN_WIDTH_FOR_PLANS = 30;

/** Minimum name characters to show when fitting badges. Below this, drop badges. */
const MIN_NAME_WITH_BADGES = 4;

/** Collapsed indicator appended to collapsed phase lines. Per D-08. */
const COLLAPSED_INDICATOR = " ▸";

// ─── Badge Formatting ─────────────────────────────────────────────────────────

/**
 * Format badge boolean array as a string of filled/empty circles.
 * Always returns " " + 7 badge characters (8 visible chars total).
 */
function formatBadgeString(badges: boolean[]): string {
  return " " + badges.map((b) => (b ? BADGE_FILLED : BADGE_EMPTY)).join("");
}

// ─── Milestone Line ───────────────────────────────────────────────────────────

/**
 * Format the root milestone header line.
 * No tree prefix — this is the root node.
 */
function formatMilestoneLine(milestone: MilestoneNode, width: number): string {
  const icon = STATUS_ICON[milestone.status];
  const iconWidth = visibleWidth(icon + " ");
  const available = width - iconWidth;
  const name = truncateToWidth(milestone.label, available, "…");
  return icon + " " + name;
}

// ─── Phase Line ───────────────────────────────────────────────────────────────

/**
 * Format a phase line with status icon, name, and lifecycle badges.
 * Per D-12: name wins over badges on truncation.
 *
 * Layout: prefix + STATUS_ICON + " " + name [+ badgeStr]
 */
function formatPhaseLine(phase: PhaseNode, prefix: string, width: number): string {
  const prefixWidth = visibleWidth(prefix);
  const icon = STATUS_ICON[phase.status];
  const statusWidth = visibleWidth(icon + " ");
  const available = width - prefixWidth - statusWidth;

  const badgeStr = formatBadgeString(phase.badges);
  const badgeWidth = visibleWidth(badgeStr);

  let namePart: string;
  let badgePart: string;

  if (available >= MIN_NAME_WITH_BADGES + badgeWidth) {
    // Enough room for name AND badges
    const nameWidth = available - badgeWidth;
    namePart = truncateToWidth(phase.label, nameWidth, "…");
    badgePart = badgeStr;
  } else {
    // Drop badges — name gets all available space
    namePart = truncateToWidth(phase.label, available, "…");
    badgePart = "";
  }

  return prefix + icon + " " + namePart + badgePart;
}

// ─── Plan Line ────────────────────────────────────────────────────────────────

/**
 * Format a plan line with status icon and label.
 * No badges on individual plans.
 */
function formatPlanLine(plan: PlanNode, prefix: string, width: number): string {
  const prefixWidth = visibleWidth(prefix);
  const icon = STATUS_ICON[plan.status];
  const statusWidth = visibleWidth(icon + " ");
  const available = width - prefixWidth - statusWidth;
  const name = truncateToWidth(plan.label, available, "…");
  return prefix + icon + " " + name;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Render the milestone tree as an array of terminal-safe strings, alongside
 * a parallel VisibleNode array identifying each line's tree node.
 *
 * Uses box-drawing characters (├──, └──, │) for the tree hierarchy.
 * Status icons: ✓ done, ◆ active, ○ pending, ✘ blocked.
 * Lifecycle badges appear on phase lines as ●/○ circles.
 * Width-aware: drops badges before truncating names (D-12).
 * Plan lines hidden below MIN_WIDTH_FOR_PLANS (D-13).
 *
 * @param milestone - The root milestone node to render.
 * @param width - Terminal column width for truncation.
 * @param collapsedPhases - Optional set of phase dirName values that are collapsed.
 *   Collapsed phases skip their plan lines and append ▸ to the phase line (D-08).
 *   Defaults to empty Set (all phases expanded) for backward compatibility.
 * @returns Object with parallel `lines` (string[]) and `nodes` (VisibleNode[]) arrays.
 */
export function renderTreeLines(
  milestone: MilestoneNode,
  width: number,
  collapsedPhases: Set<string> = new Set()
): { lines: string[]; nodes: VisibleNode[] } {
  const lines: string[] = [];
  const nodes: VisibleNode[] = [];

  // Milestone header (root node — no tree prefix)
  lines.push(formatMilestoneLine(milestone, width));
  nodes.push({ kind: "milestone" });

  const phases = milestone.phases;
  for (let pi = 0; pi < phases.length; pi++) {
    const phase = phases[pi];
    const isLastPhase = pi === phases.length - 1;
    const isCollapsed = collapsedPhases.has(phase.dirName);

    // Phase prefix: ├── for non-last, └── for last
    const phasePrefix = isLastPhase ? "└── " : "├── ";
    let phaseLine = formatPhaseLine(phase, phasePrefix, width);

    if (isCollapsed) {
      // Append ▸ indicator to collapsed phase lines (D-08).
      // Ensure the indicator fits within width — truncate if necessary.
      const indicatorWidth = visibleWidth(COLLAPSED_INDICATOR);
      const currentWidth = visibleWidth(phaseLine);
      if (currentWidth + indicatorWidth > width) {
        // Truncate the phase line to make room for ▸
        phaseLine = truncateToWidth(phaseLine, width - indicatorWidth, "…") + COLLAPSED_INDICATOR;
      } else {
        phaseLine = phaseLine + COLLAPSED_INDICATOR;
      }
    }

    lines.push(phaseLine);
    nodes.push({ kind: "phase", dirName: phase.dirName });

    // Skip plan lines for collapsed phases (D-07, D-08)
    if (isCollapsed) {
      continue;
    }

    // Plans are only shown when width is sufficient (D-13)
    if (width >= MIN_WIDTH_FOR_PLANS) {
      const plans = phase.plans;
      for (let pj = 0; pj < plans.length; pj++) {
        const plan = plans[pj];
        const isLastPlan = pj === plans.length - 1;

        // Continuation prefix based on whether this is the last phase
        // Non-last phase: │   (keeps vertical line for next phase)
        // Last phase:     "    " (spaces — no more phases below)
        const continuation = isLastPhase ? "    " : "│   ";

        // Plan connector: ├── for non-last, └── for last
        const connector = isLastPlan ? "└── " : "├── ";
        const planPrefix = continuation + connector;

        lines.push(formatPlanLine(plan, planPrefix, width));
        nodes.push({ kind: "plan", planId: plan.id });
      }
    }
  }

  return { lines, nodes };
}
