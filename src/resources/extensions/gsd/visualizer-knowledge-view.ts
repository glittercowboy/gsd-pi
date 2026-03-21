// GSD Visualizer - Knowledge view renderer

import type { Theme } from "@gsd/pi-coding-agent";
import { truncateToWidth } from "@gsd/pi-tui";
import type { VisualizerData } from "./visualizer-data.js";

export function renderKnowledgeView(
  data: VisualizerData,
  th: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const knowledge = data.knowledge;

  if (!knowledge.exists) {
    lines.push(th.fg("dim", "No KNOWLEDGE.md found"));
    return lines;
  }

  if (knowledge.rules.length === 0 && knowledge.patterns.length === 0 && knowledge.lessons.length === 0) {
    lines.push(th.fg("dim", "KNOWLEDGE.md exists but is empty"));
    return lines;
  }

  // Rules section
  if (knowledge.rules.length > 0) {
    lines.push(th.fg("accent", th.bold("Rules")));
    lines.push("");
    for (const rule of knowledge.rules) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", rule.id)}  ${th.fg("dim", `[${rule.scope}]`)}  ${rule.content}`,
        width,
      ));
    }
    lines.push("");
  }

  // Patterns section
  if (knowledge.patterns.length > 0) {
    lines.push(th.fg("accent", th.bold("Patterns")));
    lines.push("");
    for (const pattern of knowledge.patterns) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", pattern.id)}  ${pattern.content}`,
        width,
      ));
    }
    lines.push("");
  }

  // Lessons section
  if (knowledge.lessons.length > 0) {
    lines.push(th.fg("accent", th.bold("Lessons Learned")));
    lines.push("");
    for (const lesson of knowledge.lessons) {
      lines.push(truncateToWidth(
        `  ${th.fg("accent", lesson.id)}  ${lesson.content}`,
        width,
      ));
    }
    lines.push("");
  }

  return lines;
}
