/**
 * Pure GSD health widget logic.
 *
 * Separates project-state detection and line rendering from the widget's
 * runtime integrations so the regressions can be tested directly.
 */

import { existsSync } from "node:fs";
import { detectProjectState } from "./detection.js";
import { gsdRoot } from "./paths.js";

export type HealthWidgetProjectState = "none" | "initialized" | "active";

export interface HealthWidgetData {
  projectState: HealthWidgetProjectState;
  budgetCeiling: number | undefined;
  budgetSpent: number;
  providerIssue: string | null;
  environmentErrorCount: number;
  environmentWarningCount: number;
  /** Unix epoch (seconds) of the last commit, or null if unavailable. */
  lastCommitEpoch: number | null;
  /** Subject line of the last commit, or null if unavailable. */
  lastCommitMessage: string | null;
  lastRefreshed: number;
}

export function detectHealthWidgetProjectState(basePath: string): HealthWidgetProjectState {
  if (!existsSync(gsdRoot(basePath))) return "none";

  const { state } = detectProjectState(basePath);
  return state === "v2-gsd" ? "active" : "initialized";
}

function formatCost(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `${(n * 100).toFixed(1)}¢`;
}

/**
 * Format a Unix epoch (seconds) as a human-readable relative time string.
 * Returns "just now" for <1m, "Xm ago" for <1h, "Xh ago" for <24h, "Xd ago" otherwise.
 */
export function formatRelativeTime(epochSeconds: number): string {
  const diffSeconds = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diffSeconds < 60) return "just now";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Truncate a commit message to fit the widget, appending "…" if needed.
 */
function truncateMessage(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen - 1) + "…";
}

/**
 * Build compact health lines for the widget.
 * When `width` is provided, system + budget render left and last-commit
 * right-aligned. Without width, all parts are joined inline (RPC fallback).
 */
export function buildHealthLines(data: HealthWidgetData, width?: number): string[] {
  if (data.projectState === "none") {
    return ["  GSD  No project loaded — run /gsd to start"];
  }

  if (data.projectState === "initialized") {
    return ["  GSD  Project initialized — run /gsd to continue setup"];
  }

  const leftParts: string[] = [];

  const totalIssues = data.environmentErrorCount + data.environmentWarningCount + (data.providerIssue ? 1 : 0);
  if (totalIssues === 0) {
    leftParts.push("● System OK");
  } else if (data.environmentErrorCount > 0 || data.providerIssue?.includes("✗")) {
    leftParts.push(`✗ ${totalIssues} issue${totalIssues > 1 ? "s" : ""}`);
  } else {
    leftParts.push(`⚠ ${totalIssues} warning${totalIssues > 1 ? "s" : ""}`);
  }

  if (data.budgetCeiling !== undefined && data.budgetCeiling > 0) {
    const pct = Math.min(100, (data.budgetSpent / data.budgetCeiling) * 100);
    leftParts.push(`Budget: ${formatCost(data.budgetSpent)}/${formatCost(data.budgetCeiling)} (${pct.toFixed(0)}%)`);
  } else if (data.budgetSpent > 0) {
    leftParts.push(`Spent: ${formatCost(data.budgetSpent)}`);
  }

  if (data.providerIssue) {
    leftParts.push(data.providerIssue);
  }

  if (data.environmentErrorCount > 0) {
    leftParts.push(`Env: ${data.environmentErrorCount} error${data.environmentErrorCount > 1 ? "s" : ""}`);
  } else if (data.environmentWarningCount > 0) {
    leftParts.push(`Env: ${data.environmentWarningCount} warning${data.environmentWarningCount > 1 ? "s" : ""}`);
  }

  // Last commit goes on the right-hand side when width is known.
  let rightText = "";
  if (data.lastCommitEpoch !== null && data.lastCommitEpoch > 0) {
    const relTime = formatRelativeTime(data.lastCommitEpoch);
    const msg = data.lastCommitMessage ? ` — ${truncateMessage(data.lastCommitMessage, 50)}` : "";
    rightText = `Last commit: ${relTime}${msg}`;
  }

  const leftText = leftParts.join("  │  ");

  if (width === undefined) {
    const inline = rightText ? `${leftText}  │  ${rightText}` : leftText;
    return [`  ${inline}`];
  }

  const prefix = "  ";
  const innerWidth = Math.max(0, width - prefix.length);
  const leftVis = leftText.length;
  const rightVis = rightText.length;

  if (!rightText) return [`${prefix}${truncateMessage(leftText, innerWidth)}`];
  const MIN_GAP = 2;
  if (leftVis + MIN_GAP + rightVis > innerWidth) {
    // Preserve the left (status + budget) and truncate the right side
    // (last commit) with an ellipsis so the combined line never exceeds
    // innerWidth. If even the left alone overflows, clamp it too.
    const leftRoom = Math.max(1, Math.min(leftVis, innerWidth - MIN_GAP - 1));
    const clampedLeft = truncateMessage(leftText, leftRoom);
    const rightRoom = Math.max(0, innerWidth - clampedLeft.length - MIN_GAP);
    const clampedRight = rightRoom > 0 ? truncateMessage(rightText, rightRoom) : "";
    if (!clampedRight) return [`${prefix}${clampedLeft}`];
    const pad = " ".repeat(Math.max(MIN_GAP, innerWidth - clampedLeft.length - clampedRight.length));
    return [`${prefix}${clampedLeft}${pad}${clampedRight}`];
  }
  const padding = " ".repeat(innerWidth - leftVis - rightVis);
  return [`${prefix}${leftText}${padding}${rightText}`];
}
