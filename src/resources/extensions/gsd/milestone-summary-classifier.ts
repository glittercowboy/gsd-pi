/**
 * Shared milestone SUMMARY classifier.
 *
 * SUMMARY presence alone is not enough to prove milestone completion: recovery
 * and blocker paths also write SUMMARY files. Keep this leaf module free of
 * state/auto imports so state derivation, dispatch guards, and recovery can
 * share one definition without cycles.
 */

import { splitFrontmatter, parseFrontmatterMap } from "../shared/frontmatter.js";
import { isClosedStatus } from "./status-guards.js";

export type MilestoneSummaryOutcome = "success" | "failure" | "unknown";

export function classifyMilestoneSummaryContent(content: string): MilestoneSummaryOutcome {
  const [fmLines] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : null;
  const rawStatus = typeof fm?.status === "string" ? fm.status.trim().toLowerCase() : "";
  if (rawStatus) {
    if (isClosedStatus(rawStatus)) return "success";
    if (["active", "pending", "blocked", "failed", "failure", "incomplete"].includes(rawStatus)) {
      return "failure";
    }
  }

  const failureSignal =
    /(?:^|\n)\s*#\s*BLOCKER\b/i.test(content)
    || /auto-mode recovery failed/i.test(content)
    || /verification\s+failed/i.test(content)
    || /(?:^|\n)\s*(?:status|verdict|outcome|result)\s*[:=-]\s*not complete\b/i.test(content);
  if (failureSignal) return "failure";
  return "unknown";
}

/**
 * Legacy-compatible terminal check for state derivation.
 * Unknown summaries remain terminal to preserve old handwritten SUMMARY files;
 * explicit failure summaries do not.
 */
export function isTerminalMilestoneSummaryContent(content: string): boolean {
  return classifyMilestoneSummaryContent(content) !== "failure";
}
