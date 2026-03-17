/**
 * GSD Command — /gsd
 *
 * One command, one wizard. Routes to smart entry or status.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { AuthStorage } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { enableDebug, isDebugEnabled } from "./debug-logger.js";
import { fileURLToPath } from "node:url";
import { deriveState } from "./state.js";
import { GSDDashboardOverlay } from "./dashboard-overlay.js";
import { GSDVisualizerOverlay } from "./visualizer-overlay.js";
import { showQueue, showDiscuss } from "./guided-flow.js";
import { startAuto, stopAuto, pauseAuto, isAutoActive, isAutoPaused, isStepMode, stopAutoRemote, dispatchDirectPhase } from "./auto.js";
import { resolveProjectRoot } from "./worktree.js";
import { appendCapture, hasPendingCaptures, loadPendingCaptures } from "./captures.js";
import {
  getGlobalGSDPreferencesPath,
  getLegacyGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
  loadEffectiveGSDPreferences,
  resolveAllSkillReferences,
} from "./preferences.js";
import { loadFile, saveFile, appendOverride, appendKnowledge, splitFrontmatter, parseFrontmatterMap } from "./files.js";
import { runClaudeImportFlow } from "./claude-import.js";
import {
  formatDoctorIssuesForPrompt,
  formatDoctorReport,
  runGSDDoctor,
  selectDoctorScope,
  filterDoctorIssues,
} from "./doctor.js";
import { loadPrompt } from "./prompt-loader.js";

import { handleRemote } from "../remote-questions/remote-command.js";
import { handleQuick } from "./quick.js";
import { handleHistory } from "./history.js";
import { handleUndo } from "./undo.js";
import { handleExport } from "./export.js";
import {
  isParallelActive, getOrchestratorState, getWorkerStatuses,
  prepareParallelStart, startParallel, stopParallel,
  pauseWorker, resumeWorker,
} from "./parallel-orchestrator.js";
import { formatEligibilityReport } from "./parallel-eligibility.js";
import { mergeAllCompleted, mergeCompletedMilestone, formatMergeResults } from "./parallel-merge.js";
import { resolveParallelConfig } from "./preferences.js";
import { nativeBranchList, nativeDetectMainBranch, nativeBranchListMerged, nativeBranchDelete, nativeForEachRef, nativeUpdateRef } from "./native-git-bridge.js";

export function dispatchDoctorHeal(pi: ExtensionAPI, scope: string | undefined, reportText: string, structuredIssues: string): void {
  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(process.env.HOME ?? "~", ".pi", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");
  const prompt = loadPrompt("doctor-heal", {
    doctorSummary: reportText,
    structuredIssues,
    scopeLabel: scope ?? "active milestone / blocking scope",
    doctorCommandSuffix: scope ? ` ${scope}` : "",
  });

  const content = `Read the following GSD workflow protocol and execute exactly.\n\n${workflow}\n\n## Your Task\n\n${prompt}`;

  pi.sendMessage(
    { customType: "gsd-doctor-heal", content, display: false },
    { triggerTurn: true },
  );
}

/** Resolve the effective project root, accounting for worktree paths. */
function projectRoot(): string {
  return resolveProjectRoot(process.cwd());
}

