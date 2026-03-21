/**
 * GSD Maintenance — cleanup, skip, and dry-run handlers.
 *
 * Contains: handleCleanupBranches, handleCleanupSnapshots, handleSkip, handleDryRun
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { deriveState } from "./state.js";
import { nativeBranchList, nativeDetectMainBranch, nativeBranchListMerged, nativeBranchDelete, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";

export async function handleCleanupBranches(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  let branches: string[];
  try {
    branches = nativeBranchList(basePath, "gsd/*");
  } catch {
    ctx.ui.notify("No GSD branches found.", "info");
    return;
  }

  if (branches.length === 0) {
    ctx.ui.notify("No GSD branches to clean up.", "info");
    return;
  }

  const mainBranch = nativeDetectMainBranch(basePath);

  let merged: string[];
  try {
    merged = nativeBranchListMerged(basePath, mainBranch, "gsd/*");
  } catch {
    merged = [];
  }

  if (merged.length === 0) {
    ctx.ui.notify(`${branches.length} GSD branches found, none are merged into ${mainBranch} yet.`, "info");
    return;
  }

  let deleted = 0;
  for (const branch of merged) {
    try {
      nativeBranchDelete(basePath, branch, false);
      deleted++;
    } catch { /* skip branches that can't be deleted */ }
  }

  ctx.ui.notify(`Cleaned up ${deleted} merged branches. ${branches.length - deleted} remain.`, "success");
}

export async function handleCleanupSnapshots(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  let refs: string[];
  try {
    refs = nativeForEachRef(basePath, "refs/gsd/snapshots/");
  } catch {
    ctx.ui.notify("No snapshot refs found.", "info");
    return;
  }

  if (refs.length === 0) {
    ctx.ui.notify("No snapshot refs to clean up.", "info");
    return;
  }

  const byLabel = new Map<string, string[]>();
  for (const ref of refs) {
    const parts = ref.split("/");
    const label = parts.slice(0, -1).join("/");
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(ref);
  }

  let pruned = 0;
  for (const [, labelRefs] of byLabel) {
    const sorted = labelRefs.sort();
    for (const old of sorted.slice(0, -5)) {
      try {
        nativeUpdateRef(basePath, old);
        pruned++;
      } catch { /* skip */ }
    }
  }

  ctx.ui.notify(`Pruned ${pruned} old snapshot refs. ${refs.length - pruned} remain.`, "success");
}

export async function handleSkip(unitArg: string, ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  if (!unitArg) {
    ctx.ui.notify("Usage: /gsd skip <unit-id>  (e.g., /gsd skip execute-task/M001/S01/T03 or /gsd skip T03)", "info");
    return;
  }

  const { existsSync: fileExists, writeFileSync: writeFile, mkdirSync: mkDir, readFileSync: readFile } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");

  const completedKeysFile = pathJoin(basePath, ".gsd", "completed-units.json");
  let keys: string[] = [];
  try {
    if (fileExists(completedKeysFile)) {
      keys = JSON.parse(readFile(completedKeysFile, "utf-8"));
    }
  } catch { /* start fresh */ }

  // Normalize: accept "execute-task/M001/S01/T03", "M001/S01/T03", or just "T03"
  let skipKey = unitArg;

  if (!skipKey.includes("execute-task") && !skipKey.includes("plan-") && !skipKey.includes("research-") && !skipKey.includes("complete-")) {
    const state = await deriveState(basePath);
    const mid = state.activeMilestone?.id;
    const sid = state.activeSlice?.id;

    if (unitArg.match(/^T\d+$/i) && mid && sid) {
      skipKey = `execute-task/${mid}/${sid}/${unitArg.toUpperCase()}`;
    } else if (unitArg.match(/^S\d+$/i) && mid) {
      skipKey = `plan-slice/${mid}/${unitArg.toUpperCase()}`;
    } else if (unitArg.includes("/")) {
      skipKey = `execute-task/${unitArg}`;
    }
  }

  if (keys.includes(skipKey)) {
    ctx.ui.notify(`Already skipped: ${skipKey}`, "info");
    return;
  }

  keys.push(skipKey);
  mkDir(pathJoin(basePath, ".gsd"), { recursive: true });
  writeFile(completedKeysFile, JSON.stringify(keys), "utf-8");

  ctx.ui.notify(`Skipped: ${skipKey}. Will not be dispatched in auto-mode.`, "success");
}

