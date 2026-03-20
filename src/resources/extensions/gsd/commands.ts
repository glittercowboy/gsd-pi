/**
 * GSD Command — /gsd
 *
 * One command, one wizard. Routes to smart entry or status.
 */

import { importExtensionModule, type ExtensionAPI, type ExtensionCommandContext } from "@gsd/pi-coding-agent";
import type { GSDState } from "./types.js";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gsdRoot } from "./paths.js";

const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
import { enableDebug } from "./debug-logger.js";
import { deriveState } from "./state.js";
import { GSDDashboardOverlay } from "./dashboard-overlay.js";
import { GSDVisualizerOverlay } from "./visualizer-overlay.js";
import { showQueue, showDiscuss, showHeadlessMilestoneCreation } from "./guided-flow.js";
import { startAuto, stopAuto, pauseAuto, isAutoActive, isAutoPaused, isStepMode, stopAutoRemote, checkRemoteAutoSession } from "./auto.js";
import { dispatchDirectPhase } from "./auto-direct-dispatch.js";
import { resolveProjectRoot } from "./worktree.js";
import { assertSafeDirectory } from "./validate-directory.js";
import {
  getGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  loadEffectiveGSDPreferences,
} from "./preferences.js";
import { handleRemote } from "../remote-questions/mod.js";
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

// ─── Imports from extracted modules ──────────────────────────────────────────
import { handlePrefs, handlePrefsMode, handlePrefsWizard, ensurePreferencesFile } from "./commands-prefs-wizard.js";
import { handleConfig } from "./commands-config.js";
import { handleInspect } from "./commands-inspect.js";
import { handleCleanupBranches, handleCleanupSnapshots, handleSkip, handleDryRun } from "./commands-maintenance.js";
import { handleDoctor, handleSteer, handleCapture, handleTriage, handleKnowledge, handleRunHook, handleUpdate, handleSkillHealth } from "./commands-handlers.js";
import { computeProgressScore, formatProgressLine } from "./progress-score.js";
import { runEnvironmentChecks } from "./doctor-environment.js";
import { handleLogs } from "./commands-logs.js";
import { handleStart, handleTemplates, getTemplateCompletions } from "./commands-workflow-templates.js";
import { readSessionLockData, isSessionLockProcessAlive } from "./session-lock.js";
import { handleCmux } from "./commands-cmux.js";
import { showNextAction } from "../shared/mod.js";


/** Resolve the effective project root, accounting for worktree paths. */
export function projectRoot(): string {
  const cwd = process.cwd();
  const root = resolveProjectRoot(cwd);

  // When running inside a GSD worktree, the resolved root may be a "dangerous"
  // directory (e.g., $HOME used as a git repo root — #1317). The safety check
  // should validate the actual working directory, not the upstream root,
  // because the worktree itself is a safe project subdirectory.
  // Only skip the root check when we can confirm we're in a valid worktree.
  if (root !== cwd) {
    // We're in a worktree — validate the worktree path instead of the root
    assertSafeDirectory(cwd);
  } else {
    assertSafeDirectory(root);
  }
  return root;
}

/**
 * Guard against starting auto-mode when a remote session is already running.
 * Returns true if the caller should proceed with startAuto, false if handled.
 */
