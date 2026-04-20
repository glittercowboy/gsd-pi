import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@gsd/pi-coding-agent";
import type { Model } from "@gsd/pi-ai";
import type { GSDState } from "../../types.js";

import { computeProgressScore, formatProgressLine } from "../../progress-score.js";
import { loadEffectiveGSDPreferences, getGlobalGSDPreferencesPath, getProjectGSDPreferencesPath } from "../../preferences.js";
import { ensurePreferencesFile, handlePrefs, handlePrefsMode, handlePrefsWizard, handleLanguage } from "../../commands-prefs-wizard.js";
import { runEnvironmentChecks } from "../../doctor-environment.js";
import { deriveState } from "../../state.js";
import { handleCmux } from "../../commands-cmux.js";
import { setSessionModelOverride } from "../../session-model-override.js";
import { projectRoot } from "../context.js";
import { formattedShortcutPair } from "../../shortcut-defs.js";

export function showHelp(ctx: ExtensionCommandContext, args = ""): void {
  const summaryLines = [
    "GSD — Get Shit Done\n",
    "QUICK START",
    "  /gsd start <tpl>   Start a workflow template",
    "  /gsd               Run next unit (same as /gsd next)",
    "  /gsd auto          Run all queued units continuously",
    "  /gsd pause         Pause auto-mode",
    "  /gsd stop          Stop auto-mode gracefully",
    "",
    "VISIBILITY",
    `  /gsd status         Dashboard  (${formattedShortcutPair("dashboard")})`,
    `  /gsd parallel watch Parallel monitor  (${formattedShortcutPair("parallel")})`,
    `  /gsd notifications  Notification history  (${formattedShortcutPair("notifications")})`,
    "  /gsd visualize      Interactive 10-tab TUI",
    "  /gsd queue          Show queued/dispatched units",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd undo           Revert last completed unit  [--force]",
    "  /gsd rethink        Conversational project reorganization",
    "",
    "OBSERVABILITY",
    "  /gsd logs           Browse activity and debug logs",
    "  /gsd debug          Create/list/continue persistent debug sessions",
    "",
    "SETUP",
    "  /gsd onboarding     Re-run setup wizard  [--resume|--reset|--step <name>]",
    "  /gsd setup          Configuration hub  [llm|model|search|remote|keys|prefs|onboarding]",
    "  /gsd init           Project init wizard",
    "  /gsd model          Switch active session model",
    "  /gsd prefs          Manage preferences (alias for /gsd setup prefs)",
    "  /gsd keys           API key manager (LLM + tool keys)",
    "  /gsd doctor         Diagnose and repair .gsd/ state",
    "",
    "Use /gsd help full for the complete command reference.",
  ];

  const fullLines = [
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
    `  /gsd status         Show progress dashboard  (${formattedShortcutPair("dashboard")})`,
    `  /gsd parallel watch Open parallel worker monitor  (${formattedShortcutPair("parallel")})`,
    "  /gsd visualize      Interactive 10-tab TUI (progress, timeline, deps, metrics, health, agent, changes, knowledge, captures, export)",
    "  /gsd queue          Show queued/dispatched units and execution order",
    "  /gsd history        View execution history  [--cost] [--phase] [--model] [N]",
    "  /gsd changelog      Show categorized release notes  [version]",
    `  /gsd notifications  View persistent notification history  [clear|tail|filter]  (${formattedShortcutPair("notifications")})`,
    "  /gsd logs           Browse activity logs, debug logs, and metrics",
    "  /gsd debug          Create/list/continue persistent debug sessions",
    "",
    "COURSE CORRECTION",
    "  /gsd steer <desc>   Apply user override to active work",
    "  /gsd capture <text> Quick-capture a thought to CAPTURES.md",
    "  /gsd triage         Classify and route pending captures",
    "  /gsd skip <unit>    Prevent a unit from auto-mode dispatch",
    "  /gsd undo           Revert last completed unit  [--force]",
    "  /gsd rethink        Conversational project reorganization — reorder, park, discard, add milestones",
    "  /gsd park [id]      Park a milestone — skip without deleting  [reason]",
    "  /gsd unpark [id]    Reactivate a parked milestone",
    "",
    "PROJECT KNOWLEDGE",
    "  /gsd knowledge <type> <text>   Add rule, pattern, or lesson to KNOWLEDGE.md",
    "  /gsd codebase [generate|update|stats]   Manage the CODEBASE.md cache used in prompt context",
    "",
    "SETUP & CONFIGURATION",
    "  /gsd onboarding     Re-run setup wizard  [--resume|--reset|--step <name>]",
    "  /gsd setup          Configuration hub  [llm|model|search|remote|keys|prefs|onboarding]",
    "  /gsd init           Project init wizard — detect, configure, bootstrap .gsd/",
    "  /gsd model          Switch active session model  [provider/model|model-id]",
    "  /gsd mode           Set workflow mode (solo/team)  [global|project]",
    "  /gsd prefs          Manage preferences  [global|project|status|wizard|setup|import-claude]  (alias for /gsd setup prefs)",
    "  /gsd cmux           Manage cmux integration  [status|on|off|notifications|sidebar|splits|browser]",
    "  /gsd keys           API key manager (LLM + tool keys)  [list|add|remove|test|rotate|doctor]",
    "  /gsd config         (deprecated) Set tool API keys — use /gsd keys instead",
    "  /gsd show-config    Show effective configuration (models, routing, toggles)",
    "  /gsd hooks          Show post-unit hook configuration",
    "  /gsd extensions     Manage extensions  [list|enable|disable|info]",
    "  /gsd fast           Toggle OpenAI service tier  [on|off|flex|status]",
    "  /gsd mcp            MCP server status and connectivity  [status|check <server>|init [dir]]",
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
  const full = ["full", "--full", "all"].includes(args.trim().toLowerCase());
  ctx.ui.notify((full ? fullLines : summaryLines).join("\n"), "info");
}

export async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
  const basePath = projectRoot();
  // Open DB in cold sessions so status uses DB-backed state, not filesystem fallback (#3385)
  const { ensureDbOpen } = await import("../../bootstrap/dynamic-tools.js");
  await ensureDbOpen();
  const state = await deriveState(basePath);

  if (state.registry.length === 0) {
    ctx.ui.notify("No GSD milestones found. Run /gsd to start.", "info");
    return;
  }

  const { GSDDashboardOverlay } = await import("../../dashboard-overlay.js");
  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _kb, done) => new GSDDashboardOverlay(tui, theme, () => done(true)),
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

  if (result === undefined) {
    ctx.ui.notify(formatTextStatus(state), "info");
  }
}