export async function handleDryRun(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const state = await deriveState(basePath);

  if (!state.activeMilestone) {
    ctx.ui.notify("No active milestone — nothing to dispatch.", "info");
    return;
  }

  const { getLedger, getProjectTotals, formatCost, formatTokenCount, loadLedgerFromDisk } = await import("./metrics.js");
  const { loadEffectiveGSDPreferences: loadPrefs } = await import("./preferences.js");
  const { formatDuration } = await import("../shared/format-utils.js");

  const ledger = getLedger();
  const units = ledger?.units ?? loadLedgerFromDisk(basePath)?.units ?? [];
  const prefs = loadPrefs()?.preferences;

  let nextType = "unknown";
  let nextId = "unknown";

  const mid = state.activeMilestone.id;
  const midTitle = state.activeMilestone.title;

  if (state.phase === "pre-planning") {
    nextType = "research-milestone";
    nextId = mid;
  } else if (state.phase === "planning" && state.activeSlice) {
    nextType = "plan-slice";
    nextId = `${mid}/${state.activeSlice.id}`;
  } else if (state.phase === "executing" && state.activeTask && state.activeSlice) {
    nextType = "execute-task";
    nextId = `${mid}/${state.activeSlice.id}/${state.activeTask.id}`;
  } else if (state.phase === "summarizing" && state.activeSlice) {
    nextType = "complete-slice";
    nextId = `${mid}/${state.activeSlice.id}`;
  } else if (state.phase === "completing-milestone") {
    nextType = "complete-milestone";
    nextId = mid;
  } else {
    nextType = state.phase;
    nextId = mid;
  }

  const sameTypeUnits = units.filter(u => u.type === nextType);
  const avgCost = sameTypeUnits.length > 0
    ? sameTypeUnits.reduce((s, u) => s + u.cost, 0) / sameTypeUnits.length
    : null;
  const avgDuration = sameTypeUnits.length > 0
    ? sameTypeUnits.reduce((s, u) => s + (u.finishedAt - u.startedAt), 0) / sameTypeUnits.length
    : null;

  const totals = units.length > 0 ? getProjectTotals(units) : null;
  const budgetRemaining = prefs?.budget_ceiling && totals
    ? prefs.budget_ceiling - totals.cost
    : null;

  const lines = [
    `Dry-run preview:`,
    ``,
    `  Next unit:     ${nextType}`,
    `  ID:            ${nextId}`,
    `  Milestone:     ${mid}: ${midTitle}`,
    `  Phase:         ${state.phase}`,
    `  Est. cost:     ${avgCost !== null ? `${formatCost(avgCost)} (avg of ${sameTypeUnits.length} similar)` : "unknown (first of this type)"}`,
    `  Est. duration: ${avgDuration !== null ? formatDuration(avgDuration) : "unknown"}`,
    `  Spent so far:  ${totals ? formatCost(totals.cost) : "$0"}`,
    `  Budget left:   ${budgetRemaining !== null ? formatCost(budgetRemaining) : "no ceiling set"}`,
  ];

  if (state.progress) {
    const p = state.progress;
    lines.push(`  Progress:      ${p.tasks?.done ?? 0}/${p.tasks?.total ?? "?"} tasks, ${p.slices?.done ?? 0}/${p.slices?.total ?? "?"} slices`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function handleCleanupProjects(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { readdirSync, existsSync: fsExists, rmSync: fsRmSync } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const { readRepoMeta, externalProjectsRoot } = await import("./repo-identity.js");

  const fix = args.includes("--fix");
  const projectsDir = externalProjectsRoot();

  if (!fsExists(projectsDir)) {
    ctx.ui.notify(`No project-state directory found at ${projectsDir} — nothing to clean up.`, "info");
    return;
  }

  let hashList: string[];
  try {
    hashList = readdirSync(projectsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    ctx.ui.notify(`Failed to read project-state directory at ${projectsDir}.`, "error");
    return;
  }

  if (hashList.length === 0) {
    ctx.ui.notify(`Project-state directory is empty (${projectsDir}) — nothing to clean up.`, "info");
    return;
  }

  type ProjectEntry = { hash: string; gitRoot: string; remoteUrl: string };
  const active: ProjectEntry[] = [];
  const orphaned: ProjectEntry[] = [];
  const unknown: string[] = [];

  for (const hash of hashList) {
    const dirPath = pathJoin(projectsDir, hash);
    const meta = readRepoMeta(dirPath);
    if (!meta) {
      unknown.push(hash);
      continue;
    }
    const entry: ProjectEntry = { hash, gitRoot: meta.gitRoot, remoteUrl: meta.remoteUrl };
    if (fsExists(meta.gitRoot)) {
      active.push(entry);
    } else {
      orphaned.push(entry);
    }
  }

  const pl = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines: string[] = [
    `${projectsDir}  ${pl(hashList.length, "project state director")}${hashList.length === 1 ? "y" : "ies"}`,
    "",
  ];

  if (active.length > 0) {
    lines.push(`Active (${active.length}) — git root present on disk:`);
    for (const e of active) {
      const remote = e.remoteUrl ? `  [${e.remoteUrl}]` : "";
      lines.push(`  + ${e.hash}  ${e.gitRoot}${remote}`);
    }
    lines.push("");
  }

  if (orphaned.length > 0) {
    lines.push(`Orphaned (${orphaned.length}) — git root no longer exists:`);
    for (const e of orphaned) {
      const remote = e.remoteUrl ? `  [${e.remoteUrl}]` : "";
      lines.push(`  - ${e.hash}  ${e.gitRoot}${remote}`);
    }
    lines.push("");
  }

  if (unknown.length > 0) {
    lines.push(`Unknown (${unknown.length}) — no metadata yet:`);
    for (const h of unknown) {
      lines.push(`  ? ${h}  (open that project in GSD once to register metadata)`);
    }
    lines.push("");
  }

  if (orphaned.length === 0) {
    lines.push("No orphaned project state — all tracked repos are still present on disk.");
    if (!fix) {
      ctx.ui.notify(lines.join("\n"), "success");
      return;
    }
  }

  if (!fix && orphaned.length > 0) {
    lines.push(`Run /gsd cleanup projects --fix to permanently delete ${pl(orphaned.length, "orphaned director")}${orphaned.length === 1 ? "y" : "ies"}.`);
    ctx.ui.notify(lines.join("\n"), "warning");
    return;
  }

  if (fix && orphaned.length > 0) {
    let removed = 0;
    const failed: string[] = [];
    for (const e of orphaned) {
      try {
        fsRmSync(pathJoin(projectsDir, e.hash), { recursive: true, force: true });
        removed++;
      } catch {
        failed.push(e.hash);
      }
    }
    lines.push(`Removed ${pl(removed, "orphaned director")}${removed === 1 ? "y" : "ies"}.`);
    if (failed.length > 0) {
      lines.push(`Failed to remove: ${failed.join(", ")}`);
    }
    ctx.ui.notify(lines.join("\n"), removed > 0 ? "success" : "warning");
    return;
  }

  ctx.ui.notify(lines.join("\n"), "info");
}