export function registerGSDCommand(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description: "GSD — Get Shit Done: /gsd help|next|auto|stop|pause|status|visualize|queue|quick|capture|triage|dispatch|history|undo|skip|export|cleanup|mode|prefs|config|hooks|run-hook|skill-health|doctor|forensics|migrate|remote|steer|knowledge|parallel",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        "help", "next", "auto", "stop", "pause", "status", "visualize", "queue", "quick", "discuss",
        "capture", "triage", "dispatch",
        "history", "undo", "skip", "export", "cleanup", "mode", "prefs",
        "config", "hooks", "run-hook", "skill-health", "doctor", "forensics", "migrate", "remote", "steer", "inspect", "knowledge", "parallel",
      ];
      const parts = prefix.trim().split(/\s+/);

      if (parts.length <= 1) {
        return subcommands
          .filter((cmd) => cmd.startsWith(parts[0] ?? ""))
          .map((cmd) => ({ value: cmd, label: cmd }));
      }

      if (parts[0] === "auto" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        return ["--verbose", "--debug"]
          .filter((f) => f.startsWith(flagPrefix))
          .map((f) => ({ value: `auto ${f}`, label: f }));
      }

      if (parts[0] === "mode" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        return ["global", "project"]
          .filter((cmd) => cmd.startsWith(subPrefix))
          .map((cmd) => ({ value: `mode ${cmd}`, label: cmd }));
      }

      if (parts[0] === "parallel" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        return ["start", "status", "stop", "pause", "resume", "merge"]
          .filter((cmd) => cmd.startsWith(subPrefix))
          .map((cmd) => ({ value: `parallel ${cmd}`, label: cmd }));
      }

      if (parts[0] === "prefs" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        return ["global", "project", "status", "wizard", "setup", "import-claude"]
          .filter((cmd) => cmd.startsWith(subPrefix))
          .map((cmd) => ({ value: `prefs ${cmd}`, label: cmd }));
      }

      if (parts[0] === "remote" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        return ["slack", "discord", "status", "disconnect"]
          .filter((cmd) => cmd.startsWith(subPrefix))
          .map((cmd) => ({ value: `remote ${cmd}`, label: cmd }));
      }

      if (parts[0] === "next" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        return ["--verbose", "--dry-run"]
          .filter((f) => f.startsWith(flagPrefix))
          .map((f) => ({ value: `next ${f}`, label: f }));
      }

      if (parts[0] === "history" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        return ["--cost", "--phase", "--model", "10", "20", "50"]
          .filter((f) => f.startsWith(flagPrefix))
          .map((f) => ({ value: `history ${f}`, label: f }));
      }

      if (parts[0] === "undo" && parts.length <= 2) {
        return [{ value: "undo --force", label: "--force" }];
      }

      if (parts[0] === "export" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        return ["--json", "--markdown"]
          .filter((f) => f.startsWith(flagPrefix))
          .map((f) => ({ value: `export ${f}`, label: f }));
      }

      if (parts[0] === "cleanup" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        return ["branches", "snapshots"]
          .filter((cmd) => cmd.startsWith(subPrefix))
          .map((cmd) => ({ value: `cleanup ${cmd}`, label: cmd }));
      }

      if (parts[0] === "knowledge" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        return ["rule", "pattern", "lesson"]
          .filter((cmd) => cmd.startsWith(subPrefix))
          .map((cmd) => ({ value: `knowledge ${cmd}`, label: cmd }));
      }

      if (parts[0] === "doctor") {
        const modePrefix = parts[1] ?? "";
        const modes = ["fix", "heal", "audit"];

        if (parts.length <= 2) {
          return modes
            .filter((cmd) => cmd.startsWith(modePrefix))
            .map((cmd) => ({ value: `doctor ${cmd}`, label: cmd }));
        }

        return [];
      }

      if (parts[0] === "dispatch" && parts.length <= 2) {
        const phasePrefix = parts[1] ?? "";
        return ["research", "plan", "execute", "complete", "reassess", "uat", "replan"]
          .filter((cmd) => cmd.startsWith(phasePrefix))
          .map((cmd) => ({ value: `dispatch ${cmd}`, label: cmd }));
      }

      return [];
    },

    async handler(args: string, ctx: ExtensionCommandContext) {
      const trimmed = (typeof args === "string" ? args : "").trim();

      if (trimmed === "help" || trimmed === "h" || trimmed === "?") {
        showHelp(ctx);
        return;
      }

      if (trimmed === "status") {
        await handleStatus(ctx);
        return;
      }

      if (trimmed === "visualize") {
        await handleVisualize(ctx);
        return;
      }

      if (trimmed === "mode" || trimmed.startsWith("mode ")) {
        const modeArgs = trimmed.replace(/^mode\s*/, "").trim();
        const scope = modeArgs === "project" ? "project" : "global";
        const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
        await ensurePreferencesFile(path, ctx, scope);
        await handlePrefsMode(ctx, scope);
        return;
      }

      if (trimmed === "prefs" || trimmed.startsWith("prefs ")) {
        await handlePrefs(trimmed.replace(/^prefs\s*/, "").trim(), ctx);
        return;
      }

      if (trimmed === "doctor" || trimmed.startsWith("doctor ")) {
        await handleDoctor(trimmed.replace(/^doctor\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "forensics" || trimmed.startsWith("forensics ")) {
        const { handleForensics } = await import("./forensics.js");
        await handleForensics(trimmed.replace(/^forensics\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "next" || trimmed.startsWith("next ")) {
        if (trimmed.includes("--dry-run")) {
          await handleDryRun(ctx, projectRoot());
          return;
        }
        const verboseMode = trimmed.includes("--verbose");
        const debugMode = trimmed.includes("--debug");
        if (debugMode) enableDebug(projectRoot());
        await startAuto(ctx, pi, projectRoot(), verboseMode, { step: true });
        return;
      }

      if (trimmed === "auto" || trimmed.startsWith("auto ")) {
        const verboseMode = trimmed.includes("--verbose");
        const debugMode = trimmed.includes("--debug");
        if (debugMode) enableDebug(projectRoot());
        await startAuto(ctx, pi, projectRoot(), verboseMode);
        return;
      }

      if (trimmed === "stop") {
        if (!isAutoActive() && !isAutoPaused()) {
          // Not running in this process — check for a remote auto-mode session
          const result = stopAutoRemote(projectRoot());
          if (result.found) {
            ctx.ui.notify(`Sent stop signal to auto-mode session (PID ${result.pid}). It will shut down gracefully.`, "info");
          } else if (result.error) {
            ctx.ui.notify(`Failed to stop remote auto-mode: ${result.error}`, "error");
          } else {
            ctx.ui.notify("Auto-mode is not running.", "info");
          }
          return;
        }
        await stopAuto(ctx, pi);
        return;
      }

      if (trimmed === "pause") {
        if (!isAutoActive()) {
          if (isAutoPaused()) {
            ctx.ui.notify("Auto-mode is already paused. /gsd auto to resume.", "info");
          } else {
            ctx.ui.notify("Auto-mode is not running.", "info");
          }
          return;
        }
        await pauseAuto(ctx, pi);
        return;
      }

      if (trimmed === "history" || trimmed.startsWith("history ")) {
        await handleHistory(trimmed.replace(/^history\s*/, "").trim(), ctx, projectRoot());
        return;
      }

      if (trimmed === "undo" || trimmed.startsWith("undo ")) {
        await handleUndo(trimmed.replace(/^undo\s*/, "").trim(), ctx, pi, projectRoot());
        return;
      }

      if (trimmed.startsWith("skip ")) {
        await handleSkip(trimmed.replace(/^skip\s*/, "").trim(), ctx, projectRoot());
        return;
      }

      if (trimmed === "export" || trimmed.startsWith("export ")) {
        await handleExport(trimmed.replace(/^export\s*/, "").trim(), ctx, projectRoot());
        return;
      }

      // ─── Parallel Orchestration ────────────────────────────────────────
      if (trimmed.startsWith("parallel")) {
        const parallelArgs = trimmed.slice("parallel".length).trim();
        const [subCmd = "", ...restParts] = parallelArgs.split(/\s+/);
        const rest = restParts.join(" ");

        if (subCmd === "start" || subCmd === "") {
          const loaded = loadEffectiveGSDPreferences();
          const config = resolveParallelConfig(loaded?.preferences);
          if (!config.enabled) {
            pi.sendMessage({
              customType: "gsd-parallel",
              content: "Parallel mode is not enabled. Set `parallel.enabled: true` in your preferences.",
              display: false,
            });
            return;
          }
          const candidates = await prepareParallelStart(projectRoot(), loaded?.preferences);
          const report = formatEligibilityReport(candidates);
          if (candidates.eligible.length === 0) {
            pi.sendMessage({ customType: "gsd-parallel", content: report + "\n\nNo milestones are eligible for parallel execution.", display: false });
            return;
          }
          const result = await startParallel(
            projectRoot(),
            candidates.eligible.map(e => e.milestoneId),
            loaded?.preferences,
          );
          const lines = [`Parallel orchestration started.`, `Workers: ${result.started.join(", ")}`];
          if (result.errors.length > 0) {
            lines.push(`Errors: ${result.errors.map(e => `${e.mid}: ${e.error}`).join("; ")}`);
          }
          pi.sendMessage({ customType: "gsd-parallel", content: report + "\n\n" + lines.join("\n"), display: false });
          return;
        }

        if (subCmd === "status") {
          if (!isParallelActive()) {
            pi.sendMessage({ customType: "gsd-parallel", content: "No parallel orchestration is currently active.", display: false });
            return;
          }
          const workers = getWorkerStatuses();
          const lines = ["# Parallel Workers\n"];
          for (const w of workers) {
            lines.push(`- **${w.milestoneId}** (${w.title}) — ${w.state} — ${w.completedUnits} units — $${w.cost.toFixed(2)}`);
          }
          const orchState = getOrchestratorState();
          if (orchState) {
            lines.push(`\nTotal cost: $${orchState.totalCost.toFixed(2)}`);
          }
          pi.sendMessage({ customType: "gsd-parallel", content: lines.join("\n"), display: false });
          return;
        }

        if (subCmd === "stop") {
          const mid = rest.trim() || undefined;
          await stopParallel(projectRoot(), mid);
          pi.sendMessage({ customType: "gsd-parallel", content: mid ? `Stopped worker for ${mid}.` : "All parallel workers stopped.", display: false });
          return;
        }

        if (subCmd === "pause") {
          const mid = rest.trim() || undefined;
          pauseWorker(projectRoot(), mid);
          pi.sendMessage({ customType: "gsd-parallel", content: mid ? `Paused worker for ${mid}.` : "All parallel workers paused.", display: false });
          return;
        }

        if (subCmd === "resume") {
          const mid = rest.trim() || undefined;
          resumeWorker(projectRoot(), mid);
          pi.sendMessage({ customType: "gsd-parallel", content: mid ? `Resumed worker for ${mid}.` : "All parallel workers resumed.", display: false });
          return;
        }

        if (subCmd === "merge") {
          const mid = rest.trim() || undefined;
          if (mid) {
            // Merge a specific milestone
            const result = await mergeCompletedMilestone(projectRoot(), mid);
            pi.sendMessage({ customType: "gsd-parallel", content: formatMergeResults([result]), display: false });
            return;
          }
          // Merge all completed milestones
          const workers = getWorkerStatuses();
          if (workers.length === 0) {
            pi.sendMessage({ customType: "gsd-parallel", content: "No parallel workers to merge.", display: false });
            return;
          }
          const results = await mergeAllCompleted(projectRoot(), workers);
          pi.sendMessage({ customType: "gsd-parallel", content: formatMergeResults(results), display: false });
          return;
        }

        pi.sendMessage({
          customType: "gsd-parallel",
          content: `Unknown parallel subcommand "${subCmd}". Usage: /gsd parallel [start|status|stop|pause|resume|merge]`,
          display: false,
        });
        return;
      }

      if (trimmed === "cleanup") {
        await handleCleanupBranches(ctx, projectRoot());
        await handleCleanupSnapshots(ctx, projectRoot());
        return;
      }

      if (trimmed === "cleanup branches") {
        await handleCleanupBranches(ctx, projectRoot());
        return;
      }

      if (trimmed === "cleanup snapshots") {
        await handleCleanupSnapshots(ctx, projectRoot());
        return;
      }

      if (trimmed === "queue") {
        await showQueue(ctx, pi, projectRoot());
        return;
      }

      if (trimmed === "discuss") {
        await showDiscuss(ctx, pi, projectRoot());
        return;
      }

      if (trimmed.startsWith("capture ") || trimmed === "capture") {
        await handleCapture(trimmed.replace(/^capture\s*/, "").trim(), ctx);
        return;
      }

      if (trimmed === "triage") {
        await handleTriage(ctx, pi, process.cwd());
        return;
      }

      if (trimmed === "quick" || trimmed.startsWith("quick ")) {
        await handleQuick(trimmed.replace(/^quick\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "config") {
        await handleConfig(ctx);
        return;
      }

      if (trimmed === "hooks") {
        const { formatHookStatus } = await import("./post-unit-hooks.js");
        ctx.ui.notify(formatHookStatus(), "info");
        return;
      }

      // ─── Skill Health ────────────────────────────────────────────
      if (trimmed === "skill-health" || trimmed.startsWith("skill-health ")) {
        await handleSkillHealth(trimmed.replace(/^skill-health\s*/, "").trim(), ctx);
        return;
      }

      if (trimmed.startsWith("run-hook ")) {
        await handleRunHook(trimmed.replace(/^run-hook\s*/, "").trim(), ctx, pi);
        return;
      }
      if (trimmed === "run-hook") {
        ctx.ui.notify(`Usage: /gsd run-hook <hook-name> <unit-type> <unit-id>

Unit types:
  execute-task   - Task execution (unit-id: M001/S01/T01)
  plan-slice     - Slice planning (unit-id: M001/S01)
  research-milestone - Milestone research (unit-id: M001)
  complete-slice - Slice completion (unit-id: M001/S01)
  complete-milestone - Milestone completion (unit-id: M001)

Examples:
  /gsd run-hook code-review execute-task M001/S01/T01
  /gsd run-hook lint-check plan-slice M001/S01`, "warning");
        return;
      }

      if (trimmed.startsWith("steer ")) {
        await handleSteer(trimmed.replace(/^steer\s+/, "").trim(), ctx, pi);
        return;
      }
      if (trimmed === "steer") {
        ctx.ui.notify("Usage: /gsd steer <description of change>. Example: /gsd steer Use Postgres instead of SQLite", "warning");
        return;
      }

      if (trimmed.startsWith("knowledge ")) {
        await handleKnowledge(trimmed.replace(/^knowledge\s+/, "").trim(), ctx);
        return;
      }
      if (trimmed === "knowledge") {
        ctx.ui.notify("Usage: /gsd knowledge <rule|pattern|lesson> <description>. Example: /gsd knowledge rule Use real DB for integration tests", "warning");
        return;
      }

      if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
        const { handleMigrate } = await import("./migrate/command.js");
        await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "remote" || trimmed.startsWith("remote ")) {
        await handleRemote(trimmed.replace(/^remote\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "dispatch" || trimmed.startsWith("dispatch ")) {
        const phase = trimmed.replace(/^dispatch\s*/, "").trim();
        if (!phase) {
          ctx.ui.notify("Usage: /gsd dispatch <phase>  (research|plan|execute|complete|reassess|uat|replan)", "warning");
          return;
        }
        await dispatchDirectPhase(ctx, pi, phase, projectRoot());
        return;
      }

      if (trimmed === "inspect") {
        await handleInspect(ctx);
        return;
      }

      if (trimmed === "") {
        // Bare /gsd defaults to step mode
        await startAuto(ctx, pi, projectRoot(), false, { step: true });
        return;
      }

      ctx.ui.notify(
        `Unknown: /gsd ${trimmed}. Run /gsd help for available commands.`,
        "warning",
      );
    },
  });
}

function showHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "GSD — Get Shit Done\n",
    "WORKFLOW",
    "  /gsd               Run next unit in step mode (same as /gsd next)",
    "  /gsd next           Execute next task, then pause  [--dry-run] [--verbose]",
    "  /gsd auto           Run all queued units continuously  [--verbose]",
    "  /gsd stop           Stop auto-mode gracefully",
    "  /gsd pause          Pause auto-mode (preserves state, /gsd auto to resume)",
    "  /gsd discuss        Start guided milestone/slice discussion",
    "",
    "VISIBILITY",
    "  /gsd status         Show progress dashboard  (Ctrl+Alt+G)",
    "  /gsd visualize      Interactive 7-tab TUI (progress, deps, metrics, timeline, agent, changes, export)",
    "  /gsd queue          Show queued/dispatched units and execution order",
    "  /gsd history        View execution history  [--cost] [--phase] [--model] [N]",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd skip <unit>    Prevent a unit from auto-mode dispatch",
    "  /gsd undo           Revert last completed unit  [--force]",
    "",
    "PROJECT KNOWLEDGE",
    "  /gsd knowledge <type> <text>   Add rule, pattern, or lesson to KNOWLEDGE.md",
    "",
    "CONFIGURATION",
    "  /gsd mode           Set workflow mode (solo/team)  [global|project]",
    "  /gsd prefs          Manage preferences  [global|project|status|wizard|setup]",
    "  /gsd config         Set API keys for external tools",
    "  /gsd hooks          Show post-unit hook configuration",
    "",
    "MAINTENANCE",
    "  /gsd doctor         Diagnose and repair .gsd/ state  [audit|fix|heal] [scope]",
    "  /gsd export         Export milestone/slice results  [--json|--markdown]",
    "  /gsd cleanup        Remove merged branches or snapshots  [branches|snapshots]",
    "  /gsd migrate        Upgrade .gsd/ structures to new format",
    "  /gsd remote         Control remote auto-mode  [slack|discord|status|disconnect]",
    "  /gsd inspect        Show SQLite DB diagnostics (schema, row counts, recent entries)",
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
  const basePath = projectRoot();
  const state = await deriveState(basePath);

  if (state.registry.length === 0) {
    ctx.ui.notify("No GSD milestones found. Run /gsd to start.", "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      return new GSDDashboardOverlay(tui, theme, () => done());
    },
    {
      overlay: true,
      overlayOptions: {
        width: "70%",
        minWidth: 60,
        maxHeight: "90%",
        anchor: "center",
      },
    },
  );
}

export async function fireStatusViaCommand(
  ctx: import("@gsd/pi-coding-agent").ExtensionContext,
): Promise<void> {
  await handleStatus(ctx as ExtensionCommandContext);
}

async function handleVisualize(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Visualizer requires an interactive terminal.", "warning");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      return new GSDVisualizerOverlay(tui, theme, () => done());
    },
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 80,
        maxHeight: "90%",
        anchor: "center",
      },
    },
  );
}

