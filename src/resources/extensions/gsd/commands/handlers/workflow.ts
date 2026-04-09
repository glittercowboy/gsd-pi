import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { handleQuick } from "../../quick.js";
import { showDiscuss, showHeadlessMilestoneCreation, showQueue } from "../../guided-flow.js";
import { handleStart, handleTemplates } from "../../commands-workflow-templates.js";
import { gsdRoot } from "../../paths.js";
import { deriveState } from "../../state.js";
import { isParked, parkMilestone, unparkMilestone } from "../../milestone-actions.js";
import { loadEffectiveGSDPreferences } from "../../preferences.js";
import { nextMilestoneId } from "../../milestone-ids.js";
import { findMilestoneIds } from "../../guided-flow.js";
import { projectRoot } from "../context.js";
import { createRun, listRuns } from "../../run-manager.js";
import {
  setActiveEngineId,
  setActiveRunDir,
  startAuto,
  pauseAuto,
  isAutoActive,
  getActiveEngineId,
} from "../../auto.js";
import { validateDefinition } from "../../definition-loader.js";

// ─── Custom Workflow Subcommands ─────────────────────────────────────────

const WORKFLOW_USAGE = [
  "Usage: /gsd workflow <subcommand>",
  "",
  "  new               — Create a new workflow definition (via skill)",
  "  run <name> [k=v]  — Create a run and start auto-mode",
  "  list [name]       — List workflow runs (optionally filtered by name)",
  "  validate <name>   — Validate a workflow definition YAML",
  "  pause             — Pause custom workflow auto-mode",
  "  resume            — Resume paused custom workflow auto-mode",
].join("\n");

