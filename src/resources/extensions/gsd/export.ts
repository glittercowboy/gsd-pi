// GSD Extension — Session/Milestone Export
// Generate shareable reports of milestone work in JSON or markdown format.

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { exec, execFile } from "node:child_process";
import {
  getLedger, getProjectTotals, aggregateByPhase, aggregateBySlice,
  aggregateByModel, formatCost, formatTokenCount, loadLedgerFromDisk,
} from "./metrics.js";
import type { UnitMetrics } from "./metrics.js";
import { gsdRoot } from "./paths.js";
import { formatDuration, fileLink } from "../shared/format-utils.js";
import { getErrorMessage } from "./error-utils.js";

/**
 * Open a file in the user's default browser.
 * Uses platform-specific commands: `open` (macOS), `xdg-open` (Linux), `start` (Windows).
 * Non-blocking, non-fatal — failures are silently ignored.
 */
export function openInBrowser(filePath: string): void {
  if (process.platform === "win32") {
    // PowerShell's Start-Process handles paths with '&' and spaces safely.
    execFile("powershell", ["-c", `Start-Process '${filePath.replace(/'/g, "''")}'`], () => {});
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [filePath], () => {});
  }
}

/**
 * Write an export file directly, without requiring an ExtensionCommandContext.
 * Used by the visualizer overlay export tab.
 * Returns the output file path, or null on failure.
 */
export function writeExportFile(
  basePath: string,
  format: "markdown" | "json",
  visualizerData?: { totals: any; byPhase: any[]; bySlice: any[]; byModel: any[]; units: any[]; criticalPath?: any; remainingSliceCount?: number },
): string | null {
  const ledger = getLedger();
  let units: UnitMetrics[];

  if (visualizerData && visualizerData.units.length > 0) {
    units = visualizerData.units;
  } else if (ledger && ledger.units.length > 0) {
    units = ledger.units;
  } else {
    const diskLedger = loadLedgerFromDisk(basePath);
    if (!diskLedger || diskLedger.units.length === 0) return null;
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
      totals: visualizerData?.totals ?? getProjectTotals(units),
      byPhase: visualizerData?.byPhase ?? aggregateByPhase(units),
      bySlice: visualizerData?.bySlice ?? aggregateBySlice(units),
      byModel: visualizerData?.byModel ?? aggregateByModel(units),
      units,
    };
    const outPath = join(exportDir, `export-${timestamp}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
    return outPath;
  } else {
    const totals = visualizerData?.totals ?? getProjectTotals(units);
    const phases = visualizerData?.byPhase ?? aggregateByPhase(units);
    const slices = visualizerData?.bySlice ?? aggregateBySlice(units);

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
      ...phases.map((p: any) =>
        `| ${p.phase} | ${p.units} | ${formatCost(p.cost)} | ${formatTokenCount(p.tokens.total)} | ${formatDuration(p.duration)} |`,
      ),
      ``,
      `## Cost by Slice`,
      ``,
      `| Slice | Units | Cost | Tokens | Duration |`,
      `|-------|-------|------|--------|----------|`,
      ...slices.map((s: any) =>
        `| ${s.sliceId} | ${s.units} | ${formatCost(s.cost)} | ${formatTokenCount(s.tokens.total)} | ${formatDuration(s.duration)} |`,
      ),
      ``,
    ].join("\n");

    const outPath = join(exportDir, `export-${timestamp}.md`);
    writeFileSync(outPath, md, "utf-8");
    return outPath;
  }
}

/**
 * Export session/milestone data to JSON, markdown, or HTML.
 */