async function handlePrefs(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed === "" || trimmed === "global" || trimmed === "wizard" || trimmed === "setup"
    || trimmed === "wizard global" || trimmed === "setup global") {
    await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global");
    await handlePrefsWizard(ctx, "global");
    return;
  }

  if (trimmed === "project" || trimmed === "wizard project" || trimmed === "setup project") {
    await ensurePreferencesFile(getProjectGSDPreferencesPath(), ctx, "project");
    await handlePrefsWizard(ctx, "project");
    return;
  }

  if (trimmed === "import-claude" || trimmed === "import-claude global") {
    await handleImportClaude(ctx, "global");
    return;
  }

  if (trimmed === "import-claude project") {
    await handleImportClaude(ctx, "project");
    return;
  }
  if (trimmed === "status") {
    const globalPrefs = loadGlobalGSDPreferences();
    const projectPrefs = loadProjectGSDPreferences();
    const canonicalGlobal = getGlobalGSDPreferencesPath();
    const legacyGlobal = getLegacyGlobalGSDPreferencesPath();
    const globalStatus = globalPrefs
      ? `present: ${globalPrefs.path}${globalPrefs.path === legacyGlobal ? " (legacy fallback)" : ""}`
      : `missing: ${canonicalGlobal}`;
    const projectStatus = projectPrefs ? `present: ${projectPrefs.path}` : `missing: ${getProjectGSDPreferencesPath()}`;

    const lines = [`GSD skill prefs — global ${globalStatus}; project ${projectStatus}`];

    const effective = loadEffectiveGSDPreferences();
    let hasUnresolved = false;
    if (effective) {
      const report = resolveAllSkillReferences(effective.preferences, process.cwd());
      const resolved = [...report.resolutions.values()].filter(r => r.method !== "unresolved");
      hasUnresolved = report.warnings.length > 0;
      if (resolved.length > 0 || hasUnresolved) {
        lines.push(`Skills: ${resolved.length} resolved, ${report.warnings.length} unresolved`);
      }
      if (hasUnresolved) {
        lines.push(`Unresolved: ${report.warnings.join(", ")}`);
      }
    }

    ctx.ui.notify(lines.join("\n"), hasUnresolved ? "warning" : "info");
    return;
  }

  ctx.ui.notify("Usage: /gsd prefs [global|project|status|wizard|setup|import-claude [global|project]]", "info");
}

async function handleImportClaude(ctx: ExtensionCommandContext, scope: "global" | "project"): Promise<void> {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  if (!existsSync(path)) {
    await ensurePreferencesFile(path, ctx, scope);
  }

  const readPrefs = (): Record<string, unknown> => {
    if (!existsSync(path)) return { version: 1 };
    const content = readFileSync(path, "utf-8");
    const [frontmatterLines] = splitFrontmatter(content);
    return frontmatterLines ? parseFrontmatterMap(frontmatterLines) : { version: 1 };
  };

  const writePrefs = async (prefs: Record<string, unknown>): Promise<void> => {
    prefs.version = prefs.version || 1;
    const frontmatter = serializePreferencesToFrontmatter(prefs);
    let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
    if (existsSync(path)) {
      const existingContent = readFileSync(path, "utf-8");
      const closingIdx = existingContent.indexOf("\n---", existingContent.indexOf("---"));
      if (closingIdx !== -1) {
        const afterFrontmatter = existingContent.slice(closingIdx + 4);
        if (afterFrontmatter.trim()) body = afterFrontmatter;
      }
    }
    await saveFile(path, `---\n${frontmatter}---${body}`);
  };

  await runClaudeImportFlow(ctx, scope, readPrefs, writePrefs);
}