async function guardRemoteSession(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<boolean> {
  // Local session already active — proceed (startAuto handles re-entrant calls)
  if (isAutoActive() || isAutoPaused()) return true;

  const remote = checkRemoteAutoSession(projectRoot());
  if (!remote.running || !remote.pid) return true;

  const unitLabel = remote.unitType && remote.unitId
    ? `${remote.unitType} (${remote.unitId})`
    : "unknown unit";
  const unitsMsg = remote.completedUnits != null
    ? `${remote.completedUnits} units completed`
    : "";

  const choice = await showNextAction(ctx, {
    title: `Auto-mode is running in another terminal (PID ${remote.pid})`,
    summary: [
      `Currently executing: ${unitLabel}`,
      ...(unitsMsg ? [unitsMsg] : []),
      ...(remote.startedAt ? [`Started: ${remote.startedAt}`] : []),
    ],
    actions: [
      {
        id: "status",
        label: "View status",
        description: "Show the current GSD progress dashboard.",
        recommended: true,
      },
      {
        id: "steer",
        label: "Steer the session",
        description: "Use /gsd steer <instruction> to redirect the running session.",
      },
      {
        id: "stop",
        label: "Stop remote session",
        description: `Send SIGTERM to PID ${remote.pid} to stop it gracefully.`,
      },
      {
        id: "force",
        label: "Force start (steal lock)",
        description: "Start a new session, terminating the existing one.",
      },
    ],
    notYetMessage: "Run /gsd when ready.",
  });

  if (choice === "status") {
    await handleStatus(ctx);
    return false;
  }
  if (choice === "steer") {
    ctx.ui.notify(
      "Use /gsd steer <instruction> to redirect the running auto-mode session.\n" +
      "Example: /gsd steer Use Postgres instead of SQLite",
      "info",
    );
    return false;
  }
  if (choice === "stop") {
    const result = stopAutoRemote(projectRoot());
    if (result.found) {
      ctx.ui.notify(`Sent stop signal to auto-mode session (PID ${result.pid}). It will shut down gracefully.`, "info");
    } else if (result.error) {
      ctx.ui.notify(`Failed to stop remote auto-mode: ${result.error}`, "error");
    } else {
      ctx.ui.notify("Remote session is no longer running.", "info");
    }
    return false;
  }
  if (choice === "force") {
    return true; // Proceed — startAuto will steal the lock
  }

  // "not_yet" or escape
  return false;
}

export function registerGSDCommand(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description: "GSD — Get Shit Done: /gsd help|start|templates|next|auto|stop|pause|status|widget|visualize|queue|quick|capture|triage|dispatch|history|undo|rate|skip|export|cleanup|mode|prefs|config|keys|hooks|run-hook|skill-health|doctor|logs|forensics|changelog|migrate|remote|steer|knowledge|new-milestone|parallel|cmux|park|unpark|init|setup|inspect|extensions|update",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { cmd: "help", desc: "Categorized command reference with descriptions" },
        { cmd: "next", desc: "Explicit step mode (same as /gsd)" },
        { cmd: "auto", desc: "Autonomous mode — research, plan, execute, commit, repeat" },
        { cmd: "stop", desc: "Stop auto mode gracefully" },
        { cmd: "pause", desc: "Pause auto-mode (preserves state, /gsd auto to resume)" },
        { cmd: "status", desc: "Progress dashboard" },
        { cmd: "widget", desc: "Cycle widget: full → small → min → off" },
        { cmd: "visualize", desc: "Open 10-tab workflow visualizer (progress, timeline, deps, metrics, health, agent, changes, knowledge, captures, export)" },
        { cmd: "queue", desc: "Queue and reorder future milestones" },
        { cmd: "quick", desc: "Execute a quick task without full planning overhead" },
        { cmd: "discuss", desc: "Discuss architecture and decisions" },
        { cmd: "capture", desc: "Fire-and-forget thought capture" },
        { cmd: "changelog", desc: "Show categorized release notes" },
        { cmd: "triage", desc: "Manually trigger triage of pending captures" },
        { cmd: "dispatch", desc: "Dispatch a specific phase directly" },
        { cmd: "history", desc: "View execution history" },
        { cmd: "rate", desc: "Rate last unit's model tier (over/ok/under) — improves adaptive routing" },
        { cmd: "undo", desc: "Revert last completed unit" },
        { cmd: "skip", desc: "Prevent a unit from auto-mode dispatch" },
        { cmd: "export", desc: "Export milestone/slice results" },
        { cmd: "cleanup", desc: "Remove merged branches or snapshots" },
        { cmd: "mode", desc: "Switch workflow mode (solo/team)" },
        { cmd: "prefs", desc: "Manage preferences (model selection, timeouts, etc.)" },
        { cmd: "config", desc: "Set API keys for external tools" },
        { cmd: "keys", desc: "API key manager — list, add, remove, test, rotate, doctor" },
        { cmd: "hooks", desc: "Show configured post-unit and pre-dispatch hooks" },
        { cmd: "run-hook", desc: "Manually trigger a specific hook" },
        { cmd: "skill-health", desc: "Skill lifecycle dashboard" },
        { cmd: "doctor", desc: "Runtime health checks with auto-fix" },
        { cmd: "logs", desc: "Browse activity logs, debug logs, and metrics" },
        { cmd: "forensics", desc: "Examine execution logs" },
        { cmd: "init", desc: "Project init wizard — detect, configure, bootstrap .gsd/" },
        { cmd: "setup", desc: "Global setup status and configuration" },
        { cmd: "migrate", desc: "Migrate a v1 .planning directory to .gsd format" },
        { cmd: "remote", desc: "Control remote auto-mode" },
        { cmd: "steer", desc: "Hard-steer plan documents during execution" },
        { cmd: "inspect", desc: "Show SQLite DB diagnostics" },
        { cmd: "knowledge", desc: "Add persistent project knowledge (rule, pattern, or lesson)" },
        { cmd: "new-milestone", desc: "Create a milestone from a specification document (headless)" },
        { cmd: "parallel", desc: "Parallel milestone orchestration (start, status, stop, merge)" },
        { cmd: "cmux", desc: "Manage cmux integration (status, sidebar, notifications, splits)" },
        { cmd: "park", desc: "Park a milestone — skip without deleting" },
        { cmd: "unpark", desc: "Reactivate a parked milestone" },
        { cmd: "update", desc: "Update GSD to the latest version" },
        { cmd: "start", desc: "Start a workflow template (bugfix, spike, feature, etc.)" },
        { cmd: "templates", desc: "List available workflow templates" },
        { cmd: "extensions", desc: "Manage extensions (list, enable, disable, info)" },
      ];
      const hasTrailingSpace = prefix.endsWith(" ");
      const parts = prefix.trim().split(/\s+/);
      if (hasTrailingSpace && parts.length >= 1) {
        parts.push("");
      }

      if (parts.length <= 1) {
        return subcommands
          .filter((item) => item.cmd.startsWith(parts[0] ?? ""))
          .map((item) => ({
            value: item.cmd,
            label: item.cmd,
            description: item.desc
          }));
      }

      if (parts[0] === "auto" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        const flags = [
          { flag: "--verbose", desc: "Show detailed execution output" },
          { flag: "--debug", desc: "Enable debug logging" },
        ];
        return flags
          .filter((f) => f.flag.startsWith(flagPrefix))
          .map((f) => ({ value: `auto ${f.flag}`, label: f.flag, description: f.desc }));
      }

      if (parts[0] === "mode" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const modes = [
          { cmd: "global", desc: "Edit global workflow mode" },
          { cmd: "project", desc: "Edit project-specific workflow mode" },
        ];
        return modes
          .filter((m) => m.cmd.startsWith(subPrefix))
          .map((m) => ({ value: `mode ${m.cmd}`, label: m.cmd, description: m.desc }));
      }

      if (parts[0] === "parallel" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "start", desc: "Start parallel milestone orchestration" },
          { cmd: "status", desc: "Show parallel worker statuses" },
          { cmd: "stop", desc: "Stop all parallel workers" },
          { cmd: "pause", desc: "Pause a specific worker" },
          { cmd: "resume", desc: "Resume a paused worker" },
          { cmd: "merge", desc: "Merge completed milestone branches" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `parallel ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "cmux") {
        if (parts.length <= 2) {
          const subPrefix = parts[1] ?? "";
          const subs = [
            { cmd: "status", desc: "Show cmux detection, prefs, and capabilities" },
            { cmd: "on", desc: "Enable cmux integration" },
            { cmd: "off", desc: "Disable cmux integration" },
            { cmd: "notifications", desc: "Toggle cmux desktop notifications" },
            { cmd: "sidebar", desc: "Toggle cmux sidebar metadata" },
            { cmd: "splits", desc: "Toggle cmux visual subagent splits" },
            { cmd: "browser", desc: "Toggle future browser integration flag" },
          ];
          return subs
            .filter((s) => s.cmd.startsWith(subPrefix))
            .map((s) => ({ value: `cmux ${s.cmd}`, label: s.cmd, description: s.desc }));
        }

        if (parts.length <= 3 && ["notifications", "sidebar", "splits", "browser"].includes(parts[1])) {
          const togglePrefix = parts[2] ?? "";
          return [
            { cmd: "on", desc: "Enable this cmux area" },
            { cmd: "off", desc: "Disable this cmux area" },
          ]
            .filter((item) => item.cmd.startsWith(togglePrefix))
            .map((item) => ({
              value: `cmux ${parts[1]} ${item.cmd}`,
              label: item.cmd,
              description: item.desc,
            }));
        }
      }

      if (parts[0] === "setup" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "llm", desc: "Configure LLM provider settings" },
          { cmd: "search", desc: "Configure web search provider" },
          { cmd: "remote", desc: "Configure remote integrations" },
          { cmd: "keys", desc: "Manage API keys" },
          { cmd: "prefs", desc: "Configure global preferences" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `setup ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "logs" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "debug", desc: "List or view debug log files" },
          { cmd: "tail", desc: "Show last N activity log summaries" },
          { cmd: "clear", desc: "Remove old activity and debug logs" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `logs ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "keys" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "list", desc: "Show key status dashboard" },
          { cmd: "add", desc: "Add a key for a provider" },
          { cmd: "remove", desc: "Remove a key" },
          { cmd: "test", desc: "Validate key(s) with API call" },
          { cmd: "rotate", desc: "Replace an existing key" },
          { cmd: "doctor", desc: "Health check all keys" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `keys ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "prefs" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "global", desc: "Edit global preferences file" },
          { cmd: "project", desc: "Edit project preferences file" },
          { cmd: "status", desc: "Show effective preferences" },
          { cmd: "wizard", desc: "Interactive preferences wizard" },
          { cmd: "setup", desc: "First-time preferences setup" },
          { cmd: "import-claude", desc: "Import settings from Claude Code" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `prefs ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "remote" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "slack", desc: "Configure Slack integration" },
          { cmd: "discord", desc: "Configure Discord integration" },
          { cmd: "status", desc: "Show remote connection status" },
          { cmd: "disconnect", desc: "Disconnect remote integrations" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `remote ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "next" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        const flags = [
          { flag: "--verbose", desc: "Show detailed step output" },
          { flag: "--dry-run", desc: "Preview next step without executing" },
        ];
        return flags
          .filter((f) => f.flag.startsWith(flagPrefix))
          .map((f) => ({ value: `next ${f.flag}`, label: f.flag, description: f.desc }));
      }

      if (parts[0] === "history" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        const flags = [
          { flag: "--cost", desc: "Show cost breakdown per entry" },
          { flag: "--phase", desc: "Filter by phase type" },
          { flag: "--model", desc: "Filter by model used" },
          { flag: "10", desc: "Show last 10 entries" },
          { flag: "20", desc: "Show last 20 entries" },
          { flag: "50", desc: "Show last 50 entries" },
        ];
        return flags
          .filter((f) => f.flag.startsWith(flagPrefix))
          .map((f) => ({ value: `history ${f.flag}`, label: f.flag, description: f.desc }));
      }

      if (parts[0] === "undo" && parts.length <= 2) {
        return [{ value: "undo --force", label: "--force", description: "Skip confirmation prompt" }];
      }

      if (parts[0] === "export" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        const flags = [
          { flag: "--json", desc: "Export as JSON" },
          { flag: "--markdown", desc: "Export as Markdown" },
          { flag: "--html", desc: "Export as HTML" },
          { flag: "--html --all", desc: "Export all milestones as HTML" },
        ];
        return flags
          .filter((f) => f.flag.startsWith(flagPrefix))
          .map((f) => ({ value: `export ${f.flag}`, label: f.flag, description: f.desc }));
      }

      if (parts[0] === "cleanup" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "branches", desc: "Remove merged milestone branches" },
          { cmd: "snapshots", desc: "Remove old execution snapshots" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `cleanup ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "knowledge" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "rule", desc: "Add a project rule (always/never do X)" },
          { cmd: "pattern", desc: "Add a code pattern to follow" },
          { cmd: "lesson", desc: "Record a lesson learned" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `knowledge ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "start" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "bugfix", desc: "Triage, fix, test, and ship a bug fix" },
          { cmd: "small-feature", desc: "Lightweight feature with optional discussion" },
          { cmd: "spike", desc: "Research, prototype, and document findings" },
          { cmd: "hotfix", desc: "Minimal: fix it, test it, ship it" },
          { cmd: "refactor", desc: "Inventory, plan waves, migrate, verify" },
          { cmd: "security-audit", desc: "Scan, triage, remediate, re-scan" },
          { cmd: "dep-upgrade", desc: "Assess, upgrade, fix breaks, verify" },
          { cmd: "full-project", desc: "Complete GSD workflow with full ceremony" },
          { cmd: "resume", desc: "Resume an in-progress workflow" },
          { cmd: "--list", desc: "List all available templates" },
          { cmd: "--dry-run", desc: "Preview workflow without executing" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `start ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "templates" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        const subs = [
          { cmd: "info", desc: "Show detailed template info" },
        ];
        return subs
          .filter((s) => s.cmd.startsWith(subPrefix))
          .map((s) => ({ value: `templates ${s.cmd}`, label: s.cmd, description: s.desc }));
      }

      if (parts[0] === "templates" && parts[1] === "info" && parts.length <= 3) {
        const namePrefix = parts[2] ?? "";
        return getTemplateCompletions(namePrefix)
          .map((c) => ({ value: `templates ${c.value}`, label: c.label, description: c.description }));
      }

      if (parts[0] === "extensions") {
        if (parts.length <= 2) {
          const subPrefix = parts[1] ?? "";
          const subs = [
            { cmd: "list", desc: "List all extensions and their status" },
            { cmd: "enable", desc: "Enable a disabled extension" },
            { cmd: "disable", desc: "Disable an extension" },
            { cmd: "info", desc: "Show extension details" },
          ];
          return subs
            .filter((s) => s.cmd.startsWith(subPrefix))
            .map((s) => ({ value: `extensions ${s.cmd}`, label: s.cmd, description: s.desc }));
        }
        if (parts.length === 3 && ["enable", "disable", "info"].includes(parts[1])) {
          const idPrefix = parts[2] ?? "";
          try {
            const extDir = join(gsdHome, "agent", "extensions");
            const ids: { id: string; name: string }[] = [];
            for (const entry of readdirSync(extDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              const mPath = join(extDir, entry.name, "extension-manifest.json");
              if (!existsSync(mPath)) continue;
              try {
                const m = JSON.parse(readFileSync(mPath, "utf-8"));
                if (typeof m?.id === "string") ids.push({ id: m.id, name: m.name ?? m.id });
              } catch { /* skip malformed */ }
            }
            return ids
              .filter((e) => e.id.startsWith(idPrefix))
              .map((e) => ({
                value: `extensions ${parts[1]} ${e.id}`,
                label: e.id,
                description: e.name,
              }));
          } catch {
            return [];
          }
        }
        return [];
      }

      if (parts[0] === "doctor") {
        const modePrefix = parts[1] ?? "";
        const modes = [
          { cmd: "fix", desc: "Auto-fix detected issues" },
          { cmd: "heal", desc: "AI-driven deep healing" },
          { cmd: "audit", desc: "Run health audit without fixing" },
          { cmd: "--dry-run", desc: "Show what --fix would change without applying" },
          { cmd: "--json", desc: "Output report as JSON (CI/tooling friendly)" },
          { cmd: "--build", desc: "Include slow build health check (npm run build)" },
          { cmd: "--test", desc: "Include slow test health check (npm test)" },
        ];

        if (parts.length <= 2) {
          return modes
            .filter((m) => m.cmd.startsWith(modePrefix))
            .map((m) => ({ value: `doctor ${m.cmd}`, label: m.cmd, description: m.desc }));
        }

        return [];
      }

      if (parts[0] === "dispatch" && parts.length <= 2) {
        const phasePrefix = parts[1] ?? "";
        const phases = [
          { cmd: "research", desc: "Run research phase" },
          { cmd: "plan", desc: "Run planning phase" },
          { cmd: "execute", desc: "Run execution phase" },
          { cmd: "complete", desc: "Run completion phase" },
          { cmd: "reassess", desc: "Reassess current progress" },
          { cmd: "uat", desc: "Run user acceptance testing" },
          { cmd: "replan", desc: "Replan the current slice" },
        ];
        return phases
          .filter((p) => p.cmd.startsWith(phasePrefix))
          .map((p) => ({ value: `dispatch ${p.cmd}`, label: p.cmd, description: p.desc }));
      }

      if (parts[0] === "rate" && parts.length <= 2) {
        const tierPrefix = parts[1] ?? "";
        const tiers = [
          { cmd: "over", desc: "Model was overqualified for this task" },
          { cmd: "ok", desc: "Model was appropriate for this task" },
          { cmd: "under", desc: "Model was underqualified for this task" },
        ];
        return tiers
          .filter((t) => t.cmd.startsWith(tierPrefix))
          .map((t) => ({ value: `rate ${t.cmd}`, label: t.cmd, description: t.desc }));
      }

      return [];
    },

    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleGSDCommand(args, ctx, pi);
    },
  });
}

export async function handleGSDCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const trimmed = (typeof args === "string" ? args : "").trim();

  if (trimmed === "help" || trimmed === "h" || trimmed === "?") {
    showHelp(ctx);
    return;
  }

  if (trimmed === "status") {
    await handleStatus(ctx);
    return;
  }

  if (trimmed === "widget" || trimmed.startsWith("widget ")) {
    const { cycleWidgetMode, setWidgetMode, getWidgetMode } = await importExtensionModule<typeof import("./auto-dashboard.js")>(import.meta.url, "./auto-dashboard.js");
    const arg = trimmed.replace(/^widget\s*/, "").trim();
    if (arg === "full" || arg === "small" || arg === "min" || arg === "off") {
      setWidgetMode(arg);
    } else {
      cycleWidgetMode();
    }
    ctx.ui.notify(`Widget: ${getWidgetMode()}`, "info");
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

  if (trimmed === "cmux" || trimmed.startsWith("cmux ")) {
    await handleCmux(trimmed.replace(/^cmux\s*/, "").trim(), ctx);
    return;
  }

      if (trimmed === "init") {
        const { detectProjectState } = await import("./detection.js");
        const { showProjectInit, handleReinit } = await import("./init-wizard.js");
        const basePath = projectRoot();
        const detection = detectProjectState(basePath);
        if (detection.state === "v2-gsd" || detection.state === "v2-gsd-empty") {
          await handleReinit(ctx, detection);
        } else {
          await showProjectInit(ctx, pi, basePath, detection);
        }
        return;
      }

      if (trimmed === "keys" || trimmed.startsWith("keys ")) {
        const { handleKeys } = await import("./key-manager.js");
        const keysArgs = trimmed.replace(/^keys\s*/, "").trim();
        await handleKeys(keysArgs, ctx);
        return;
      }

      if (trimmed === "setup" || trimmed.startsWith("setup ")) {
        const setupArgs = trimmed.replace(/^setup\s*/, "").trim();
        await handleSetup(setupArgs, ctx);
        return;
      }

      if (trimmed === "doctor" || trimmed.startsWith("doctor ")) {
        await handleDoctor(trimmed.replace(/^doctor\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "logs" || trimmed.startsWith("logs ")) {
        await handleLogs(trimmed.replace(/^logs\s*/, "").trim(), ctx);
        return;
      }

      if (trimmed === "forensics" || trimmed.startsWith("forensics ")) {
        const { handleForensics } = await import("./forensics.js");
        await handleForensics(trimmed.replace(/^forensics\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "changelog" || trimmed.startsWith("changelog ")) {
        const { handleChangelog } = await import("./changelog.js");
        await handleChangelog(trimmed.replace(/^changelog\s*/, "").trim(), ctx, pi);
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
        if (!(await guardRemoteSession(ctx, pi))) return;
        await startAuto(ctx, pi, projectRoot(), verboseMode, { step: true });
        return;
      }

      if (trimmed === "auto" || trimmed.startsWith("auto ")) {
        const verboseMode = trimmed.includes("--verbose");
        const debugMode = trimmed.includes("--debug");
        if (debugMode) enableDebug(projectRoot());
        if (!(await guardRemoteSession(ctx, pi))) return;
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
        await stopAuto(ctx, pi, "User requested stop");
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

      if (trimmed === "rate" || trimmed.startsWith("rate ")) {
        const { handleRate } = await import("./commands-rate.js");
        await handleRate(trimmed.replace(/^rate\s*/, "").trim(), ctx, projectRoot());
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

      if (trimmed === "park" || trimmed.startsWith("park ")) {
        const basePath = projectRoot();
        const arg = trimmed.replace(/^park\s*/, "").trim();
        const { parkMilestone, isParked } = await import("./milestone-actions.js");
        const { deriveState } = await import("./state.js");

        let targetId = arg;
        if (!targetId) {
          // Park the current active milestone
          const state = await deriveState(basePath);
          if (!state.activeMilestone) {
            ctx.ui.notify("No active milestone to park.", "warning");
            return;
          }
          targetId = state.activeMilestone.id;
        }

        if (isParked(basePath, targetId)) {
          ctx.ui.notify(`${targetId} is already parked. Use /gsd unpark ${targetId} to reactivate.`, "info");
          return;
        }

        // Extract reason from remaining args (e.g., /gsd park M002 "reason here")
        const reasonParts = arg.replace(targetId, "").trim().replace(/^["']|["']$/g, "");
        const reason = reasonParts || "Parked via /gsd park";

        const success = parkMilestone(basePath, targetId, reason);
        if (success) {
          ctx.ui.notify(`Parked ${targetId}. Run /gsd unpark ${targetId} to reactivate.`, "info");
        } else {
          ctx.ui.notify(`Could not park ${targetId} — milestone not found.`, "warning");
        }
        return;
      }

      if (trimmed === "unpark" || trimmed.startsWith("unpark ")) {
        const basePath = projectRoot();
        const arg = trimmed.replace(/^unpark\s*/, "").trim();
        const { unparkMilestone } = await import("./milestone-actions.js");
        const { deriveState } = await import("./state.js");

        let targetId = arg;
        if (!targetId) {
          // List parked milestones and let user pick
          const state = await deriveState(basePath);
          const parkedEntries = state.registry.filter(e => e.status === "parked");
          if (parkedEntries.length === 0) {
            ctx.ui.notify("No parked milestones.", "info");
            return;
          }
          if (parkedEntries.length === 1) {
            targetId = parkedEntries[0].id;
          } else {
            ctx.ui.notify(`Parked milestones: ${parkedEntries.map(e => e.id).join(", ")}. Specify which to unpark: /gsd unpark <id>`, "info");
            return;
          }
        }

        const success = unparkMilestone(basePath, targetId);
        if (success) {
          ctx.ui.notify(`Unparked ${targetId}. It will resume its normal position in the queue.`, "info");
        } else {
          ctx.ui.notify(`Could not unpark ${targetId} — milestone not found or not parked.`, "warning");
        }
        return;
      }

      if (trimmed === "new-milestone") {
        const basePath = projectRoot();
        const headlessContextPath = join(gsdRoot(basePath), "runtime", "headless-context.md");
        if (existsSync(headlessContextPath)) {
          const seedContext = readFileSync(headlessContextPath, "utf-8");
          try { unlinkSync(headlessContextPath); } catch { /* non-fatal */ }
          await showHeadlessMilestoneCreation(ctx, pi, basePath, seedContext);
        } else {
          // No headless context — fall back to interactive smart entry
          const { showSmartEntry } = await import("./guided-flow.js");
          await showSmartEntry(ctx, pi, basePath);
        }
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

      if (trimmed === "update") {
        await handleUpdate(ctx);
        return;
      }

      // ─── Workflow Templates ────────────────────────────────────────
      if (trimmed === "start" || trimmed.startsWith("start ")) {
        await handleStart(trimmed.replace(/^start\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "templates" || trimmed.startsWith("templates ")) {
        await handleTemplates(trimmed.replace(/^templates\s*/, "").trim(), ctx);
        return;
      }

      if (trimmed === "") {
        if (!(await guardRemoteSession(ctx, pi))) return;
        await startAuto(ctx, pi, projectRoot(), false, { step: true });
        return;
      }

      if (trimmed === "extensions" || trimmed.startsWith("extensions ")) {
        const { handleExtensions } = await import("./commands-extensions.js");
        await handleExtensions(trimmed.replace(/^extensions\s*/, "").trim(), ctx);
        return;
      }

  ctx.ui.notify(
    `Unknown: /gsd ${trimmed}. Run /gsd help for available commands.`,
    "warning",
  );
}

function showHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "GSD — Get Shit Done\n",
    "WORKFLOW",
    "  /gsd start <tpl>   Start a workflow template (bugfix, spike, feature, hotfix, etc.)",
    "  /gsd templates     List available workflow templates  [info <name>]",
    "  /gsd               Run next unit in step mode (same as /gsd next)",
    "  /gsd next           Execute next task, then pause  [--dry-run] [--verbose]",
    "  /gsd auto           Run all queued units continuously  [--verbose]",
    "  /gsd stop           Stop auto-mode gracefully",
    "  /gsd pause          Pause auto-mode (preserves state, /gsd auto to resume)",
    "  /gsd discuss        Start guided milestone/slice discussion",
    "  /gsd new-milestone  Create milestone from headless context (used by gsd headless)",
    "",
    "VISIBILITY",
    "  /gsd status         Show progress dashboard  (Ctrl+Alt+G)",
    "  /gsd visualize      Interactive 10-tab TUI (progress, timeline, deps, metrics, health, agent, changes, knowledge, captures, export)",
    "  /gsd queue          Show queued/dispatched units and execution order",
    "  /gsd history        View execution history  [--cost] [--phase] [--model] [N]",
    "  /gsd changelog      Show categorized release notes  [version]",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd skip <unit>    Prevent a unit from auto-mode dispatch",
    "  /gsd undo           Revert last completed unit  [--force]",
    "  /gsd park [id]      Park a milestone — skip without deleting  [reason]",
    "  /gsd unpark [id]    Reactivate a parked milestone",
    "",
    "PROJECT KNOWLEDGE",
    "  /gsd knowledge <type> <text>   Add rule, pattern, or lesson to KNOWLEDGE.md",
    "",
    "SETUP & CONFIGURATION",
    "  /gsd init           Project init wizard — detect, configure, bootstrap .gsd/",
    "  /gsd setup          Global setup status  [llm|search|remote|keys|prefs]",
    "  /gsd mode           Set workflow mode (solo/team)  [global|project]",
    "  /gsd prefs          Manage preferences  [global|project|status|wizard|setup|import-claude]",
    "  /gsd cmux           Manage cmux integration  [status|on|off|notifications|sidebar|splits|browser]",
    "  /gsd config         Set API keys for external tools",
    "  /gsd keys           API key manager  [list|add|remove|test|rotate|doctor]",
    "  /gsd hooks          Show post-unit hook configuration",
    "  /gsd extensions     Manage extensions  [list|enable|disable|info]",
    "",
    "MAINTENANCE",
    "  /gsd doctor         Diagnose and repair .gsd/ state  [audit|fix|heal] [scope]",
    "  /gsd export         Export milestone/slice results  [--json|--markdown|--html] [--all]",
    "  /gsd cleanup        Remove merged branches or snapshots  [branches|snapshots]",
    "  /gsd migrate        Migrate .planning/ (v1) to .gsd/ (v2) format",
    "  /gsd remote         Control remote auto-mode  [slack|discord|status|disconnect]",
    "  /gsd inspect        Show SQLite DB diagnostics (schema, row counts, recent entries)",
    "  /gsd update         Update GSD to the latest version via npm",
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

  const result = await ctx.ui.custom<void>(
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

  // Fallback for RPC mode where ctx.ui.custom() returns undefined.
  // Produce a text-based status summary so the turn is not empty.
  if (result === undefined) {
    ctx.ui.notify(formatTextStatus(state), "info");
  }
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

  const result = await ctx.ui.custom<void>(
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

  // Fallback for RPC mode where ctx.ui.custom() returns undefined.
  if (result === undefined) {
    ctx.ui.notify("Visualizer requires an interactive terminal. Use /gsd status for a text-based overview.", "warning");
  }
}

async function handleSetup(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { detectProjectState, hasGlobalSetup } = await import("./detection.js");

  // Show current global setup status
  const globalConfigured = hasGlobalSetup();
  const detection = detectProjectState(projectRoot());

  const statusLines = ["GSD Setup Status\n"];
  statusLines.push(`  Global preferences: ${globalConfigured ? "configured" : "not set"}`);
  statusLines.push(`  Project state: ${detection.state}`);
  if (detection.projectSignals.primaryLanguage) {
    statusLines.push(`  Detected: ${detection.projectSignals.primaryLanguage}`);
  }

  if (args === "llm" || args === "auth") {
    ctx.ui.notify("Use /login to configure LLM authentication.", "info");
    return;
  }

  if (args === "search") {
    ctx.ui.notify("Use /search-provider to configure web search.", "info");
    return;
  }

  if (args === "remote") {
    ctx.ui.notify("Use /gsd remote to configure remote questions.", "info");
    return;
  }

  if (args === "keys") {
    const { handleKeys } = await import("./key-manager.js");
    await handleKeys("", ctx);
    return;
  }

  if (args === "prefs") {
    await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global");
    await handlePrefsWizard(ctx, "global");
    return;
  }

  // Full setup summary
  ctx.ui.notify(statusLines.join("\n"), "info");
  ctx.ui.notify(
    "Available setup commands:\n" +
    "  /gsd setup llm     — LLM authentication\n" +
    "  /gsd setup search  — Web search provider\n" +
    "  /gsd setup remote  — Remote questions (Discord/Slack/Telegram)\n" +
    "  /gsd setup keys    — Tool API keys\n" +
    "  /gsd setup prefs   — Global preferences wizard",
    "info",
  );
}

// ─── Text-based status for RPC mode ────────────────────────────────────────

/**
 * Generate a text-based status summary for non-TUI environments (RPC mode).
 * Used as a fallback when the interactive dashboard overlay is unavailable.
 */
function formatTextStatus(state: GSDState): string {
  const lines: string[] = ["GSD Status\n"];

  // Progress score — traffic light (#1221)
  const progressScore = computeProgressScore();
  lines.push(formatProgressLine(progressScore));
  lines.push("");

  // Phase
  lines.push(`Phase: ${state.phase}`);

  // Active milestone
  if (state.activeMilestone) {
    lines.push(`Active milestone: ${state.activeMilestone.id} — ${state.activeMilestone.title}`);
  }

  // Active slice / task
  if (state.activeSlice) {
    lines.push(`Active slice: ${state.activeSlice.id} — ${state.activeSlice.title}`);
  }
  if (state.activeTask) {
    lines.push(`Active task: ${state.activeTask.id} — ${state.activeTask.title}`);
  }

  // Progress
  if (state.progress) {
    const { milestones, slices, tasks } = state.progress;
    const parts: string[] = [];
    parts.push(`milestones ${milestones.done}/${milestones.total}`);
    if (slices) parts.push(`slices ${slices.done}/${slices.total}`);
    if (tasks) parts.push(`tasks ${tasks.done}/${tasks.total}`);
    lines.push(`Progress: ${parts.join(", ")}`);
  }

  // Next action
  if (state.nextAction) {
    lines.push(`Next: ${state.nextAction}`);
  }

  // Blockers
  if (state.blockers.length > 0) {
    lines.push(`Blockers: ${state.blockers.join("; ")}`);
  }

  // Milestone registry summary
  if (state.registry.length > 0) {
    lines.push("");
    lines.push("Milestones:");
    for (const m of state.registry) {
      const statusIcon = m.status === "complete" ? "✓" : m.status === "active" ? "▶" : m.status === "parked" ? "⏸" : "○";
      lines.push(`  ${statusIcon} ${m.id}: ${m.title} (${m.status})`);
    }
  }

  // Environment health (#1221)
  const envResults = runEnvironmentChecks(projectRoot());
  const envIssues = envResults.filter(r => r.status !== "ok");
  if (envIssues.length > 0) {
    lines.push("");
    lines.push("Environment:");
    for (const r of envIssues) {
      const icon = r.status === "error" ? "✗" : "⚠";
      lines.push(`  ${icon} ${r.message}`);
    }
  }

  return lines.join("\n");
}
