import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { handleQuick } from "../../quick.js";
import { showDiscuss, showHeadlessMilestoneCreation, showQueue } from "../../guided-flow.js";
import { handleStart, handleTemplates, dispatchMarkdownPhasePlugin } from "../../commands-workflow-templates.js";
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
  startAutoDetached,
  pauseAuto,
  isAutoActive,
  getActiveEngineId,
} from "../../auto.js";
import { validateDefinition } from "../../definition-loader.js";
import {
  formatPluginInfo,
  listPluginsFormatted,
  resolvePlugin,
  type WorkflowPlugin,
} from "../../workflow-plugins.js";
import { dispatchOneshot } from "../../workflow-dispatch.js";
import {
  fetchWorkflowSource,
  globalInstallDir,
  inferPluginName,
  installPlugin,
  previewContent,
  projectInstallDir,
  resolveSourceUrl,
  uninstallPlugin,
  validateFetchedContent,
} from "../../workflow-install.js";

// ─── Custom Workflow Subcommands ─────────────────────────────────────────

const RESERVED_SUBCOMMANDS = new Set([
  "new", "run", "list", "validate", "pause", "resume",
  "info", "install", "uninstall",
]);

const WORKFLOW_USAGE = [
  "Usage: /gsd workflow [<name> | <subcommand>]",
  "",
  "  <name> [args]     — Run a plugin directly (resolves project/global/bundled)",
  "  new               — Create a new workflow definition (via skill)",
  "  run <name> [k=v]  — Explicit YAML run (creates a new run dir)",
  "  list [name]       — List workflow runs (optionally filtered by name)",
  "  info <name>       — Show plugin details (source, mode, phases)",
  "  install <source>  — Install a plugin from a URL / gist: / gh:",
  "  uninstall <name>  — Remove an installed plugin",
  "  validate <name>   — Validate a workflow definition YAML",
  "  pause             — Pause custom workflow auto-mode",
  "  resume            — Resume paused custom workflow auto-mode",
].join("\n");

function splitWorkflowRunArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escapeNext = false;

  for (const ch of input) {
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      escapeNext = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escapeNext) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

export function parseWorkflowRunArgs(args: string): { defName: string; overrides: Record<string, string> } {
  const parts = splitWorkflowRunArgs(args);
  const defName = parts[0] ?? "";
  const overrides: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf("=");
    if (eqIdx > 0) {
      overrides[parts[i].slice(0, eqIdx)] = parts[i].slice(eqIdx + 1);
    }
  }
  return { defName, overrides };
}

/**
 * Parse every token as an optional `k=v` override. Use when the workflow name
 * is already known (e.g., direct `/gsd workflow <name> ...` dispatch) so the
 * first token isn't eaten as a def name.
 */
export function parseWorkflowOverridesOnly(args: string): Record<string, string> {
  const parts = splitWorkflowRunArgs(args);
  const overrides: Record<string, string> = {};
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      overrides[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }
  }
  return overrides;
}

/**
 * Dispatch a resolved plugin according to its declared mode.
 */