async function handlePrefsMode(ctx: ExtensionCommandContext, scope: "global" | "project"): Promise<void> {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : {};

  await configureMode(ctx, prefs);

  // Serialize and save
  prefs.version = prefs.version || 1;
  const frontmatter = serializePreferencesToFrontmatter(prefs);

  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  if (existsSync(path)) {
    const existingContent = readFileSync(path, "utf-8");
    const closingIdx = existingContent.indexOf("\n---", existingContent.indexOf("---"));
    if (closingIdx !== -1) {
      const afterFrontmatter = existingContent.slice(closingIdx + 4);
      if (afterFrontmatter.trim()) {
        body = afterFrontmatter;
      }
    }
  }

  const content = `---\n${frontmatter}---${body}`;
  await saveFile(path, content);
  await ctx.waitForIdle();
  await ctx.reload();
  ctx.ui.notify(`Saved ${scope} preferences to ${path}`, "info");
}

async function handleDoctor(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const trimmed = args.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  const mode = parts[0] === "fix" || parts[0] === "heal" || parts[0] === "audit" ? parts[0] : "doctor";
  const requestedScope = mode === "doctor" ? parts[0] : parts[1];
  const scope = await selectDoctorScope(projectRoot(), requestedScope);
  const effectiveScope = mode === "audit" ? requestedScope : scope;
  const report = await runGSDDoctor(projectRoot(), {
    fix: mode === "fix" || mode === "heal",
    scope: effectiveScope,
  });

  const reportText = formatDoctorReport(report, {
    scope: effectiveScope,
    includeWarnings: mode === "audit",
    maxIssues: mode === "audit" ? 50 : 12,
    title: mode === "audit" ? "GSD doctor audit." : mode === "heal" ? "GSD doctor heal prep." : undefined,
  });

  ctx.ui.notify(reportText, report.ok ? "info" : "warning");

  if (mode === "heal") {
    const unresolved = filterDoctorIssues(report.issues, {
      scope: effectiveScope,
      includeWarnings: true,
    });
    const actionable = unresolved.filter(issue => issue.severity === "error" || issue.code === "all_tasks_done_missing_slice_uat" || issue.code === "slice_checked_missing_uat");
    if (actionable.length === 0) {
      ctx.ui.notify("Doctor heal found nothing actionable to hand off to the LLM.", "info");
      return;
    }

    const structuredIssues = formatDoctorIssuesForPrompt(actionable);
    dispatchDoctorHeal(pi, effectiveScope, reportText, structuredIssues);
    ctx.ui.notify(`Doctor heal dispatched ${actionable.length} issue(s) to the LLM.`, "info");
  }
}

// ─── Inspect ──────────────────────────────────────────────────────────────────

export interface InspectData {
  schemaVersion: number | null;
  counts: { decisions: number; requirements: number; artifacts: number };
  recentDecisions: Array<{ id: string; decision: string; choice: string }>;
  recentRequirements: Array<{ id: string; status: string; description: string }>;
}

export function formatInspectOutput(data: InspectData): string {
  const lines: string[] = [];
  lines.push("=== GSD Database Inspect ===");
  lines.push(`Schema version: ${data.schemaVersion ?? "unknown"}`);
  lines.push("");
  lines.push(`Decisions:    ${data.counts.decisions}`);
  lines.push(`Requirements: ${data.counts.requirements}`);
  lines.push(`Artifacts:    ${data.counts.artifacts}`);

  if (data.recentDecisions.length > 0) {
    lines.push("");
    lines.push("Recent decisions:");
    for (const d of data.recentDecisions) {
      lines.push(`  ${d.id}: ${d.decision} → ${d.choice}`);
    }
  }

  if (data.recentRequirements.length > 0) {
    lines.push("");
    lines.push("Recent requirements:");
    for (const r of data.recentRequirements) {
      lines.push(`  ${r.id} [${r.status}]: ${r.description}`);
    }
  }

  return lines.join("\n");
}

async function handleInspect(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const { isDbAvailable, _getAdapter } = await import("./gsd-db.js");

    if (!isDbAvailable()) {
      ctx.ui.notify("No GSD database available. Run /gsd auto to create one.", "info");
      return;
    }

    const adapter = _getAdapter();
    if (!adapter) {
      ctx.ui.notify("No GSD database available. Run /gsd auto to create one.", "info");
      return;
    }

    const versionRow = adapter.prepare("SELECT MAX(version) as v FROM schema_version").get();
    const schemaVersion = versionRow ? (versionRow["v"] as number | null) : null;

    const dCount = adapter.prepare("SELECT count(*) as cnt FROM decisions").get();
    const rCount = adapter.prepare("SELECT count(*) as cnt FROM requirements").get();
    const aCount = adapter.prepare("SELECT count(*) as cnt FROM artifacts").get();

    const recentDecisions = adapter
      .prepare("SELECT id, decision, choice FROM decisions ORDER BY seq DESC LIMIT 5")
      .all() as Array<{ id: string; decision: string; choice: string }>;

    const recentRequirements = adapter
      .prepare("SELECT id, status, description FROM requirements ORDER BY id DESC LIMIT 5")
      .all() as Array<{ id: string; status: string; description: string }>;

    const data: InspectData = {
      schemaVersion,
      counts: {
        decisions: (dCount?.["cnt"] as number) ?? 0,
        requirements: (rCount?.["cnt"] as number) ?? 0,
        artifacts: (aCount?.["cnt"] as number) ?? 0,
      },
      recentDecisions,
      recentRequirements,
    };

    ctx.ui.notify(formatInspectOutput(data), "info");
  } catch (err) {
    process.stderr.write(`gsd-db: /gsd inspect failed: ${err instanceof Error ? err.message : String(err)}\n`);
    ctx.ui.notify("Failed to inspect GSD database. Check stderr for details.", "error");
  }
}

// ─── Skill Health ─────────────────────────────────────────────────────────────

async function handleSkillHealth(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const {
    generateSkillHealthReport,
    formatSkillHealthReport,
    formatSkillDetail,
  } = await import("./skill-health.js");

  const basePath = projectRoot();

  // /gsd skill-health <skill-name> — detail view
  if (args && !args.startsWith("--")) {
    const detail = formatSkillDetail(basePath, args);
    ctx.ui.notify(detail, "info");
    return;
  }

  // Parse flags
  const staleMatch = args.match(/--stale\s+(\d+)/);
  const staleDays = staleMatch ? parseInt(staleMatch[1], 10) : undefined;
  const decliningOnly = args.includes("--declining");

  const report = generateSkillHealthReport(basePath, staleDays);

  if (decliningOnly) {
    if (report.decliningSkills.length === 0) {
      ctx.ui.notify("No skills flagged for declining performance.", "info");
      return;
    }
    const filtered = {
      ...report,
      skills: report.skills.filter(s => s.flagged),
    };
    ctx.ui.notify(formatSkillHealthReport(filtered), "info");
    return;
  }

  ctx.ui.notify(formatSkillHealthReport(report), "info");
}

// ─── Preferences Wizard ───────────────────────────────────────────────────────

