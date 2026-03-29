/**
 * GSD Rethink — Conversational project reorganization.
 *
 * Collects a snapshot of all milestones (status, dependencies, slice progress,
 * queue order) and dispatches a prompt that turns Claude into a reorganization
 * assistant. Claude can then reorder, park, unpark, discard, or add milestones
 * through conversation.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync } from "node:fs";

import { isAutoActive } from "./auto.js";
import { deriveState } from "./state.js";
import { gsdRoot } from "./paths.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { loadQueueOrder, validateQueueOrder } from "./queue-order.js";
import { isParked, getParkedReason } from "./milestone-actions.js";
import { getMilestoneSlices, isDbAvailable } from "./gsd-db.js";
import { buildExistingMilestonesContext } from "./guided-flow-queue.js";
import { loadPrompt } from "./prompt-loader.js";
import { isGsdGitignored } from "./gitignore.js";

// ─── Entry Point ──────────────────────────────────────────────────────────────

export async function handleRethink(
  _args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (isAutoActive()) {
    ctx.ui.notify("Cannot rethink while auto-mode is active. Stop auto-mode first.", "error");
    return;
  }

  const basePath = process.cwd();
  const root = gsdRoot(basePath);
  if (!existsSync(root)) {
    ctx.ui.notify("No GSD project found. Run /gsd init first.", "warning");
    return;
  }

  ctx.ui.notify("Building project snapshot for rethink...", "info");

  const state = await deriveState(basePath);
  const milestoneIds = findMilestoneIds(basePath);

  if (milestoneIds.length === 0) {
    ctx.ui.notify("No milestones exist yet. Nothing to rethink.", "warning");
    return;
  }

  const queueOrder = loadQueueOrder(basePath);
  const rethinkData = buildRethinkData(basePath, milestoneIds, state, queueOrder);
  const existingMilestonesContext = await buildExistingMilestonesContext(basePath, milestoneIds, state);

  const commitInstruction = isGsdGitignored(basePath)
    ? "Do not commit planning artifacts — .gsd/ is gitignored in this project."
    : 'After changes, run `git add .gsd/ && git commit -m "docs(gsd): rethink milestone plan"` to persist (rethink runs interactively outside auto-mode, so no system auto-commit)';

  const content = loadPrompt("rethink", {
    rethinkData,
    existingMilestonesContext,
    commitInstruction,
  });

  pi.sendMessage(
    { customType: "gsd-rethink", content, display: false },
    { triggerTurn: true },
  );
}

// ─── Data Builder ─────────────────────────────────────────────────────────────

function buildRethinkData(
  basePath: string,
  milestoneIds: string[],
  state: Awaited<ReturnType<typeof deriveState>>,
  queueOrder: string[] | null,
): string {
  const lines: string[] = [];
  const dbAvailable = isDbAvailable();

  // ── Summary stats ───────────────────────────────────────────────────
  const counts = { complete: 0, active: 0, pending: 0, parked: 0 };
  for (const entry of state.registry) {
    if (entry.status in counts) counts[entry.status as keyof typeof counts]++;
  }

  lines.push("### Summary");
  lines.push(`${counts.complete} complete, ${counts.active} active, ${counts.pending} pending, ${counts.parked} parked — ${milestoneIds.length} total`);
  lines.push(`Queue order source: ${queueOrder ? "explicit QUEUE-ORDER.json" : "default numeric (by ID)"}`);
  if (state.activeMilestone) {
    lines.push(`Active milestone: ${state.activeMilestone}`);
  }
  lines.push("");

  // ── Milestone table ─────────────────────────────────────────────────
  lines.push("### Execution Order");
  lines.push("");
  lines.push("| # | ID | Title | Status | Dependencies | Slices |");
  lines.push("|---|-----|-------|--------|--------------|--------|");

  for (let i = 0; i < milestoneIds.length; i++) {
    const mid = milestoneIds[i];
    const entry = state.registry.find(m => m.id === mid);
    const title = entry?.title ?? mid;
    const status = entry?.status ?? "unknown";
    const deps = entry?.dependsOn?.length ? entry.dependsOn.join(", ") : "—";

    let sliceInfo = "—";
    if (dbAvailable && status !== "complete") {
      const slices = getMilestoneSlices(mid);
      if (slices.length > 0) {
        const done = slices.filter(s => s.status === "complete").length;
        sliceInfo = `${done}/${slices.length} complete`;
      }
    }

    // Add parked reason if applicable
    let statusDisplay = status;
    if (status === "parked") {
      const reason = getParkedReason(basePath, mid);
      if (reason) statusDisplay = `parked (${reason})`;
    }

    lines.push(`| ${i + 1} | ${mid} | ${title} | ${statusDisplay} | ${deps} | ${sliceInfo} |`);
  }

  // ── Dependency validation ───────────────────────────────────────────
  const pendingIds = milestoneIds.filter(mid => {
    const entry = state.registry.find(m => m.id === mid);
    return entry?.status !== "complete";
  });

  const completedIds = new Set(
    state.registry.filter(m => m.status === "complete").map(m => m.id),
  );

  const depsMap = new Map<string, string[]>();
  for (const entry of state.registry) {
    if (entry.dependsOn?.length) {
      depsMap.set(entry.id, entry.dependsOn);
    }
  }

  if (pendingIds.length > 0 && depsMap.size > 0) {
    const validation = validateQueueOrder(pendingIds, depsMap, completedIds);

    if (validation.violations.length > 0) {
      lines.push("");
      lines.push("### Dependency Issues");
      for (const v of validation.violations) {
        lines.push(`- **${v.type}**: ${v.message}`);
      }
    }
  }

  return lines.join("\n");
}