export async function fireStatusViaCommand(ctx: ExtensionContext): Promise<void> {
  await handleStatus(ctx as ExtensionCommandContext);
}

export async function handleVisualize(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Visualizer requires an interactive terminal.", "warning");
    return;
  }

  const { GSDVisualizerOverlay } = await import("../../visualizer-overlay.js");
  const result = await ctx.ui.custom<boolean>(
    (tui, theme, _kb, done) => new GSDVisualizerOverlay(tui, theme, () => done(true)),
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

  if (result === undefined) {
    ctx.ui.notify("Visualizer requires an interactive terminal. Use /gsd status for a text-based overview.", "warning");
  }
}

export async function handleSetup(args: string, ctx: ExtensionCommandContext, pi?: ExtensionAPI): Promise<void> {
  const { detectProjectState, hasGlobalSetup } = await import("../../detection.js");
  const { isOnboardingComplete, readOnboardingRecord } = await import("../../onboarding-state.js");

  // Sub-route dispatch — keep redirects but route the canonical work to /gsd
  // onboarding (single source for wizard steps) and /gsd keys (single source
  // for credentials).
  if (args === "onboarding" || args === "wizard") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("", ctx);
    return;
  }
  if (args === "llm" || args === "auth") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step llm", ctx);
    return;
  }
  if (args === "search") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step search", ctx);
    return;
  }
  if (args === "remote") {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding("--step remote", ctx);
    return;
  }
  if (args === "model") {
    await handleModel("", ctx, pi);
    return;
  }
  if (args === "keys") {
    ctx.ui.notify("Tip: /gsd keys is the canonical command for API key management.", "info");
    const { handleKeys } = await import("../../key-manager.js");
    await handleKeys("", ctx);
    return;
  }
  if (args === "prefs") {
    await ensurePreferencesFile(getGlobalGSDPreferencesPath(), ctx, "global");
    await handlePrefsWizard(ctx, "global");
    return;
  }

  // Bare /gsd setup — render the hub: status + actions
  const globalConfigured = hasGlobalSetup();
  const detection = detectProjectState(projectRoot());
  const onboardingDone = isOnboardingComplete();
  const record = readOnboardingRecord();

  const statusLines: string[] = ["GSD Setup\n"];
  statusLines.push(
    onboardingDone
      ? `  Onboarding:         ✓ complete${record.completedAt ? ` (${record.completedAt.slice(0, 10)})` : ""}`
      : `  Onboarding:         ○ not complete  —  /gsd onboarding to start`,
  );
  statusLines.push(`  Global preferences: ${globalConfigured ? "configured" : "not set"}`);
  statusLines.push(`  Project state:      ${detection.state}`);
  if (detection.projectSignals.primaryLanguage) {
    statusLines.push(`  Detected:           ${detection.projectSignals.primaryLanguage}`);
  }

  ctx.ui.notify(statusLines.join("\n"), "info");
  ctx.ui.notify(
    "Configuration hub:\n" +
    "  /gsd setup llm        — LLM provider & auth\n" +
    "  /gsd setup model      — Default model picker\n" +
    "  /gsd setup search     — Web search provider\n" +
    "  /gsd setup remote     — Remote questions (Discord/Slack/Telegram)\n" +
    "  /gsd setup keys       — API keys (alias for /gsd keys)\n" +
    "  /gsd setup prefs      — Global preferences (alias for /gsd prefs)\n" +
    "  /gsd setup onboarding — Full wizard (alias for /gsd onboarding)\n\n" +
    "Tip: /gsd onboarding --resume to continue an incomplete setup.",
    "info",
  );
}