async function handleCustomWorkflow(
  sub: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<boolean> {
  // Bare `/gsd workflow` — show usage
  if (!sub) {
    ctx.ui.notify(WORKFLOW_USAGE, "info");
    return true;
  }

  // ── new ──
  if (sub === "new") {
    ctx.ui.notify("Use the create-workflow skill: /skill create-workflow", "info");
    return true;
  }

  // ── run <name> [param=value ...] ──
  if (sub === "run" || sub.startsWith("run ")) {
    const args = sub.slice("run".length).trim();
    if (!args) {
      ctx.ui.notify("Usage: /gsd workflow run <name> [param=value ...]", "warning");
      return true;
    }
    const parts = args.split(/\s+/);
    const defName = parts[0];
    const overrides: Record<string, string> = {};
    for (let i = 1; i < parts.length; i++) {
      const eqIdx = parts[i].indexOf("=");
      if (eqIdx > 0) {
        overrides[parts[i].slice(0, eqIdx)] = parts[i].slice(eqIdx + 1);
      }
    }
    try {
      const base = projectRoot();
      const runDir = createRun(base, defName, Object.keys(overrides).length > 0 ? overrides : undefined);
      setActiveEngineId("custom");
      setActiveRunDir(runDir);
      ctx.ui.notify(`Created workflow run: ${defName}\nRun dir: ${runDir}`, "info");
      await startAuto(ctx, pi, base, false);
    } catch (err) {
      // Clean up engine state so a failed workflow run doesn't pollute the next /gsd auto
      setActiveEngineId(null);
      setActiveRunDir(null);
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to run workflow "${defName}": ${msg}`, "error");
    }
    return true;
  }

  // ── list [name] ──
  if (sub === "list" || sub.startsWith("list ")) {
    const filterName = sub.slice("list".length).trim() || undefined;
    const base = projectRoot();
    const runs = listRuns(base, filterName);
    if (runs.length === 0) {
      ctx.ui.notify("No workflow runs found.", "info");
      return true;
    }
    const lines = runs.map((r) => {
      const stepInfo = `${r.steps.completed}/${r.steps.total} steps`;
      return `• ${r.name} [${r.timestamp}] — ${r.status} (${stepInfo})`;
    });
    ctx.ui.notify(lines.join("\n"), "info");
    return true;
  }

  // ── validate <name> ──
  if (sub === "validate" || sub.startsWith("validate ")) {
    const defName = sub.slice("validate".length).trim();
    if (!defName) {
      ctx.ui.notify("Usage: /gsd workflow validate <name>", "warning");
      return true;
    }
    const base = projectRoot();
    const defPath = join(base, ".gsd", "workflow-defs", `${defName}.yaml`);
    if (!existsSync(defPath)) {
      ctx.ui.notify(`Definition not found: ${defPath}`, "error");
      return true;
    }
    try {
      const raw = readFileSync(defPath, "utf-8");
      const parsed = parseYaml(raw);
      const result = validateDefinition(parsed);
      if (result.valid) {
        ctx.ui.notify(`✓ "${defName}" is a valid workflow definition.`, "info");
      } else {
        ctx.ui.notify(`✗ "${defName}" has errors:\n  - ${result.errors.join("\n  - ")}`, "error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to validate "${defName}": ${msg}`, "error");
    }
    return true;
  }

  // ── pause ──
  if (sub === "pause") {
    const engineId = getActiveEngineId();
    if (engineId === "dev" || engineId === null) {
      ctx.ui.notify("No custom workflow is running. Use /gsd pause for dev workflow.", "warning");
      return true;
    }
    if (!isAutoActive()) {
      ctx.ui.notify("Auto-mode is not active.", "warning");
      return true;
    }
    await pauseAuto(ctx, pi);
    ctx.ui.notify("Custom workflow paused.", "info");
    return true;
  }

  // ── resume ──
  if (sub === "resume") {
    const engineId = getActiveEngineId();
    if (engineId === "dev" || engineId === null) {
      ctx.ui.notify("No custom workflow to resume. Use /gsd auto for dev workflow.", "warning");
      return true;
    }
    try {
      await startAuto(ctx, pi, projectRoot(), false);
      ctx.ui.notify("Custom workflow resumed.", "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to resume workflow: ${msg}`, "error");
    }
    return true;
  }

  // Unknown subcommand — show usage
  ctx.ui.notify(`Unknown workflow subcommand: "${sub}"\n\n${WORKFLOW_USAGE}`, "warning");
  return true;
}

export async function handleWorkflowCommand(trimmed: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  // ── Custom workflow commands (`/gsd workflow ...`) ──
  if (trimmed === "workflow" || trimmed.startsWith("workflow ")) {
    const sub = trimmed.slice("workflow".length).trim();
    return handleCustomWorkflow(sub, ctx, pi);
  }

  if (trimmed === "queue") {
    await showQueue(ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "discuss") {
    await showDiscuss(ctx, pi, projectRoot());
    return true;
  }
  if (trimmed === "quick" || trimmed.startsWith("quick ")) {
    if (isAutoActive()) {
      ctx.ui.notify(
        "/gsd quick cannot run while auto-mode is active.\n" +
        "Stop auto-mode first with /gsd stop, then run /gsd quick.",
        "error",
      );
      return true;
    }
    await handleQuick(trimmed.replace(/^quick\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "new-milestone") {
    const basePath = projectRoot();
    const headlessContextPath = join(gsdRoot(basePath), "runtime", "headless-context.md");
    if (existsSync(headlessContextPath)) {
      const seedContext = readFileSync(headlessContextPath, "utf-8");
      try { unlinkSync(headlessContextPath); } catch { /* non-fatal */ }
      await showHeadlessMilestoneCreation(ctx, pi, basePath, seedContext);
    } else {
      const { showSmartEntry } = await import("../../guided-flow.js");
      await showSmartEntry(ctx, pi, basePath);
    }
    return true;
  }
  if (trimmed === "start" || trimmed.startsWith("start ")) {
    await handleStart(trimmed.replace(/^start\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "templates" || trimmed.startsWith("templates ")) {
    await handleTemplates(trimmed.replace(/^templates\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "park" || trimmed.startsWith("park ")) {
    const basePath = projectRoot();
    const arg = trimmed.replace(/^park\s*/, "").trim();
    let targetId = arg;
    if (!targetId) {
      const state = await deriveState(basePath);
      if (!state.activeMilestone) {
        ctx.ui.notify("No active milestone to park.", "warning");
        return true;
      }
      targetId = state.activeMilestone.id;
    }
    if (isParked(basePath, targetId)) {
      ctx.ui.notify(`${targetId} is already parked. Use /gsd unpark ${targetId} to reactivate.`, "info");
      return true;
    }
    const reasonParts = arg.replace(targetId, "").trim().replace(/^["']|["']$/g, "");
    const reason = reasonParts || "Parked via /gsd park";
    const success = parkMilestone(basePath, targetId, reason);
    ctx.ui.notify(
      success ? `Parked ${targetId}. Run /gsd unpark ${targetId} to reactivate.` : `Could not park ${targetId} — milestone not found.`,
      success ? "info" : "warning",
    );
    return true;
  }
  if (trimmed === "unpark" || trimmed.startsWith("unpark ")) {
    const basePath = projectRoot();
    const arg = trimmed.replace(/^unpark\s*/, "").trim();
    let targetId = arg;
    if (!targetId) {
      const state = await deriveState(basePath);
      const parkedEntries = state.registry.filter((entry) => entry.status === "parked");
      if (parkedEntries.length === 0) {
        ctx.ui.notify("No parked milestones.", "info");
        return true;
      }
      if (parkedEntries.length === 1) {
        targetId = parkedEntries[0].id;
      } else {
        ctx.ui.notify(`Parked milestones: ${parkedEntries.map((entry) => entry.id).join(", ")}. Specify which to unpark: /gsd unpark <id>`, "info");
        return true;
      }
    }
    const success = unparkMilestone(basePath, targetId);
    ctx.ui.notify(
      success ? `Unparked ${targetId}. It will resume its normal position in the queue.` : `Could not unpark ${targetId} — milestone not found or not parked.`,
      success ? "info" : "warning",
    );
    return true;
  }
  return false;
}

export function getNextMilestoneId(basePath: string): string {
  const milestoneIds = findMilestoneIds(basePath);
  const uniqueIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
  return nextMilestoneId(milestoneIds, uniqueIds);
}

