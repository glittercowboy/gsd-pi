// GSD Visualizer - Export view renderer

import type { Theme } from "@gsd/pi-coding-agent";
import type { VisualizerData } from "./visualizer-data.js";

export function renderExportView(
  _data: VisualizerData,
  th: Theme,
  _width: number,
  lastExportPath?: string,
): string[] {
  const lines: string[] = [];

  lines.push(th.fg("accent", th.bold("Export Options")));
  lines.push("");
  lines.push(`  ${th.fg("accent", "[m]")}  Markdown report \u2014 full project summary with tables`);
  lines.push(`  ${th.fg("accent", "[j]")}  JSON report \u2014 machine-readable project data`);
  lines.push(`  ${th.fg("accent", "[s]")}  Snapshot \u2014 current view as plain text`);

  if (lastExportPath) {
    lines.push("");
    lines.push(th.fg("dim", `Last export: ${lastExportPath}`));
  }

  return lines;
}