function dispatchPluginByMode(
  plugin: WorkflowPlugin,
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): void {
  switch (plugin.meta.mode) {
    case "oneshot": {
      dispatchOneshot(plugin, pi, args.trim());
      ctx.ui.notify(`Running oneshot workflow: ${plugin.meta.displayName}`, "info");
      return;
    }

    case "yaml-step": {
      const overrides = parseWorkflowOverridesOnly(args);
      try {
        const base = projectRoot();
        const runDir = createRun(base, plugin.name, Object.keys(overrides).length > 0 ? overrides : undefined);
        setActiveEngineId("custom");
        setActiveRunDir(runDir);
        ctx.ui.notify(`Created workflow run: ${plugin.name}\nRun dir: ${runDir}`, "info");
        startAutoDetached(ctx, pi, base, false);
      } catch (err) {
        setActiveEngineId(null);
        setActiveRunDir(null);
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to run workflow "${plugin.name}": ${msg}`, "error");
      }
      return;
    }

    case "markdown-phase": {
      if (isAutoActive()) {
        ctx.ui.notify(
          "Cannot start a markdown-phase workflow while auto-mode is running.\n" +
          "Run /gsd pause first.",
          "warning",
        );
        return;
      }
      // Delegate to commands-workflow-templates which handles branch + state file.
      dispatchMarkdownPhasePlugin(plugin, args.trim(), ctx, pi);
      return;
    }

    case "auto-milestone": {
      ctx.ui.notify(
        `'${plugin.name}' runs via the full milestone pipeline.\n` +
        `Use /gsd auto or /gsd start ${plugin.name}.`,
        "info",
      );
      return;
    }
  }
}

async function handleCustomWorkflow(
  sub: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<boolean> {
  // Bare `/gsd workflow` — list plugins
  if (!sub) {
    const base = projectRoot();
    const listing = listPluginsFormatted(base);
    ctx.ui.notify(listing, "info");
    return true;
  }

  // Split into head + rest for subcommand detection.
  const spaceIdx = sub.indexOf(" ");
  const head = (spaceIdx === -1 ? sub : sub.slice(0, spaceIdx)).trim();
  const rest = spaceIdx === -1 ? "" : sub.slice(spaceIdx + 1).trim();

  // ── new ──
  if (head === "new") {
    ctx.ui.notify("Use the create-workflow skill: /skill create-workflow", "info");
    return true;
  }

  // ── run <name> [param=value ...] ──
  if (head === "run") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow run <name> [param=value ...]", "warning");
      return true;
    }
    const { defName, overrides } = parseWorkflowRunArgs(rest);
    try {
      const base = projectRoot();
      const runDir = createRun(base, defName, Object.keys(overrides).length > 0 ? overrides : undefined);
      setActiveEngineId("custom");
      setActiveRunDir(runDir);
      ctx.ui.notify(`Created workflow run: ${defName}\nRun dir: ${runDir}`, "info");
      startAutoDetached(ctx, pi, base, false);
    } catch (err) {
      setActiveEngineId(null);
      setActiveRunDir(null);
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to run workflow "${defName}": ${msg}`, "error");
    }
    return true;
  }

  // ── list [name] — list YAML runs ──
  if (head === "list") {
    const base = projectRoot();
    const runs = listRuns(base, rest || undefined);
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

  // ── info <name> ──
  if (head === "info") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow info <name>", "warning");
      return true;
    }
    const base = projectRoot();
    const plugin = resolvePlugin(base, rest);
    if (!plugin) {
      ctx.ui.notify(`Plugin not found: ${rest}\nRun /gsd workflow to list plugins.`, "warning");
      return true;
    }
    ctx.ui.notify(formatPluginInfo(plugin), "info");
    return true;
  }

  // ── install <source> [--project] [--name <override>] ──
  if (head === "install") {
    if (!rest) {
      ctx.ui.notify(
        "Usage: /gsd workflow install <source> [--project] [--name <n>]\n\n" +
        "Sources:\n" +
        "  https://…/path/workflow.yaml\n" +
        "  gist:<id>\n" +
        "  gh:owner/repo/path[@ref]",
        "warning",
      );
      return true;
    }

    const tokens = rest.split(/\s+/);
    let source = "";
    let scope: "global" | "project" = "global";
    let nameOverride: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--project") scope = "project";
      else if (t === "--name") nameOverride = tokens[++i];
      else if (t && !source) source = t;
    }

    const base = projectRoot();
    try {
      const url = resolveSourceUrl(source);
      ctx.ui.notify(`Fetching ${url}…`, "info");
      const fetched = await fetchWorkflowSource(url);
      validateFetchedContent(fetched);
      const name = nameOverride ? nameOverride.trim().toLowerCase() : inferPluginName(fetched);
      if (!name) throw new Error("Could not infer plugin name. Use --name <n>.");

      const target = scope === "global"
        ? { scope: "global" as const, dir: globalInstallDir() }
        : { scope: "project" as const, dir: projectInstallDir(base) };

      const preview = previewContent(fetched.content, 20);
      const summary = [
        `Install workflow plugin:`,
        `  Source:    ${fetched.url}`,
        `  Name:      ${name}`,
        `  Format:    ${fetched.ext.slice(1)}`,
        `  Target:    ${join(target.dir, `${name}${fetched.ext}`)}`,
        `  Scope:     ${target.scope}`,
        "",
        `Preview (first 20 lines):`,
        "  " + preview.split("\n").join("\n  "),
        "",
        `Proceeding with install. Run /gsd workflow uninstall ${name} to revert.`,
      ].join("\n");
      ctx.ui.notify(summary, "info");

      const result = installPlugin(target, fetched, name);
      ctx.ui.notify(
        `✓ Installed plugin "${result.name}" (${result.ext.slice(1)}) to ${result.path}`,
        "info",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to install: ${msg}`, "error");
    }
    return true;
  }

  // ── uninstall <name> ──
  if (head === "uninstall") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow uninstall <name>", "warning");
      return true;
    }
    const base = projectRoot();
    const result = uninstallPlugin(base, rest.trim());
    if (!result.removed) {
      ctx.ui.notify(
        `No installed plugin named "${rest}" found in ${globalInstallDir()} or ${projectInstallDir(base)}.`,
        "warning",
      );
      return true;
    }
    const warning = result.warnedNotInProvenance
      ? " (no provenance record — was this hand-authored?)"
      : "";
    ctx.ui.notify(`✓ Removed ${result.path}${warning}`, "info");
    return true;
  }

  // ── validate <name> ──
  if (head === "validate") {
    if (!rest) {
      ctx.ui.notify("Usage: /gsd workflow validate <name>", "warning");
      return true;
    }
    const base = projectRoot();
    const plugin = resolvePlugin(base, rest);

    let raw: string;
    let sourceLabel: string;

    if (plugin && plugin.format === "yaml") {
      try {
        raw = readFileSync(plugin.path, "utf-8");
        sourceLabel = plugin.path;
      } catch (err) {
        ctx.ui.notify(
          `Failed to read definition: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return true;
      }
    } else {
      // Legacy fallback path for names that don't resolve via plugins.
      const defPath = join(base, ".gsd", "workflow-defs", `${rest}.yaml`);
      if (!existsSync(defPath)) {
        ctx.ui.notify(`Definition not found: ${defPath}`, "error");
        return true;
      }
      try {
        raw = readFileSync(defPath, "utf-8");
        sourceLabel = defPath;
      } catch (err) {
        ctx.ui.notify(
          `Failed to read definition: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return true;
      }
    }

    try {
      const parsed = parseYaml(raw);
      const result = validateDefinition(parsed);
      if (result.valid) {
        ctx.ui.notify(`✓ "${rest}" is a valid workflow definition (${sourceLabel}).`, "info");
      } else {
        ctx.ui.notify(`✗ "${rest}" has errors:\n  - ${result.errors.join("\n  - ")}`, "error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to validate "${rest}": ${msg}`, "error");
    }
    return true;
  }

  // ── pause ──
  if (head === "pause" && !rest) {
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
  if (head === "resume" && !rest) {
    const engineId = getActiveEngineId();
    if (engineId === "dev" || engineId === null) {
      ctx.ui.notify("No custom workflow to resume. Use /gsd auto for dev workflow.", "warning");
      return true;
    }
    startAutoDetached(ctx, pi, projectRoot(), false);
    ctx.ui.notify("Custom workflow resumed.", "info");
    return true;
  }

  // ── Direct dispatch: /gsd workflow <name> [args] ──
  // If the first token isn't a reserved subcommand, resolve it as a plugin.
  if (!RESERVED_SUBCOMMANDS.has(head)) {
    const base = projectRoot();
    const plugin = resolvePlugin(base, head);
    if (plugin) {
      dispatchPluginByMode(plugin, rest, ctx, pi);
      return true;
    }
  }

  // Unknown subcommand — show usage
  ctx.ui.notify(`Unknown workflow subcommand or plugin: "${head}"\n\n${WORKFLOW_USAGE}`, "warning");
  return true;
}

export async function handleWorkflowCommand(trimmed: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<boolean> {
  // ── /gsd do — natural language routing (must be early to route to other commands) ──
  if (trimmed === "do" || trimmed.startsWith("do ")) {
    const { handleDo } = await import("../../commands-do.js");
    await handleDo(trimmed.replace(/^do\s*/, "").trim(), ctx, pi);
    return true;
  }
  // ── Backlog management ──
  if (trimmed === "backlog" || trimmed.startsWith("backlog ")) {
    const { handleBacklog } = await import("../../commands-backlog.js");
    await handleBacklog(trimmed.replace(/^backlog\s*/, "").trim(), ctx, pi);
    return true;
  }
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