/** Build short summary strings for each preference category. */
function buildCategorySummaries(prefs: Record<string, unknown>): Record<string, string> {
  // Mode
  const mode = prefs.mode as string | undefined;
  const modeSummary = mode ?? "(not set)";

  // Models
  const models = prefs.models as Record<string, string> | undefined;
  let modelsSummary = "(not configured)";
  if (models && Object.keys(models).length > 0) {
    const parts = Object.entries(models).map(([phase, model]) => `${phase}: ${model}`);
    modelsSummary = parts.join(", ");
  }

  // Timeouts
  const autoSup = prefs.auto_supervisor as Record<string, unknown> | undefined;
  let timeoutsSummary = "(defaults)";
  if (autoSup && Object.keys(autoSup).length > 0) {
    const soft = autoSup.soft_timeout_minutes ?? "20";
    const idle = autoSup.idle_timeout_minutes ?? "10";
    const hard = autoSup.hard_timeout_minutes ?? "30";
    timeoutsSummary = `soft: ${soft}m, idle: ${idle}m, hard: ${hard}m`;
  }

  // Git
  const git = prefs.git as Record<string, unknown> | undefined;
  let gitSummary = "(defaults)";
  if (git && Object.keys(git).length > 0) {
    const branch = git.main_branch ?? "main";
    const push = git.auto_push ? "on" : "off";
    gitSummary = `main: ${branch}, push: ${push}`;
  }

  // Skills
  const discovery = prefs.skill_discovery as string | undefined;
  const uat = prefs.uat_dispatch;
  let skillsSummary = "(not configured)";
  if (discovery || uat !== undefined) {
    const parts: string[] = [];
    if (discovery) parts.push(`discovery: ${discovery}`);
    if (uat !== undefined) parts.push(`uat: ${uat}`);
    skillsSummary = parts.join(", ");
  }

  // Budget
  const ceiling = prefs.budget_ceiling;
  const enforcement = prefs.budget_enforcement as string | undefined;
  let budgetSummary = "(no limit)";
  if (ceiling !== undefined) {
    budgetSummary = `$${ceiling}`;
    if (enforcement) budgetSummary += ` / ${enforcement}`;
  } else if (enforcement) {
    budgetSummary = enforcement;
  }

  // Notifications
  const notif = prefs.notifications as Record<string, boolean> | undefined;
  let notifSummary = "(defaults)";
  if (notif && Object.keys(notif).length > 0) {
    const allKeys = ["enabled", "on_complete", "on_error", "on_budget", "on_milestone", "on_attention"];
    const enabledCount = allKeys.filter(k => notif[k] !== false).length;
    notifSummary = `${enabledCount}/${allKeys.length} enabled`;
  }

  // Advanced
  const uniqueIds = prefs.unique_milestone_ids;
  let advancedSummary = "(defaults)";
  if (uniqueIds !== undefined) {
    advancedSummary = `unique IDs: ${uniqueIds ? "on" : "off"}`;
  }

  return {
    mode: modeSummary,
    models: modelsSummary,
    timeouts: timeoutsSummary,
    git: gitSummary,
    skills: skillsSummary,
    budget: budgetSummary,
    notifications: notifSummary,
    advanced: advancedSummary,
  };
}

// ─── Category configuration functions ────────────────────────────────────────

async function configureModels(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const modelPhases = ["research", "planning", "execution", "completion"] as const;
  const models: Record<string, string> = (prefs.models as Record<string, string>) ?? {};

  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length > 0) {
    const modelOptions = availableModels.map(m => `${m.id} · ${m.provider}`);
    modelOptions.push("(keep current)", "(clear)");

    for (const phase of modelPhases) {
      const current = models[phase] ?? "";
      const title = `Model for ${phase} phase${current ? ` (current: ${current})` : ""}:`;
      const choice = await ctx.ui.select(title, modelOptions);

      if (choice && typeof choice === "string" && choice !== "(keep current)") {
        if (choice === "(clear)") {
          delete models[phase];
        } else {
          models[phase] = choice.split(" · ")[0];
        }
      }
    }
  } else {
    for (const phase of modelPhases) {
      const current = models[phase] ?? "";
      const input = await ctx.ui.input(
        `Model for ${phase} phase${current ? ` (current: ${current})` : ""}:`,
        current || "e.g. claude-sonnet-4-20250514",
      );
      if (input !== null && input !== undefined) {
        const val = input.trim();
        if (val) {
          models[phase] = val;
        } else if (current) {
          delete models[phase];
        }
      }
    }
  }
  if (Object.keys(models).length > 0) {
    prefs.models = models;
  }
}

async function configureTimeouts(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const autoSup: Record<string, unknown> = (prefs.auto_supervisor as Record<string, unknown>) ?? {};
  const timeoutFields = [
    { key: "soft_timeout_minutes", label: "Soft timeout (minutes)", defaultVal: "20" },
    { key: "idle_timeout_minutes", label: "Idle timeout (minutes)", defaultVal: "10" },
    { key: "hard_timeout_minutes", label: "Hard timeout (minutes)", defaultVal: "30" },
  ] as const;

  for (const field of timeoutFields) {
    const current = autoSup[field.key];
    const currentStr = current !== undefined && current !== null ? String(current) : "";
    const input = await ctx.ui.input(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      currentStr || field.defaultVal,
    );
    if (input !== null && input !== undefined) {
      const val = input.trim();
      if (val && /^\d+$/.test(val)) {
        autoSup[field.key] = Number(val);
      } else if (val && !/^\d+$/.test(val)) {
        ctx.ui.notify(`Invalid value "${val}" for ${field.label} — must be a whole number. Keeping previous value.`, "warning");
      } else if (!val && currentStr) {
        delete autoSup[field.key];
      }
    }
  }
  if (Object.keys(autoSup).length > 0) {
    prefs.auto_supervisor = autoSup;
  }
}

async function configureGit(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const git: Record<string, unknown> = (prefs.git as Record<string, unknown>) ?? {};

  // main_branch
  const currentBranch = git.main_branch ? String(git.main_branch) : "";
  const branchInput = await ctx.ui.input(
    `Git main branch${currentBranch ? ` (current: ${currentBranch})` : ""}:`,
    currentBranch || "main",
  );
  if (branchInput !== null && branchInput !== undefined) {
    const val = branchInput.trim();
    if (val) {
      git.main_branch = val;
    } else if (currentBranch) {
      delete git.main_branch;
    }
  }

  // Boolean git toggles
  const gitBooleanFields = [
    { key: "auto_push", label: "Auto-push commits after committing", defaultVal: false },
    { key: "push_branches", label: "Push milestone branches to remote", defaultVal: false },
    { key: "snapshots", label: "Create WIP snapshot commits during long tasks", defaultVal: false },
  ] as const;

  for (const field of gitBooleanFields) {
    const current = git[field.key];
    const currentStr = current !== undefined ? String(current) : "";
    const choice = await ctx.ui.select(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      ["true", "false", "(keep current)"],
    );
    if (choice && choice !== "(keep current)") {
      git[field.key] = choice === "true";
    }
  }

  // remote
  const currentRemote = git.remote ? String(git.remote) : "";
  const remoteInput = await ctx.ui.input(
    `Git remote name${currentRemote ? ` (current: ${currentRemote})` : " (default: origin)"}:`,
    currentRemote || "origin",
  );
  if (remoteInput !== null && remoteInput !== undefined) {
    const val = remoteInput.trim();
    if (val && val !== "origin") {
      git.remote = val;
    } else if (!val && currentRemote) {
      delete git.remote;
    }
  }

  // pre_merge_check
  const currentPreMerge = git.pre_merge_check !== undefined ? String(git.pre_merge_check) : "";
  const preMergeChoice = await ctx.ui.select(
    `Pre-merge check${currentPreMerge ? ` (current: ${currentPreMerge})` : " (default: false)"}:`,
    ["true", "false", "auto", "(keep current)"],
  );
  if (preMergeChoice && preMergeChoice !== "(keep current)") {
    if (preMergeChoice === "auto") {
      git.pre_merge_check = "auto";
    } else {
      git.pre_merge_check = preMergeChoice === "true";
    }
  }

  // commit_type
  const currentCommitType = git.commit_type ? String(git.commit_type) : "";
  const commitTypes = ["feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci", "build", "style", "(inferred — default)", "(keep current)"];
  const commitChoice = await ctx.ui.select(
    `Default commit type${currentCommitType ? ` (current: ${currentCommitType})` : ""}:`,
    commitTypes,
  );
  if (commitChoice && typeof commitChoice === "string" && commitChoice !== "(keep current)") {
    if ((commitChoice as string).startsWith("(inferred")) {
      delete git.commit_type;
    } else {
      git.commit_type = commitChoice;
    }
  }

  // merge_strategy
  const currentMerge = git.merge_strategy ? String(git.merge_strategy) : "";
  const mergeChoice = await ctx.ui.select(
    `Merge strategy${currentMerge ? ` (current: ${currentMerge})` : ""}:`,
    ["squash", "merge", "(keep current)"],
  );
  if (mergeChoice && mergeChoice !== "(keep current)") {
    git.merge_strategy = mergeChoice;
  }

  // isolation
  const currentIsolation = git.isolation ? String(git.isolation) : "";
  const isolationChoice = await ctx.ui.select(
    `Git isolation strategy${currentIsolation ? ` (current: ${currentIsolation})` : " (default: worktree)"}:`,
    ["worktree", "branch", "none", "(keep current)"],
  );
  if (isolationChoice && isolationChoice !== "(keep current)") {
    git.isolation = isolationChoice;
  }

  // commit_docs
  const currentCommitDocs = git.commit_docs;
  const commitDocsChoice = await ctx.ui.select(
    `Track .gsd/ planning docs in git${currentCommitDocs !== undefined ? ` (current: ${currentCommitDocs})` : ""}:`,
    ["true", "false", "(keep current)"],
  );
  if (commitDocsChoice && commitDocsChoice !== "(keep current)") {
    git.commit_docs = commitDocsChoice === "true";
  }

  if (Object.keys(git).length > 0) {
    prefs.git = git;
  }
}

