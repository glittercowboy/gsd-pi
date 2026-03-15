// GSD Extension — Session/Milestone Export
// Generate shareable reports of milestone work in JSON or markdown format.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  getLedger, getProjectTotals, aggregateByPhase, aggregateBySlice,
  aggregateByModel, formatCost, formatTokenCount,
} from "./metrics.js";
import type { UnitMetrics } from "./metrics.js";
import { gsdRoot } from "./paths.js";
import { formatDuration } from "./history.js";

/**
 * Export session/milestone data to JSON or markdown.
 */
export async function handleExport(args: string, ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const format = args.includes("--json") ? "json" : "markdown";

  const ledger = getLedger();
  let units: UnitMetrics[];

  if (ledger && ledger.units.length > 0) {
    units = ledger.units;
  } else {
    const { loadLedgerFromDisk } = await import("./metrics.js");
    const diskLedger = loadLedgerFromDisk(basePath);
    if (!diskLedger || diskLedger.units.length === 0) {
      ctx.ui.notify("Nothing to export — no units executed yet.", "info");
      return;
    }
    units = diskLedger.units;
  }

  const projectName = basename(basePath);
  const exportDir = gsdRoot(basePath);
  mkdirSync(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (format === "json") {
    const report = {
      exportedAt: new Date().toISOString(),
      project: projectName,
      totals: getProjectTotals(units),
      byPhase: aggregateByPhase(units),
      bySlice: aggregateBySlice(units),
      byModel: aggregateByModel(units),
      units,
    };
    const outPath = join(exportDir, `export-${timestamp}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    ctx.ui.notify(`Exported to ${outPath}`, "success");
  } else {
    const totals = getProjectTotals(units);
    const phases = aggregateByPhase(units);
    const slices = aggregateBySlice(units);

    const md = [
      `# GSD Session Report — ${projectName}`,
      ``,
      `**Generated**: ${new Date().toISOString()}`,
      `**Units completed**: ${totals.units}`,
      `**Total cost**: ${formatCost(totals.cost)}`,
      `**Total tokens**: ${formatTokenCount(totals.tokens.total)}`,
      `**Total duration**: ${formatDuration(totals.duration)}`,
      `**Tool calls**: ${totals.toolCalls}`,
      ``,
      `## Cost by Phase`,
      ``,
      `| Phase | Units | Cost | Tokens | Duration |`,
      `|-------|-------|------|--------|----------|`,
      ...phases.map(p =>
        `| ${p.phase} | ${p.units} | ${formatCost(p.cost)} | ${formatTokenCount(p.tokens.total)} | ${formatDuration(p.duration)} |`,
      ),
      ``,
      `## Cost by Slice`,
      ``,
      `| Slice | Units | Cost | Tokens | Duration |`,
      `|-------|-------|------|--------|----------|`,
      ...slices.map(s =>
        `| ${s.sliceId} | ${s.units} | ${formatCost(s.cost)} | ${formatTokenCount(s.tokens.total)} | ${formatDuration(s.duration)} |`,
      ),
      ``,
      `## Unit History`,
      ``,
      `| Type | ID | Model | Cost | Tokens | Duration |`,
      `|------|-----|-------|------|--------|----------|`,
      ...units.map(u =>
        `| ${u.type} | ${u.id} | ${u.model.replace(/^claude-/, "")} | ${formatCost(u.cost)} | ${formatTokenCount(u.tokens.total)} | ${formatDuration(u.finishedAt - u.startedAt)} |`,
      ),
      ``,
    ].join("\n");

    const outPath = join(exportDir, `export-${timestamp}.md`);
    writeFileSync(outPath, md, "utf-8");
    ctx.ui.notify(`Exported to ${outPath}`, "success");
  }
}
