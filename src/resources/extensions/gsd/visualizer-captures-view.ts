// GSD Visualizer - Captures view renderer

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth } from "@gsd/pi-tui";
import type { VisualizerData } from "./visualizer-data.js";

export function renderCapturesView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const captures = data.captures;

  // Summary line
  const resolved = captures.entries.filter(e => e.status === "resolved").length;
  lines.push(
    `${th.fg("text", String(captures.totalCount))} total \u00b7 ` +
    `${th.fg("warning", String(captures.pendingCount))} pending \u00b7 ` +
    `${th.fg("dim", String(resolved))} resolved`,
  );
  lines.push("");

  if (captures.entries.length === 0) {
    lines.push(th.fg("dim", "No captures recorded."));
    return lines;
  }

  // Group by status: pending first, then triaged, then resolved
  const statusOrder: Record<string, number> = { pending: 0, triaged: 1, resolved: 2 };
  const sorted = [...captures.entries].sort((a, b) =>
    (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3),
  );

  for (const entry of sorted) {
    const statusColor =
      entry.status === "pending" ? "warning" :
      entry.status === "triaged" ? "accent" :
      "dim";

    const classColor =
      entry.classification === "inject" ? "warning" :
      entry.classification === "quick-task" ? "accent" :
      entry.classification === "replan" ? "error" :
      entry.classification === "defer" ? "text" :
      "dim";

    const classBadge = entry.classification
      ? th.fg(classColor, `(${entry.classification})`)
      : "";

    const statusBadge = th.fg(statusColor, `[${entry.status}]`);
    const textPreview = truncateToWidth(entry.text, Math.max(20, width - 50));

    lines.push(`  ${th.fg("accent", entry.id)} ${statusBadge} ${textPreview} ${classBadge}`);
    if (entry.timestamp) {
      lines.push(`    ${th.fg("dim", entry.timestamp)}`);
    }
  }

  return lines;
}