function sortModelsForSelection(models: Model<any>[], currentModel: Model<any> | undefined): Model<any>[] {
  return [...models].sort((a, b) => {
    const aCurrent = currentModel && a.provider === currentModel.provider && a.id === currentModel.id;
    const bCurrent = currentModel && b.provider === currentModel.provider && b.id === currentModel.id;
    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;
    const providerCmp = a.provider.localeCompare(b.provider);
    if (providerCmp !== 0) return providerCmp;
    return a.id.localeCompare(b.id);
  });
}

function buildProviderModelGroups(
  models: Model<any>[],
  currentModel: Model<any> | undefined,
): Map<string, Model<any>[]> {
  const byProvider = new Map<string, Model<any>[]>();

  for (const model of sortModelsForSelection(models, currentModel)) {
    let group = byProvider.get(model.provider);
    if (!group) {
      group = [];
      byProvider.set(model.provider, group);
    }
    group.push(model);
  }
  return byProvider;
}

async function selectModelByProvider(
  title: string,
  models: Model<any>[],
  ctx: ExtensionCommandContext,
  currentModel: Model<any> | undefined,
): Promise<Model<any> | undefined> {
  const byProvider = buildProviderModelGroups(models, currentModel);
  const providerOptions = Array.from(byProvider.entries()).map(([provider, group]) =>
    `${provider} (${group.length} model${group.length === 1 ? "" : "s"})`,
  );
  providerOptions.push("(cancel)");

  const providerChoice = await ctx.ui.select(`${title} — choose provider:`, providerOptions);
  if (!providerChoice || typeof providerChoice !== "string" || providerChoice === "(cancel)") return undefined;

  const providerName = providerChoice.replace(/ \(\d+ models?\)$/, "");
  const providerModels = byProvider.get(providerName);
  if (!providerModels || providerModels.length === 0) return undefined;

  const optionToModel = new Map<string, Model<any>>();
  const modelOptions = providerModels.map((model) => {
    const isCurrent = currentModel && model.provider === currentModel.provider && model.id === currentModel.id;
    const label = `${isCurrent ? "* " : ""}${model.id}`;
    optionToModel.set(label, model);
    return label;
  });
  modelOptions.push("(cancel)");

  const modelChoice = await ctx.ui.select(`${title} — ${providerName}:`, modelOptions);
  if (!modelChoice || typeof modelChoice !== "string" || modelChoice === "(cancel)") return undefined;
  return optionToModel.get(modelChoice);
}