async function configureSkills(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  // Skill discovery mode
  const currentDiscovery = (prefs.skill_discovery as string) ?? "";
  const discoveryChoice = await ctx.ui.select(
    `Skill discovery mode${currentDiscovery ? ` (current: ${currentDiscovery})` : ""}:`,
    ["auto", "suggest", "off", "(keep current)"],
  );
  if (discoveryChoice && discoveryChoice !== "(keep current)") {
    prefs.skill_discovery = discoveryChoice;
  }

  // UAT dispatch
  const currentUat = prefs.uat_dispatch;
  const uatChoice = await ctx.ui.select(
    `UAT dispatch mode${currentUat !== undefined ? ` (current: ${currentUat})` : " (default: false)"}:`,
    ["true", "false", "(keep current)"],
  );
  if (uatChoice && uatChoice !== "(keep current)") {
    prefs.uat_dispatch = uatChoice === "true";
  }
}

async function configureBudget(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const currentCeiling = prefs.budget_ceiling;
  const ceilingStr = currentCeiling !== undefined ? String(currentCeiling) : "";
  const ceilingInput = await ctx.ui.input(
    `Budget ceiling (USD)${ceilingStr ? ` (current: $${ceilingStr})` : " (default: no limit)"}:`,
    ceilingStr || "",
  );
  if (ceilingInput !== null && ceilingInput !== undefined) {
    const val = ceilingInput.trim().replace(/^\$/, "");
    if (val && !isNaN(Number(val)) && isFinite(Number(val))) {
      prefs.budget_ceiling = Number(val);
    } else if (val && (isNaN(Number(val)) || !isFinite(Number(val)))) {
      ctx.ui.notify(`Invalid budget ceiling "${val}" — must be a number. Keeping previous value.`, "warning");
    } else if (!val && ceilingStr) {
      delete prefs.budget_ceiling;
    }
  }

  const currentEnforcement = (prefs.budget_enforcement as string) ?? "";
  const enforcementChoice = await ctx.ui.select(
    `Budget enforcement${currentEnforcement ? ` (current: ${currentEnforcement})` : " (default: pause)"}:`,
    ["warn", "pause", "halt", "(keep current)"],
  );
  if (enforcementChoice && enforcementChoice !== "(keep current)") {
    prefs.budget_enforcement = enforcementChoice;
  }

  const currentContextPause = prefs.context_pause_threshold;
  const contextPauseStr = currentContextPause !== undefined ? String(currentContextPause) : "";
  const contextPauseInput = await ctx.ui.input(
    `Context pause threshold (0-100%, 0=disabled)${contextPauseStr ? ` (current: ${contextPauseStr}%)` : " (default: 0)"}:`,
    contextPauseStr || "0",
  );
  if (contextPauseInput !== null && contextPauseInput !== undefined) {
    const val = contextPauseInput.trim().replace(/%$/, "");
    if (val && !isNaN(Number(val)) && Number(val) >= 0 && Number(val) <= 100) {
      const num = Number(val);
      if (num === 0) {
        delete prefs.context_pause_threshold;
      } else {
        prefs.context_pause_threshold = num;
      }
    } else if (val && (isNaN(Number(val)) || Number(val) < 0 || Number(val) > 100)) {
      ctx.ui.notify(`Invalid context pause threshold "${val}" — must be 0-100. Keeping previous value.`, "warning");
    }
  }
}

async function configureNotifications(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const notif: Record<string, boolean> = (prefs.notifications as Record<string, boolean>) ?? {};
  const notifFields = [
    { key: "enabled", label: "Notifications enabled (master toggle)", defaultVal: true },
    { key: "on_complete", label: "Notify on unit completion", defaultVal: true },
    { key: "on_error", label: "Notify on errors", defaultVal: true },
    { key: "on_budget", label: "Notify on budget thresholds", defaultVal: true },
    { key: "on_milestone", label: "Notify on milestone completion", defaultVal: true },
    { key: "on_attention", label: "Notify when manual attention needed", defaultVal: true },
  ] as const;

  for (const field of notifFields) {
    const current = notif[field.key];
    const currentStr = current !== undefined && typeof current === "boolean" ? String(current) : "";
    const choice = await ctx.ui.select(
      `${field.label}${currentStr ? ` (current: ${currentStr})` : ` (default: ${field.defaultVal})`}:`,
      ["true", "false", "(keep current)"],
    );
    if (choice && choice !== "(keep current)") {
      notif[field.key] = choice === "true";
    }
  }
  if (Object.keys(notif).length > 0) {
    prefs.notifications = notif;
  }
}

async function configureMode(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const currentMode = prefs.mode as string | undefined;
  const modeChoice = await ctx.ui.select(
    `Workflow mode${currentMode ? ` (current: ${currentMode})` : ""}:`,
    [
      "solo — auto-push, squash, simple IDs (personal projects)",
      "team — unique IDs, push branches, pre-merge checks (shared repos)",
      "(none) — configure everything manually",
      "(keep current)",
    ],
  );
  const modeStr = typeof modeChoice === "string" ? modeChoice : "";
  if (modeStr && modeStr !== "(keep current)") {
    if (modeStr.startsWith("solo")) {
      prefs.mode = "solo";
      ctx.ui.notify(
        "Mode: solo — defaults: auto_push=true, push_branches=false, pre_merge_check=false, merge_strategy=squash, isolation=worktree, commit_docs=true, unique_milestone_ids=false",
        "info",
      );
    } else if (modeStr.startsWith("team")) {
      prefs.mode = "team";
      ctx.ui.notify(
        "Mode: team — defaults: auto_push=false, push_branches=true, pre_merge_check=true, merge_strategy=squash, isolation=worktree, commit_docs=true, unique_milestone_ids=true",
        "info",
      );
    } else {
      delete prefs.mode;
    }
  }
}

async function configureAdvanced(ctx: ExtensionCommandContext, prefs: Record<string, unknown>): Promise<void> {
  const currentUnique = prefs.unique_milestone_ids;
  const uniqueChoice = await ctx.ui.select(
    `Unique milestone IDs${currentUnique !== undefined ? ` (current: ${currentUnique})` : ""}:`,
    ["true", "false", "(keep current)"],
  );
  if (uniqueChoice && uniqueChoice !== "(keep current)") {
    prefs.unique_milestone_ids = uniqueChoice === "true";
  }
}

// ─── Main wizard with category menu ─────────────────────────────────────────

async function handlePrefsWizard(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
): Promise<void> {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : {};

  ctx.ui.notify(`GSD preferences (${scope}) — pick a category to configure.`, "info");

  while (true) {
    const summaries = buildCategorySummaries(prefs);
    const options = [
      `Workflow Mode   ${summaries.mode}`,
      `Models          ${summaries.models}`,
      `Timeouts        ${summaries.timeouts}`,
      `Git             ${summaries.git}`,
      `Skills          ${summaries.skills}`,
      `Budget          ${summaries.budget}`,
      `Notifications   ${summaries.notifications}`,
      `Advanced        ${summaries.advanced}`,
      `── Save & Exit ──`,
    ];

    const raw = await ctx.ui.select("GSD Preferences", options);
    const choice = typeof raw === "string" ? raw : "";
    if (!choice || choice.includes("Save & Exit")) break;

    if (choice.startsWith("Workflow Mode"))      await configureMode(ctx, prefs);
    else if (choice.startsWith("Models"))        await configureModels(ctx, prefs);
    else if (choice.startsWith("Timeouts"))      await configureTimeouts(ctx, prefs);
    else if (choice.startsWith("Git"))           await configureGit(ctx, prefs);
    else if (choice.startsWith("Skills"))        await configureSkills(ctx, prefs);
    else if (choice.startsWith("Budget"))        await configureBudget(ctx, prefs);
    else if (choice.startsWith("Notifications")) await configureNotifications(ctx, prefs);
    else if (choice.startsWith("Advanced"))      await configureAdvanced(ctx, prefs);
  }

  // ─── Serialize to frontmatter ───────────────────────────────────────────
  prefs.version = prefs.version || 1;
  const frontmatter = serializePreferencesToFrontmatter(prefs);

  // Preserve existing body content (everything after closing ---)
  let body = "\n# GSD Skill Preferences\n\nSee `~/.gsd/agent/extensions/gsd/docs/preferences-reference.md` for full field documentation and examples.\n";
  if (existsSync(path)) {
    const existingContent = readFileSync(path, "utf-8");
    const closingIdx = existingContent.indexOf("\n---", existingContent.indexOf("---"));
    if (closingIdx !== -1) {
      const afterFrontmatter = existingContent.slice(closingIdx + 4); // skip past "\n---"
      if (afterFrontmatter.trim()) {
        body = afterFrontmatter;
      }
    }
  }

  const content = `---\n${frontmatter}---${body}`;

  await saveFile(path, content);
  await ctx.waitForIdle();
  await ctx.reload();
  ctx.ui.notify(`Saved ${scope} preferences to ${path}`, "info");
}

