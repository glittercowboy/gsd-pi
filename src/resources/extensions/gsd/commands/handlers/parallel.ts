import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  getOrchestratorState,
  getWorkerStatuses,
  isParallelActive,
  pauseWorker,
  prepareParallelStart,
  refreshWorkerStatuses,
  resumeWorker,
  startParallel,
  stopParallel,
} from "../../parallel-orchestrator.js";
import { formatEligibilityReport } from "../../parallel-eligibility.js";
import { formatMergeResults, mergeAllCompleted, mergeCompletedMilestone } from "../../parallel-merge.js";
import { loadEffectiveGSDPreferences, resolveParallelConfig } from "../../preferences.js";
import { projectRoot } from "../context.js";
function emitParallelMessage(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "gsd-parallel", content, display: true });
}

export async function handleParallelCommand(trimmed: string, _ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  if (!trimmed.startsWith("parallel")) return false;

  const parallelArgs = trimmed.slice("parallel".length).trim();
  const [subcommand = "", ...restParts] = parallelArgs.split(/\s+/);
  const rest = restParts.join(" ");

  if (subcommand === "start" || subcommand === "") {
    const root = projectRoot();
    const loaded = loadEffectiveGSDPreferences();
    const config = resolveParallelConfig(loaded?.preferences);
    if (!config.enabled) {
      emitParallelMessage(pi, "Parallel mode is not enabled. Set `parallel.enabled: true` in your preferences.");
      return true;
    }
    const candidates = await prepareParallelStart(root, loaded?.preferences);
    const report = formatEligibilityReport(candidates);
    if (candidates.eligible.length === 0) {
      emitParallelMessage(pi, `${report}\n\nNo milestones are eligible for parallel execution.`);
      return true;
    }
    const result = await startParallel(
      root,
      candidates.eligible.map((candidate) => candidate.milestoneId),
      loaded?.preferences,
    );
    const lines = ["Parallel orchestration started.", `Workers: ${result.started.join(", ")}`];
    if (result.errors.length > 0) {
      lines.push(`Errors: ${result.errors.map((entry) => `${entry.mid}: ${entry.error}`).join("; ")}`);
    }
    emitParallelMessage(pi, `${report}\n\n${lines.join("\n")}`);
    return true;
  }

  if (subcommand === "status") {
    const root = projectRoot();
    refreshWorkerStatuses(root, { restoreIfNeeded: true });
    const workers = getWorkerStatuses(root);
    if (workers.length === 0 || !isParallelActive()) {
      emitParallelMessage(pi, "No parallel orchestration is currently active.");
      return true;
    }
    const lines = ["# Parallel Workers\n"];
    for (const worker of workers) {
      lines.push(`- **${worker.milestoneId}** (${worker.title}) — ${worker.state} — $${worker.cost.toFixed(2)}`);
    }
    const state = getOrchestratorState();
    if (state) {
      lines.push(`\nTotal cost: $${state.totalCost.toFixed(2)}`);
    }
    emitParallelMessage(pi, lines.join("\n"));
    return true;
  }

  if (subcommand === "stop") {
    const milestoneId = rest.trim() || undefined;
    await stopParallel(projectRoot(), milestoneId);
    emitParallelMessage(pi, milestoneId ? `Stopped worker for ${milestoneId}.` : "All parallel workers stopped.");
    return true;
  }

  if (subcommand === "pause") {
    const milestoneId = rest.trim() || undefined;
    pauseWorker(projectRoot(), milestoneId);
    emitParallelMessage(pi, milestoneId ? `Paused worker for ${milestoneId}.` : "All parallel workers paused.");
    return true;
  }

  if (subcommand === "resume") {
    const milestoneId = rest.trim() || undefined;
    resumeWorker(projectRoot(), milestoneId);
    emitParallelMessage(pi, milestoneId ? `Resumed worker for ${milestoneId}.` : "All parallel workers resumed.");
    return true;
  }

  if (subcommand === "merge") {
    const milestoneId = rest.trim() || undefined;
    if (milestoneId) {
      const result = await mergeCompletedMilestone(projectRoot(), milestoneId);
      emitParallelMessage(pi, formatMergeResults([result]));
      return true;
    }
    const workers = getWorkerStatuses(projectRoot());
    if (workers.length === 0) {
      emitParallelMessage(pi, "No parallel workers to merge.");
      return true;
    }
    const results = await mergeAllCompleted(projectRoot(), workers);
    emitParallelMessage(pi, formatMergeResults(results));
    return true;
  }

  if (subcommand === "watch") {
    const root = projectRoot();
    const { ParallelMonitorOverlay } = await import("../../parallel-monitor-overlay.js");
    await _ctx.ui.custom<void>(
      (tui, theme, _kb, done) => new ParallelMonitorOverlay(tui, theme, () => done(), root),
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 80,
          maxHeight: "92%",
          anchor: "center",
        },
      },
    );
    return true;
  }

  emitParallelMessage(pi, `Unknown parallel subcommand "${subcommand}". Usage: /gsd parallel [start|status|stop|pause|resume|merge|watch]`);
  return true;
}