async function resolveRequestedModel(
  query: string,
  ctx: ExtensionCommandContext,
): Promise<Model<any> | undefined> {
  const { resolveModelId } = await import("../../auto-model-selection.js");
  const models = ctx.modelRegistry.getAvailable();
  const exact = resolveModelId(query, models, ctx.model?.provider);
  if (exact) return exact;

  const lowerQuery = query.toLowerCase();
  const partialMatches = models.filter((model) =>
    model.id.toLowerCase().includes(lowerQuery)
      || `${model.provider}/${model.id}`.toLowerCase().includes(lowerQuery),
  );

  if (partialMatches.length === 1) return partialMatches[0];
  if (partialMatches.length === 0 || !ctx.hasUI) return undefined;
  return selectModelByProvider(`Multiple models match "${query}"`, partialMatches, ctx, ctx.model);
}

async function handleModel(trimmedArgs: string, ctx: ExtensionCommandContext, pi: ExtensionAPI | undefined): Promise<void> {
  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length === 0) {
    ctx.ui.notify("No available models found. Check provider auth and model discovery.", "warning");
    return;
  }
  if (!pi) {
    ctx.ui.notify("Model switching is unavailable in this context.", "warning");
    return;
  }

  const trimmed = trimmedArgs.trim();
  let targetModel: Model<any> | undefined;

  if (!trimmed) {
    if (!ctx.hasUI) {
      const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";
      ctx.ui.notify(`Current model: ${current}\nUsage: /gsd model <provider/model|model-id>`, "info");
      return;
    }

    targetModel = await selectModelByProvider("Select session model:", availableModels, ctx, ctx.model);
  } else {
    targetModel = await resolveRequestedModel(trimmed, ctx);
  }

  if (!targetModel) {
    ctx.ui.notify(`Model "${trimmed}" not found. Use /gsd model with an exact provider/model or a unique model ID.`, "warning");
    return;
  }

  const ok = await pi.setModel(targetModel);
  if (!ok) {
    ctx.ui.notify(`No API key for ${targetModel.provider}/${targetModel.id}`, "warning");
    return;
  }

  // /gsd model is an explicit per-session pin for GSD dispatches.
  // This is captured at auto bootstrap so it survives internal session
  // switches during /gsd auto and /gsd next runs.
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (sessionId) {
    setSessionModelOverride(sessionId, {
      provider: targetModel.provider,
      id: targetModel.id,
    });
  }

  ctx.ui.notify(`Model: ${targetModel.provider}/${targetModel.id}`, "info");
}