/** Wrap a YAML value in double quotes if it contains special characters. */
function yamlSafeString(val: unknown): string {
  if (typeof val !== "string") return String(val);
  if (/[:#{\[\]'"`,|>&*!?@%]/.test(val) || val.trim() !== val || val === "") {
    return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return val;
}

function serializePreferencesToFrontmatter(prefs: Record<string, unknown>): string {
  const lines: string[] = [];

  function serializeValue(key: string, value: unknown, indent: number): void {
    const prefix = "  ".repeat(indent);
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return; // Omit empty arrays — avoids parse/serialize cycle bug with "[]" strings
      }
      lines.push(`${prefix}${key}:`);
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          const entries = Object.entries(item as Record<string, unknown>);
          if (entries.length > 0) {
            const [firstKey, firstVal] = entries[0];
            lines.push(`${prefix}  - ${firstKey}: ${yamlSafeString(firstVal)}`);
            for (let i = 1; i < entries.length; i++) {
              const [k, v] = entries[i];
              if (Array.isArray(v)) {
                lines.push(`${prefix}    ${k}:`);
                for (const arrItem of v) {
                  lines.push(`${prefix}      - ${yamlSafeString(arrItem)}`);
                }
              } else {
                lines.push(`${prefix}    ${k}: ${yamlSafeString(v)}`);
              }
            }
          }
        } else {
          lines.push(`${prefix}  - ${yamlSafeString(item)}`);
        }
      }
      return;
    }

    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        return; // Omit empty objects — avoids parse/serialize cycle bug with "{}" strings
      }
      lines.push(`${prefix}${key}:`);
      for (const [k, v] of entries) {
        serializeValue(k, v, indent + 1);
      }
      return;
    }

    lines.push(`${prefix}${key}: ${yamlSafeString(value)}`);
  }

  // Ordered keys for consistent output
  const orderedKeys = [
    "version", "mode", "always_use_skills", "prefer_skills", "avoid_skills",
    "skill_rules", "custom_instructions", "models", "skill_discovery",
    "auto_supervisor", "uat_dispatch", "unique_milestone_ids",
    "budget_ceiling", "budget_enforcement", "context_pause_threshold",
    "notifications", "remote_questions", "git",
    "post_unit_hooks", "pre_dispatch_hooks",
  ];

  const seen = new Set<string>();
  for (const key of orderedKeys) {
    if (key in prefs) {
      serializeValue(key, prefs[key], 0);
      seen.add(key);
    }
  }
  // Any remaining keys not in the ordered list
  for (const [key, value] of Object.entries(prefs)) {
    if (!seen.has(key)) {
      serializeValue(key, value, 0);
    }
  }

  return lines.join("\n") + "\n";
}

// ─── Tool Config Wizard ───────────────────────────────────────────────────────

/**
 * Tool API key configurations.
 * This is the source of truth for tool credentials - used by both the config wizard
 * and session startup to load keys from auth.json into environment variables.
 */
export const TOOL_KEYS = [
  { id: "tavily",   env: "TAVILY_API_KEY",   label: "Tavily Search",     hint: "tavily.com/app/api-keys" },
  { id: "brave",    env: "BRAVE_API_KEY",     label: "Brave Search",      hint: "brave.com/search/api" },
  { id: "context7", env: "CONTEXT7_API_KEY",  label: "Context7 Docs",     hint: "context7.com/dashboard" },
  { id: "jina",     env: "JINA_API_KEY",      label: "Jina Page Extract", hint: "jina.ai/api" },
  { id: "groq",     env: "GROQ_API_KEY",      label: "Groq Voice",        hint: "console.groq.com" },
] as const;

/**
 * Load tool API keys from auth.json into environment variables.
 * Called at session startup to ensure tools have access to their credentials.
 */
export function loadToolApiKeys(): void {
  try {
    const authPath = join(process.env.HOME ?? "", ".gsd", "agent", "auth.json");
    if (!existsSync(authPath)) return;

    const auth = AuthStorage.create(authPath);
    for (const tool of TOOL_KEYS) {
      const cred = auth.get(tool.id);
      if (cred && cred.type === "api_key" && cred.key && !process.env[tool.env]) {
        process.env[tool.env] = cred.key;
      }
    }
  } catch {
    // Failed to load tool keys — ignore, they can still be set via env vars
  }
}

