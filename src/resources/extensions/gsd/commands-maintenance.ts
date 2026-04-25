/**
 * GSD Maintenance — cleanup, skip, dry-run, and recover handlers.
 *
 * Contains: handleCleanupBranches, handleCleanupSnapshots, handleCleanupWorktrees, handleSkip, handleDryRun, handleRecover
 */

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { deriveState } from "./state.js";
import { nativeBranchList, nativeDetectMainBranch, nativeBranchListMerged, nativeBranchDelete, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";
import { logWarning } from "./workflow-logger.js";

export async function handleCleanupBranches(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  let branches: string[];
  try {
    branches = nativeBranchList(basePath, "gsd/*");
  } catch (e) {
    logWarning("command", `branch list failed: ${(e as Error).message}`);
    ctx.ui.notify("No GSD branches to clean up.", "info");
    return;
  }

  const quickBranches = branches.filter((b) => b.startsWith("gsd/quick/"));

  const mainBranch = nativeDetectMainBranch(basePath);
  let merged: string[];
  try {
    merged = nativeBranchListMerged(basePath, mainBranch, "gsd/*");
  } catch (e) {
    logWarning("command", `merged branch list failed: ${(e as Error).message}`);
    merged = [];
  }

  const mergedNonQuick = merged.filter((b) => !b.startsWith("gsd/quick/"));
  let deletedMerged = 0;
  for (const branch of mergedNonQuick) {
    try {
      nativeBranchDelete(basePath, branch, false);
      deletedMerged++;
    } catch (e) {
      logWarning("command", `branch delete failed for ${branch}: ${(e as Error).message}`);
    }
  }

  // Also delete stale milestone branches for completed milestones when detached
  // from any registered worktree.
  let deletedStaleMilestones = 0;
  try {
    const { listWorktrees } = await import("./worktree-manager.js");
    const { resolveMilestoneFile } = await import("./paths.js");
    const { loadFile } = await import("./files.js");
    const { parseRoadmap } = await import("./parsers-legacy.js");
    const { isMilestoneComplete } = await import("./state.js");
    const { isDbAvailable, getMilestone } = await import("./gsd-db.js");

    const attachedBranches = new Set(
      listWorktrees(basePath).map((wt) => wt.branch),
    );
    const milestoneBranches = nativeBranchList(basePath, "milestone/*");
    for (const branch of milestoneBranches) {
      if (attachedBranches.has(branch)) continue;
      const milestoneId = branch.replace(/^milestone\//, "");

      // DB-first: check milestone status directly
      if (isDbAvailable()) {
        const dbRow = getMilestone(milestoneId);
        if (dbRow) {
          if (dbRow.status !== "complete" && dbRow.status !== "done") continue;
          // Milestone is complete per DB — proceed to delete branch
          try {
            nativeBranchDelete(basePath, branch, true);
            deletedStaleMilestones++;
          } catch (e) { logWarning("command", `stale milestone branch delete failed for ${branch}: ${(e as Error).message}`); }
          continue;
        }
      }

      // Filesystem fallback
      const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
      if (!roadmapPath) continue;
      let roadmapContent: string | null = null;
      try {
        roadmapContent = await loadFile(roadmapPath);
      } catch (e) {
        logWarning("command", `loadFile failed for ${roadmapPath}: ${(e as Error).message}`);
        roadmapContent = null;
      }
      if (!roadmapContent) continue;
      if (!isMilestoneComplete(parseRoadmap(roadmapContent))) continue;
      try {
        nativeBranchDelete(basePath, branch, true);
        deletedStaleMilestones++;
      } catch (e) {
        logWarning("command", `milestone branch delete failed for ${branch}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    logWarning("command", `stale milestone cleanup failed: ${(e as Error).message}`);
  }

  const summary: string[] = [];
  if (deletedMerged > 0) {
    summary.push(`Cleaned up ${deletedMerged} merged branch${deletedMerged === 1 ? "" : "es"}.`);
  }
  if (deletedStaleMilestones > 0) {
    summary.push(`Deleted ${deletedStaleMilestones} stale milestone branch${deletedStaleMilestones === 1 ? "" : "es"}.`);
  }
  if (quickBranches.length > 0) {
    summary.push(`Skipped ${quickBranches.length} quick branch${quickBranches.length === 1 ? "" : "es"} (gsd/quick/*).`);
  }

  if (summary.length === 0) {
    const nonQuickCount = branches.filter((b) => !b.startsWith("gsd/quick/")).length;
    ctx.ui.notify(
      nonQuickCount > 0
        ? `${nonQuickCount} GSD branch${nonQuickCount === 1 ? "" : "es"} found, none merged into ${mainBranch} yet.`
        : "No non-quick GSD branches to clean up.",
      "info",
    );
    return;
  }

  ctx.ui.notify(summary.join(" "), "success");
}

export async function handleCleanupSnapshots(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  let refs: string[];
  try {
    refs = nativeForEachRef(basePath, "refs/gsd/snapshots/");
  } catch (e) {
    logWarning("command", `snapshot ref list failed: ${(e as Error).message}`);
    ctx.ui.notify("No snapshot refs to clean up.", "info");
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
      } catch (e) {
        logWarning("command", `snapshot ref update failed for ${old}: ${(e as Error).message}`);
      }
    }
  }

  ctx.ui.notify(`Pruned ${pruned} old snapshot refs. ${refs.length - pruned} remain.`, "success");
}

export async function handleCleanupWorktrees(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const { getAllWorktreeHealth, formatWorktreeStatusLine } = await import("./worktree-health.js");
  const { removeWorktree } = await import("./worktree-manager.js");
  const { sep } = await import("node:path");

  let statuses;
  try {
    statuses = getAllWorktreeHealth(basePath);
  } catch (e) {
    logWarning("command", `worktree health inspection failed: ${(e as Error).message}`);
    ctx.ui.notify("Failed to inspect worktrees.", "error");
    return;
  }

  if (statuses.length === 0) {
    ctx.ui.notify("No GSD worktrees found.", "info");
    return;
  }

  const safeToRemove = statuses.filter(s => s.safeToRemove);
  const stale = statuses.filter(s => s.stale && !s.safeToRemove);
  const active = statuses.filter(s => !s.safeToRemove && !s.stale);

  const lines: string[] = [];
  lines.push(`${statuses.length} worktree${statuses.length === 1 ? "" : "s"} found.`);
  lines.push("");

  if (safeToRemove.length > 0) {
    lines.push(`Safe to remove (${safeToRemove.length}) — merged into main, clean:`);
    const cwd = process.cwd();
    let removed = 0;
    for (const s of safeToRemove) {
      const wt = s.worktree;
      const isCwd = wt.path === cwd || cwd.startsWith(wt.path + sep);
      if (isCwd) {
        lines.push(`  ⊘ ${wt.name}  (skipped — current working directory)`);
        continue;
      }
      try {
        removeWorktree(basePath, wt.name, { deleteBranch: true });
        lines.push(`  ✓ ${wt.name}  removed (branch ${wt.branch} deleted)`);
        removed++;
      } catch (e) {
        logWarning("command", `worktree removal failed for ${wt.name}: ${(e as Error).message}`);
        lines.push(`  ✗ ${wt.name}  failed to remove`);
      }
    }
    if (removed > 0) {
      lines.push("");
      lines.push(`Removed ${removed} merged worktree${removed === 1 ? "" : "s"}.`);
    }
    lines.push("");
  }

  if (stale.length > 0) {
    lines.push(`Stale (${stale.length}) — no recent commits, not merged (review manually):`);
    for (const s of stale) {
      lines.push(`  ⚠ ${s.worktree.name}  ${formatWorktreeStatusLine(s)}`);
    }
    lines.push("");
  }

  if (active.length > 0) {
    lines.push(`Active (${active.length}) — in progress:`);
    for (const s of active) {
      lines.push(`  ● ${s.worktree.name}  ${formatWorktreeStatusLine(s)}`);
    }
    lines.push("");
  }

  if (safeToRemove.length === 0 && stale.length === 0) {
    lines.push("All worktrees are active — nothing to clean up.");
  }

  ctx.ui.notify(lines.join("\n"), safeToRemove.length > 0 ? "success" : "info");
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
  } catch (e) { logWarning("command", `completed-units.json parse failed: ${(e as Error).message}`); }

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
  } catch (e) {
    logWarning("command", `readdir failed for project-state directory: ${(e as Error).message}`);
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
      } catch (err) {
        logWarning("command", `project cleanup rm failed for ${e.hash}: ${(err as Error).message}`);
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

/**
 * `gsd recover` — Reconstruct DB hierarchy state from rendered markdown on disk.
 *
 * Deletes milestones, slices, and tasks table rows (preserves decisions,
 * requirements, artifacts, memories), re-runs `migrateHierarchyToDb()` to
 * repopulate from markdown, then calls `deriveState()` to verify sanity.
 *
 * Prints counts of recovered items and the resulting project phase.
 */
export async function handleRecover(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const { isDbAvailable: dbAvailable, clearEngineHierarchy, transaction: dbTransaction } = await import("./gsd-db.js");
  const { migrateHierarchyToDb } = await import("./md-importer.js");
  const { invalidateStateCache } = await import("./state.js");

  if (!dbAvailable()) {
    ctx.ui.notify("gsd recover: No database open. Run a GSD command first to initialize the DB.", "error");
    return;
  }

  try {
    // 1. Delete + re-populate inside a single transaction for atomicity.
    //    clearEngineHierarchy() uses transaction() internally but transaction()
    //    is re-entrant, so wrapping in dbTransaction() keeps the whole
    //    clear+repopulate atomic.
    const counts = dbTransaction(() => {
      clearEngineHierarchy();
      return migrateHierarchyToDb(basePath);
    });

    // 3. Invalidate state cache so deriveState() picks up fresh DB data
    invalidateStateCache();

    // 4. Derive state to verify sanity
    const state = await deriveState(basePath);

    // 5. Report
    const lines = [
      `gsd recover: reconstructed hierarchy from markdown`,
      `  Milestones: ${counts.milestones}`,
      `  Slices:     ${counts.slices}`,
      `  Tasks:      ${counts.tasks}`,
      ``,
      `  Phase:      ${state.phase}`,
    ];
    if (state.activeMilestone) {
      lines.push(`  Active:     ${state.activeMilestone.id}: ${state.activeMilestone.title}`);
    }
    if (state.activeSlice) {
      lines.push(`  Slice:      ${state.activeSlice.id}: ${state.activeSlice.title}`);
    }
    if (state.activeTask) {
      lines.push(`  Task:       ${state.activeTask.id}: ${state.activeTask.title}`);
    }

    process.stderr.write(
      `gsd-recover: recovered ${counts.milestones}M/${counts.slices}S/${counts.tasks}T hierarchy\n`,
    );
    ctx.ui.notify(lines.join("\n"), "success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("command", `recover failed: ${msg}`);
    ctx.ui.notify(`gsd recover failed: ${msg}`, "error");
  }
}