export async function handleCoreCommand(
  trimmed: string,
  ctx: ExtensionCommandContext,
  pi?: ExtensionAPI,
): Promise<boolean> {
  if (trimmed === "help" || trimmed === "h" || trimmed === "?" || trimmed.startsWith("help ")) {
    showHelp(ctx, trimmed.startsWith("help ") ? trimmed.slice(5).trim() : "");
    return true;
  }
  if (trimmed === "status") {
    await handleStatus(ctx);
    return true;
  }
  if (trimmed === "visualize") {
    await handleVisualize(ctx);
    return true;
  }
  if (trimmed === "widget" || trimmed.startsWith("widget ")) {
    const { cycleWidgetMode, setWidgetMode, getWidgetMode } = await import("../../auto-dashboard.js");
    const arg = trimmed.replace(/^widget\s*/, "").trim();
    if (arg === "full" || arg === "small" || arg === "min" || arg === "off") {
      setWidgetMode(arg);
    } else {
      cycleWidgetMode();
    }
    ctx.ui.notify(`Widget: ${getWidgetMode()}`, "info");
    return true;
  }
  if (trimmed === "model" || trimmed.startsWith("model ")) {
    await handleModel(trimmed.replace(/^model\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "mode" || trimmed.startsWith("mode ")) {
    const modeArgs = trimmed.replace(/^mode\s*/, "").trim();
    const scope = modeArgs === "project" ? "project" : "global";
    const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
    await ensurePreferencesFile(path, ctx, scope);
    await handlePrefsMode(ctx, scope);
    return true;
  }
  if (trimmed === "prefs" || trimmed.startsWith("prefs ")) {
    await handlePrefs(trimmed.replace(/^prefs\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "language" || trimmed.startsWith("language ")) {
    await handleLanguage(trimmed.replace(/^language\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "cmux" || trimmed.startsWith("cmux ")) {
    await handleCmux(trimmed.replace(/^cmux\s*/, "").trim(), ctx);
    return true;
  }
  if (trimmed === "show-config") {
    const { GSDConfigOverlay, formatConfigText } = await import("../../config-overlay.js");
    const result = await ctx.ui.custom<boolean>(
      (tui, theme, _kb, done) => new GSDConfigOverlay(tui, theme, () => done(true)),
      {
        overlay: true,
        overlayOptions: {
          width: "65%",
          minWidth: 55,
          maxHeight: "85%",
          anchor: "center",
        },
      },
    );
    if (result === undefined) {
      ctx.ui.notify(formatConfigText(), "info");
    }
    return true;
  }
  if (trimmed === "setup" || trimmed.startsWith("setup ")) {
    await handleSetup(trimmed.replace(/^setup\s*/, "").trim(), ctx, pi);
    return true;
  }
  if (trimmed === "onboarding" || trimmed.startsWith("onboarding ")) {
    const { handleOnboarding } = await import("./onboarding.js");
    await handleOnboarding(trimmed.replace(/^onboarding\s*/, "").trim(), ctx);
    return true;
  }
  return false;
}

export function formatTextStatus(state: GSDState): string {
  const lines: string[] = ["GSD Status\n"];
  lines.push(formatProgressLine(computeProgressScore()));
  lines.push("");
  lines.push(`Phase: ${state.phase}`);

  if (state.activeMilestone) {
    lines.push(`Active milestone: ${state.activeMilestone.id} — ${state.activeMilestone.title}`);
  }
  if (state.activeSlice) {
    lines.push(`Active slice: ${state.activeSlice.id} — ${state.activeSlice.title}`);
  }
  if (state.activeTask) {
    lines.push(`Active task: ${state.activeTask.id} — ${state.activeTask.title}`);
  }
  if (state.progress) {
    const { milestones, slices, tasks } = state.progress;
    const parts: string[] = [`milestones ${milestones.done}/${milestones.total}`];
    if (slices) parts.push(`slices ${slices.done}/${slices.total}`);
    if (tasks) parts.push(`tasks ${tasks.done}/${tasks.total}`);
    lines.push(`Progress: ${parts.join(", ")}`);
  }
  if (state.nextAction) {
    lines.push(`Next: ${state.nextAction}`);
  }
  if (state.blockers.length > 0) {
    lines.push(`Blockers: ${state.blockers.join("; ")}`);
  }
  if (state.registry.length > 0) {
    lines.push("");
    lines.push("Milestones:");
    for (const milestone of state.registry) {
      const icon = milestone.status === "complete"
        ? "✓"
        : milestone.status === "active"
          ? "▶"
          : milestone.status === "parked"
            ? "⏸"
            : "○";
      lines.push(`  ${icon} ${milestone.id}: ${milestone.title} (${milestone.status})`);
    }
  }

  const envResults = runEnvironmentChecks(projectRoot());
  const envIssues = envResults.filter((result) => result.status !== "ok");
  if (envIssues.length > 0) {
    lines.push("");
    lines.push("Environment:");
    for (const issue of envIssues) {
      lines.push(`  ${issue.status === "error" ? "✗" : "⚠"} ${issue.message}`);
    }
  }

  return lines.join("\n");
}