export async function handleExport(args: string, ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  // HTML report — delegates to the full visualizer-data pipeline
  if (args.includes("--html")) {
    const generateAll = args.includes("--all");
    try {
      const { loadVisualizerData } = await import("./visualizer-data.js");
      const { generateHtmlReport } = await import("./export-html.js");
      const { writeReportSnapshot, loadReportsIndex } = await import("./reports.js");
      const { basename: bn } = await import("node:path");
      const data = await loadVisualizerData(basePath);
      const projName = basename(basePath);
      const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
      const doneMilestones = data.milestones.filter(m => m.status === "complete").length;

      const htmlOpts = {
        projectName: projName,
        projectPath: basePath,
        gsdVersion,
        indexRelPath: "index.html",
      };

      if (generateAll) {
        // Generate a report snapshot for every milestone
        const existing = loadReportsIndex(basePath);
        const existingIds = new Set(existing?.entries.map(e => e.milestoneId) ?? []);

        const targets = data.milestones.filter(m => !existingIds.has(m.id));
        if (targets.length === 0) {
          ctx.ui.notify(
            "All milestones already have report snapshots. Run without --all to create a new snapshot for the active milestone.",
            "info",
          );
          return;
        }

        const html = generateHtmlReport(data, htmlOpts);
        const paths: string[] = [];

        for (const ms of targets) {
          const msSlicesDone = ms.slices.filter(sl => sl.done).length;
          const msSlicesTotal = ms.slices.length;

          // Accumulate project-wide progress up to and including this milestone
          const msIdx = data.milestones.indexOf(ms);
          let cumulativeDone = 0;
          let cumulativeTotal = 0;
          for (let i = 0; i <= msIdx; i++) {
            cumulativeDone += data.milestones[i].slices.filter(sl => sl.done).length;
            cumulativeTotal += data.milestones[i].slices.length;
          }

          const outPath = writeReportSnapshot({
            basePath,
            html,
            milestoneId: ms.id,
            milestoneTitle: ms.title,
            kind: ms.status === "complete" ? "milestone" : "manual",
            projectName: projName,
            projectPath: basePath,
            gsdVersion,
            totalCost: data.totals?.cost ?? 0,
            totalTokens: data.totals?.tokens.total ?? 0,
            totalDuration: data.totals?.duration ?? 0,
            doneSlices: cumulativeDone,
            totalSlices: cumulativeTotal,
            doneMilestones: data.milestones.slice(0, msIdx + 1).filter(m => m.status === "complete").length,
            totalMilestones: data.milestones.length,
            phase: ms.status === "complete" ? "complete" : data.phase,
          });
          paths.push(bn(outPath));
        }

        const indexPath = join(gsdRoot(basePath), "reports", "index.html");
        ctx.ui.notify(
          `Generated ${paths.length} report snapshot${paths.length !== 1 ? "s" : ""}:\n${paths.map(p => `  ${p}`).join("\n")}\nOpening reports index in browser...`,
          "success",
        );
        openInBrowser(indexPath);
      } else {
        // Single report for the active milestone (existing behavior)
        const doneSlices = data.milestones.reduce((s, m) => s + m.slices.filter(sl => sl.done).length, 0);
        const totalSlices = data.milestones.reduce((s, m) => s + m.slices.length, 0);
        const outPath = writeReportSnapshot({
          basePath,
          html: generateHtmlReport(data, htmlOpts),
          milestoneId: data.milestones.find(m => m.status === "active")?.id ?? "manual",
          milestoneTitle: data.milestones.find(m => m.status === "active")?.title ?? "",
          kind: "manual",
          projectName: projName,
          projectPath: basePath,
          gsdVersion,
          totalCost: data.totals?.cost ?? 0,
          totalTokens: data.totals?.tokens.total ?? 0,
          totalDuration: data.totals?.duration ?? 0,
          doneSlices,
          totalSlices,
          doneMilestones,
          totalMilestones: data.milestones.length,
          phase: data.phase,
        });
        ctx.ui.notify(
          `HTML report saved: .gsd/reports/${bn(outPath)}\nOpening in browser...`,
          "success",
        );
        openInBrowser(outPath);
      }
    } catch (err) {
      ctx.ui.notify(
        `HTML export failed: ${getErrorMessage(err)}`,
        "error",
      );
    }
    return;
  }

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
    ctx.ui.notify(`Exported to ${fileLink(outPath)}`, "success");
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
    ctx.ui.notify(`Exported to ${fileLink(outPath)}`, "success");
  }
}