function getConfigAuthStorage(): AuthStorage {
  const authPath = join(process.env.HOME ?? "", ".gsd", "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true });
  return AuthStorage.create(authPath);
}

async function handleConfig(ctx: ExtensionCommandContext): Promise<void> {
  const auth = getConfigAuthStorage();

  // Show current status
  const statusLines = ["GSD Tool Configuration\n"];
  for (const tool of TOOL_KEYS) {
    const hasKey = !!process.env[tool.env] || !!(auth.get(tool.id) as { key?: string })?.key;
    statusLines.push(`  ${hasKey ? "✓" : "✗"} ${tool.label}${hasKey ? "" : ` — get key at ${tool.hint}`}`);
  }
  ctx.ui.notify(statusLines.join("\n"), "info");

  // Ask which tools to configure
  const options = TOOL_KEYS.map(t => {
    const hasKey = !!process.env[t.env] || !!(auth.get(t.id) as { key?: string })?.key;
    return `${t.label} ${hasKey ? "(configured ✓)" : "(not set)"}`;
  });
  options.push("(done)");

  let changed = false;
  while (true) {
    const choice = await ctx.ui.select("Configure which tool? Press Escape when done.", options);
    if (!choice || typeof choice !== "string" || choice === "(done)") break;

    const toolIdx = TOOL_KEYS.findIndex(t => choice.startsWith(t.label));
    if (toolIdx === -1) break;

    const tool = TOOL_KEYS[toolIdx];
    const input = await ctx.ui.input(
      `API key for ${tool.label} (${tool.hint}):`,
      "paste your key here",
    );

    if (input !== null && input !== undefined) {
      const key = input.trim();
      if (key) {
        auth.set(tool.id, { type: "api_key", key });
        process.env[tool.env] = key;
        ctx.ui.notify(`${tool.label} key saved and activated.`, "info");
        // Update option label
        options[toolIdx] = `${tool.label} (configured ✓)`;
        changed = true;
      }
    }
  }

  if (changed) {
    await ctx.waitForIdle();
    await ctx.reload();
    ctx.ui.notify("Configuration saved. Extensions reloaded with new keys.", "info");
  }
}

async function ensurePreferencesFile(
  path: string,
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
): Promise<void> {
  if (!existsSync(path)) {
    const template = await loadFile(join(dirname(fileURLToPath(import.meta.url)), "templates", "preferences.md"));
    if (!template) {
      ctx.ui.notify("Could not load GSD preferences template.", "error");
      return;
    }
    await saveFile(path, template);
    ctx.ui.notify(`Created ${scope} GSD skill preferences at ${path}`, "info");
  } else {
    ctx.ui.notify(`Using existing ${scope} GSD skill preferences at ${path}`, "info");
  }

}

// ─── Skip handler ─────────────────────────────────────────────────────────────

async function handleSkip(unitArg: string, ctx: ExtensionCommandContext, basePath: string): Promise<void> {
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

// ─── Dry-run handler ──────────────────────────────────────────────────────────

async function handleDryRun(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const state = await deriveState(basePath);

  if (!state.activeMilestone) {
    ctx.ui.notify("No active milestone — nothing to dispatch.", "info");
    return;
  }

  const { getLedger, getProjectTotals, formatCost, formatTokenCount, loadLedgerFromDisk } = await import("./metrics.js");
  const { loadEffectiveGSDPreferences: loadPrefs } = await import("./preferences.js");
  const { formatDuration } = await import("./history.js");

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

// ─── Branch cleanup handler ──────────────────────────────────────────────────

async function handleCleanupBranches(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
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

// ─── Snapshot cleanup handler ─────────────────────────────────────────────────

async function handleCleanupSnapshots(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
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

async function handleKnowledge(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.split(/\s+/);
  const typeArg = parts[0]?.toLowerCase();

  if (!typeArg || !["rule", "pattern", "lesson"].includes(typeArg)) {
    ctx.ui.notify(
      "Usage: /gsd knowledge <rule|pattern|lesson> <description>\nExample: /gsd knowledge rule Use real DB for integration tests",
      "warning",
    );
    return;
  }

  const entryText = parts.slice(1).join(" ").trim();
  if (!entryText) {
    ctx.ui.notify(`Usage: /gsd knowledge ${typeArg} <description>`, "warning");
    return;
  }

  const type = typeArg as "rule" | "pattern" | "lesson";
  const basePath = process.cwd();
  const state = await deriveState(basePath);
  const scope = state.activeMilestone?.id
    ? `${state.activeMilestone.id}${state.activeSlice ? `/${state.activeSlice.id}` : ""}`
    : "global";

  await appendKnowledge(basePath, type, entryText, scope);
  ctx.ui.notify(`Added ${type} to KNOWLEDGE.md: "${entryText}"`, "success");
}

// ─── Capture Command ──────────────────────────────────────────────────────────

/**
 * Handle `/gsd capture "..."` — fire-and-forget thought capture.
 * Appends to `.gsd/CAPTURES.md` without interrupting auto-mode.
 * Works in all modes: auto running, paused, stopped, no project.
 */
async function handleCapture(args: string, ctx: ExtensionCommandContext): Promise<void> {
  // Strip surrounding quotes from the argument
  let text = args.trim();
  if (!text) {
    ctx.ui.notify('Usage: /gsd capture "your thought here"', "warning");
    return;
  }
  // Remove wrapping quotes (single or double)
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  if (!text) {
    ctx.ui.notify('Usage: /gsd capture "your thought here"', "warning");
    return;
  }

  const basePath = process.cwd();

  // Ensure .gsd/ exists — capture should work even without a milestone
  const gsdDir = join(basePath, ".gsd");
  if (!existsSync(gsdDir)) {
    mkdirSync(gsdDir, { recursive: true });
  }

  const id = appendCapture(basePath, text);
  ctx.ui.notify(`Captured: ${id} — "${text.length > 60 ? text.slice(0, 57) + "..." : text}"`, "info");
}

// ─── Triage Command ───────────────────────────────────────────────────────────

/**
 * Handle `/gsd triage` — manually trigger triage of pending captures.
 * Dispatches the triage prompt to the LLM for classification.
 * Triage result handling (confirmation UI) is wired in T03.
 */
async function handleTriage(ctx: ExtensionCommandContext, pi: ExtensionAPI, basePath: string): Promise<void> {
  if (!hasPendingCaptures(basePath)) {
    ctx.ui.notify("No pending captures to triage.", "info");
    return;
  }

  const pending = loadPendingCaptures(basePath);
  ctx.ui.notify(`Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`, "info");

  // Build context for the triage prompt
  const state = await deriveState(basePath);
  let currentPlan = "";
  let roadmapContext = "";

  if (state.activeMilestone && state.activeSlice) {
    const { resolveSliceFile, resolveMilestoneFile } = await import("./paths.js");
    const planFile = resolveSliceFile(basePath, state.activeMilestone.id, state.activeSlice.id, "PLAN");
    if (planFile) {
      const { loadFile: load } = await import("./files.js");
      currentPlan = (await load(planFile)) ?? "";
    }
    const roadmapFile = resolveMilestoneFile(basePath, state.activeMilestone.id, "ROADMAP");
    if (roadmapFile) {
      const { loadFile: load } = await import("./files.js");
      roadmapContext = (await load(roadmapFile)) ?? "";
    }
  }

  // Format pending captures for the prompt
  const capturesList = pending.map(c =>
    `- **${c.id}**: "${c.text}" (captured: ${c.timestamp})`
  ).join("\n");

  // Dispatch triage prompt
  const { loadPrompt } = await import("./prompt-loader.js");
  const prompt = loadPrompt("triage-captures", {
    pendingCaptures: capturesList,
    currentPlan: currentPlan || "(no active slice plan)",
    roadmapContext: roadmapContext || "(no active roadmap)",
  });

  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(process.env.HOME ?? "~", ".pi", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");

  pi.sendMessage(
    {
      customType: "gsd-triage",
      content: `Read the following GSD workflow protocol and execute exactly.\n\n${workflow}\n\n## Your Task\n\n${prompt}`,
      display: false,
    },
    { triggerTurn: true },
  );
}

async function handleSteer(change: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const basePath = process.cwd();
  const state = await deriveState(basePath);
  const mid = state.activeMilestone?.id ?? "none";
  const sid = state.activeSlice?.id ?? "none";
  const tid = state.activeTask?.id ?? "none";
  const appliedAt = `${mid}/${sid}/${tid}`;
  await appendOverride(basePath, change, appliedAt);

  if (isAutoActive()) {
    pi.sendMessage({
      customType: "gsd-hard-steer",
      content: [
        "HARD STEER — User override registered.",
        "",
        `**Override:** ${change}`,
        "",
        "This override has been saved to `.gsd/OVERRIDES.md` and will be injected into all future task prompts.",
        "A document rewrite unit will run before the next task to propagate this change across all active plan documents.",
        "",
        "If you are mid-task, finish your current work respecting this override. The next dispatched unit will be a document rewrite.",
      ].join("\n"),
      display: false,
    }, { triggerTurn: true });
    ctx.ui.notify(`Override registered: "${change}". Will be applied before next task dispatch.`, "info");
  } else {
    pi.sendMessage({
      customType: "gsd-hard-steer",
      content: [
        "HARD STEER — User override registered.",
        "",
        `**Override:** ${change}`,
        "",
        "This override has been saved to `.gsd/OVERRIDES.md`.",
        "Before continuing, read `.gsd/OVERRIDES.md` and update the current plan documents to reflect this change.",
        "Focus on: active slice plan, incomplete task plans, and DECISIONS.md.",
      ].join("\n"),
      display: false,
    }, { triggerTurn: true });
    ctx.ui.notify(`Override registered: "${change}". Update plan documents to reflect this change.`, "info");
  }
}

async function handleRunHook(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 3) {
    ctx.ui.notify(`Usage: /gsd run-hook <hook-name> <unit-type> <unit-id>

Unit types:
  execute-task   - Task execution (unit-id: M001/S01/T01)
  plan-slice     - Slice planning (unit-id: M001/S01)
  research-milestone - Milestone research (unit-id: M001)
  complete-slice - Slice completion (unit-id: M001/S01)
  complete-milestone - Milestone completion (unit-id: M001)

Examples:
  /gsd run-hook code-review execute-task M001/S01/T01
  /gsd run-hook lint-check plan-slice M001/S01`, "warning");
    return;
  }

  const [hookName, unitType, unitId] = parts;
  const basePath = projectRoot();

  // Import the hook trigger function
  const { triggerHookManually, formatHookStatus, getHookStatus } = await import("./post-unit-hooks.js");
  const { dispatchHookUnit } = await import("./auto.js");
  
  // Check if the hook exists
  const hooks = getHookStatus();
  const hookExists = hooks.some(h => h.name === hookName);
  if (!hookExists) {
    ctx.ui.notify(`Hook "${hookName}" not found. Configured hooks:\n${formatHookStatus()}`, "error");
    return;
  }

  // Validate unit ID format
  const unitIdPattern = /^M\d{3}\/S\d{2,3}\/T\d{2,3}$/;
  if (!unitIdPattern.test(unitId)) {
    ctx.ui.notify(`Invalid unit ID format: "${unitId}". Expected format: M004/S04/T03`, "warning");
    return;
  }

  // Trigger the hook manually
  const hookUnit = triggerHookManually(hookName, unitType, unitId, basePath);
  if (!hookUnit) {
    ctx.ui.notify(`Failed to trigger hook "${hookName}". The hook may be disabled or not configured for unit type "${unitType}".`, "error");
    return;
  }

  ctx.ui.notify(`Manually triggering hook: ${hookName} for ${unitType} ${unitId}`, "info");

  // Dispatch the hook unit directly, bypassing normal pre-dispatch hooks
  const success = await dispatchHookUnit(
    ctx,
    pi,
    hookName,
    unitType,
    unitId,
    hookUnit.prompt,
    hookUnit.model,
    basePath,
  );

  if (!success) {
    ctx.ui.notify("Failed to dispatch hook. Auto-mode may have been cancelled.", "error");
  }
}
