import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { enableDebug } from "../../debug-logger.js";
import { getAutoDashboardData, isAutoActive, isAutoPaused, pauseAuto, startAutoDetached, stopAuto, stopAutoRemote } from "../../auto.js";
import { handleRate } from "../../commands-rate.js";
import { guardRemoteSession, projectRoot } from "../context.js";
import { findMilestoneIds } from "../../milestone-id-utils.js";

/**
 * Parse --yolo flag and optional file path from the auto command string.
 * Supports: `/gsd auto --yolo path/to/file.md` or `/gsd auto -y path/to/file.md`
 */
function parseYoloFlag(trimmed: string): { yoloSeedFile: string | null; rest: string } {
  const yoloRe = /(?:--yolo|-y)\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/;
  const match = trimmed.match(yoloRe);
  if (!match) return { yoloSeedFile: null, rest: trimmed };

  // Strip quotes if present
  let filePath = match[1];
  if ((filePath.startsWith('"') && filePath.endsWith('"')) ||
      (filePath.startsWith("'") && filePath.endsWith("'"))) {
    filePath = filePath.slice(1, -1);
  }

  const rest = trimmed.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { yoloSeedFile: filePath, rest };
}

/**
 * Extract a milestone ID (e.g. M016 or M001-a3b4c5) from the command string.
 * Returns the matched ID and the remaining string with the ID removed.
 * The milestone ID pattern matches the format used by findMilestoneIds: M\d+ with
 * an optional -[a-z0-9]{6} suffix for unique milestone IDs.
 */
export function parseMilestoneTarget(input: string): { milestoneId: string | null; rest: string } {
  const match = input.match(/\b(M\d+(?:-[a-z0-9]{6})?)\b/);
  if (!match) return { milestoneId: null, rest: input };
  const rest = input.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { milestoneId: match[1], rest };
}

export async function handleAutoCommand(trimmed: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  if (trimmed === "next" || trimmed.startsWith("next ")) {
    if (trimmed.includes("--dry-run")) {
      const { handleDryRun } = await import("../../commands-maintenance.js");
      await handleDryRun(ctx, projectRoot());
      return true;
    }
    const { milestoneId, rest: afterMilestone } = parseMilestoneTarget(trimmed);
    const verboseMode = afterMilestone.includes("--verbose");
    const debugMode = afterMilestone.includes("--debug");
    if (debugMode) enableDebug(projectRoot());
    if (!(await guardRemoteSession(ctx, pi))) return true;

    // Validate the milestone target exists and is not already complete.
    if (milestoneId) {
      const allIds = findMilestoneIds(projectRoot());
      if (!allIds.includes(milestoneId)) {
        ctx.ui.notify(`Milestone ${milestoneId} does not exist. Available: ${allIds.join(", ") || "(none)"}`, "error");
        return true;
      }
    }

    startAutoDetached(ctx, pi, projectRoot(), verboseMode, {
      step: true,
      milestoneLock: milestoneId,
    });
    return true;
  }

  if (trimmed === "auto" || trimmed.startsWith("auto ")) {
    const { yoloSeedFile, rest: afterYolo } = parseYoloFlag(trimmed);
    const { milestoneId, rest: afterMilestone } = parseMilestoneTarget(afterYolo);
    const verboseMode = afterMilestone.includes("--verbose");
    const debugMode = afterMilestone.includes("--debug");
    if (debugMode) enableDebug(projectRoot());
    if (!(await guardRemoteSession(ctx, pi))) return true;

    // Validate the milestone target exists and is not already complete.
    if (milestoneId) {
      const allIds = findMilestoneIds(projectRoot());
      if (!allIds.includes(milestoneId)) {
        ctx.ui.notify(`Milestone ${milestoneId} does not exist. Available: ${allIds.join(", ") || "(none)"}`, "error");
        return true;
      }
    }

    if (yoloSeedFile) {
      const resolved = resolve(projectRoot(), yoloSeedFile);
      if (!existsSync(resolved)) {
        ctx.ui.notify(`Yolo seed file not found: ${resolved}`, "error");
        return true;
      }
      const seedContent = readFileSync(resolved, "utf-8").trim();
      if (!seedContent) {
        ctx.ui.notify(`Yolo seed file is empty: ${resolved}`, "error");
        return true;
      }
      // Headless path: bootstrap project, dispatch non-interactive discuss,
      // then auto-mode starts automatically via checkAutoStartAfterDiscuss
      // when the LLM says "Milestone X ready."
      const { showHeadlessMilestoneCreation } = await import("../../guided-flow.js");
      await showHeadlessMilestoneCreation(ctx, pi, projectRoot(), seedContent);
    } else if (milestoneId) {
      startAutoDetached(ctx, pi, projectRoot(), verboseMode, {
        milestoneLock: milestoneId,
      });
    } else {
      startAutoDetached(ctx, pi, projectRoot(), verboseMode);
    }
    return true;
  }

  if (trimmed === "stop") {
    if (!isAutoActive() && !isAutoPaused()) {
      const result = stopAutoRemote(projectRoot());
      if (result.found) {
        ctx.ui.notify(`Sent stop signal to auto-mode session (PID ${result.pid}). It will shut down gracefully.`, "info");
      } else if (result.error) {
        ctx.ui.notify(`Failed to stop remote auto-mode: ${result.error}`, "error");
      } else {
        ctx.ui.notify("Auto-mode is not running.", "info");
      }
      return true;
    }
    await stopAuto(ctx, pi, "User requested stop");
    return true;
  }

  if (trimmed === "pause") {
    if (!isAutoActive()) {
      if (isAutoPaused()) {
        ctx.ui.notify("Auto-mode is already paused. /gsd auto to resume.", "info");
      } else {
        ctx.ui.notify("Auto-mode is not running.", "info");
      }
      return true;
    }
    await pauseAuto(ctx, pi);
    return true;
  }

  if (trimmed === "rate" || trimmed.startsWith("rate ")) {
    await handleRate(trimmed.replace(/^rate\s*/, "").trim(), ctx, projectRoot());
    return true;
  }

  if (trimmed === "") {
    if (!(await guardRemoteSession(ctx, pi))) return true;
    startAutoDetached(ctx, pi, projectRoot(), false, { step: true });
    return true;
  }

  return false;
}
