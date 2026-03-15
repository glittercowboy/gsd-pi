/**
 * GSD Command — /gsd
 *
 * One command, one wizard. Routes to smart entry or status.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { AuthStorage } from "@gsd/pi-coding-agent";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveState } from "./state.js";
import { GSDDashboardOverlay } from "./dashboard-overlay.js";
import { showQueue, showDiscuss } from "./guided-flow.js";
import { startAuto, stopAuto, pauseAuto, isAutoActive, isAutoPaused, isStepMode } from "./auto.js";
import {
  getGlobalGSDPreferencesPath,
  getLegacyGlobalGSDPreferencesPath,
  getProjectGSDPreferencesPath,
  loadGlobalGSDPreferences,
  loadProjectGSDPreferences,
  loadEffectiveGSDPreferences,
  resolveAllSkillReferences,
} from "./preferences.js";
import { loadFile, saveFile } from "./files.js";
import {
  formatDoctorIssuesForPrompt,
  formatDoctorReport,
  runGSDDoctor,
  selectDoctorScope,
  filterDoctorIssues,
} from "./doctor.js";
import { loadPrompt } from "./prompt-loader.js";
import { handleMigrate } from "./migrate/command.js";
import { handleRemote } from "../remote-questions/remote-command.js";
import { handleHistory } from "./history.js";
import { handleUndo } from "./undo.js";
import { handleExport } from "./export.js";

function dispatchDoctorHeal(pi: ExtensionAPI, scope: string | undefined, reportText: string, structuredIssues: string): void {
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

export function registerGSDCommand(pi: ExtensionAPI): void {
  pi.registerCommand("gsd", {
    description: "GSD — Get Shit Done: /gsd next|auto|stop|pause|status|queue|history|undo|skip|export|cleanup|prefs|config|hooks|doctor|migrate|remote",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        "next", "auto", "stop", "pause", "status", "queue", "discuss",
        "history", "undo", "skip", "export", "cleanup", "prefs",
        "config", "hooks", "doctor", "migrate", "remote",
      ];
      const parts = prefix.trim().split(/\s+/);

      if (parts.length <= 1) {
        return subcommands
          .filter((cmd) => cmd.startsWith(parts[0] ?? ""))
          .map((cmd) => ({ value: cmd, label: cmd }));
      }

      if (parts[0] === "auto" && parts.length <= 2) {
        const flagPrefix = parts[1] ?? "";
        return ["--verbose"]
          .filter((f) => f.startsWith(flagPrefix))
          .map((f) => ({ value: `auto ${f}`, label: f }));
      }

      if (parts[0] === "prefs" && parts.length <= 2) {
        const subPrefix = parts[1] ?? "";
        return ["global", "project", "status", "wizard", "setup"]
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

      return [];
    },

    async handler(args: string, ctx: ExtensionCommandContext) {
      const trimmed = (typeof args === "string" ? args : "").trim();

      if (trimmed === "status") {
        await handleStatus(ctx);
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

      if (trimmed === "next" || trimmed.startsWith("next ")) {
        if (trimmed.includes("--dry-run")) {
          await handleDryRun(ctx, process.cwd());
          return;
        }
        const verboseMode = trimmed.includes("--verbose");
        await startAuto(ctx, pi, process.cwd(), verboseMode, { step: true });
        return;
      }

      if (trimmed === "auto" || trimmed.startsWith("auto ")) {
        const verboseMode = trimmed.includes("--verbose");
        await startAuto(ctx, pi, process.cwd(), verboseMode);
        return;
      }

      if (trimmed === "stop") {
        if (!isAutoActive() && !isAutoPaused()) {
          ctx.ui.notify("Auto-mode is not running.", "info");
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
        await handleHistory(trimmed.replace(/^history\s*/, "").trim(), ctx, process.cwd());
        return;
      }

      if (trimmed === "undo" || trimmed.startsWith("undo ")) {
        await handleUndo(trimmed.replace(/^undo\s*/, "").trim(), ctx, pi, process.cwd());
        return;
      }

      if (trimmed.startsWith("skip ")) {
        await handleSkip(trimmed.replace(/^skip\s*/, "").trim(), ctx, process.cwd());
        return;
      }

      if (trimmed === "export" || trimmed.startsWith("export ")) {
        await handleExport(trimmed.replace(/^export\s*/, "").trim(), ctx, process.cwd());
        return;
      }

      if (trimmed === "cleanup branches") {
        await handleCleanupBranches(ctx, process.cwd());
        return;
      }

      if (trimmed === "cleanup snapshots") {
        await handleCleanupSnapshots(ctx, process.cwd());
        return;
      }

      if (trimmed === "queue") {
        await showQueue(ctx, pi, process.cwd());
        return;
      }

      if (trimmed === "discuss") {
        await showDiscuss(ctx, pi, process.cwd());
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

      if (trimmed === "migrate" || trimmed.startsWith("migrate ")) {
        await handleMigrate(trimmed.replace(/^migrate\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "remote" || trimmed.startsWith("remote ")) {
        await handleRemote(trimmed.replace(/^remote\s*/, "").trim(), ctx, pi);
        return;
      }

      if (trimmed === "") {
        // Bare /gsd defaults to step mode
        await startAuto(ctx, pi, process.cwd(), false, { step: true });
        return;
      }

      ctx.ui.notify(
        `Unknown: /gsd ${trimmed}. Use /gsd next|auto|stop|pause|status|queue|discuss|history|undo|skip <unit>|export|cleanup|prefs|config|hooks|doctor|migrate|remote.`,
        "warning",
      );
    },
  });
}

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
  const basePath = process.cwd();
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

  ctx.ui.notify("Usage: /gsd prefs [global|project|status|wizard|setup]", "info");
}

async function handleDoctor(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const trimmed = args.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  const mode = parts[0] === "fix" || parts[0] === "heal" || parts[0] === "audit" ? parts[0] : "doctor";
  const requestedScope = mode === "doctor" ? parts[0] : parts[1];
  const scope = await selectDoctorScope(process.cwd(), requestedScope);
  const effectiveScope = mode === "audit" ? requestedScope : scope;
  const report = await runGSDDoctor(process.cwd(), {
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

// ─── Preferences Wizard ───────────────────────────────────────────────────────

async function handlePrefsWizard(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
): Promise<void> {
  const path = scope === "project" ? getProjectGSDPreferencesPath() : getGlobalGSDPreferencesPath();
  const existing = scope === "project" ? loadProjectGSDPreferences() : loadGlobalGSDPreferences();
  const prefs: Record<string, unknown> = existing?.preferences ? { ...existing.preferences } : {};

  ctx.ui.notify(`GSD preferences wizard (${scope}) — press Escape at any prompt to skip it.`, "info");

  // ─── Models ──────────────────────────────────────────────────────────────
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

      if (choice && choice !== "(keep current)") {
        if (choice === "(clear)") {
          delete models[phase];
        } else {
          models[phase] = choice.split(" · ")[0];
        }
      }
    }
  } else {
    // No authenticated models available — fall back to text input
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

  // ─── Auto-supervisor timeouts ────────────────────────────────────────────
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

  // ─── Git main branch ────────────────────────────────────────────────────
  const git: Record<string, unknown> = (prefs.git as Record<string, unknown>) ?? {};
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
  if (Object.keys(git).length > 0) {
    prefs.git = git;
  }

  // ─── Skill discovery mode ───────────────────────────────────────────────
  const currentDiscovery = (prefs.skill_discovery as string) ?? "";
  const discoveryChoice = await ctx.ui.select(
    `Skill discovery mode${currentDiscovery ? ` (current: ${currentDiscovery})` : ""}:`,
    ["auto", "suggest", "off", "(keep current)"],
  );
  if (discoveryChoice && discoveryChoice !== "(keep current)") {
    prefs.skill_discovery = discoveryChoice;
  }

  // ─── Unique milestone IDs ──────────────────────────────────────────────
  const currentUnique = prefs.unique_milestone_ids;
  const uniqueChoice = await ctx.ui.select(
    `Unique milestone IDs${currentUnique !== undefined ? ` (current: ${currentUnique})` : ""}:`,
    ["true", "false", "(keep current)"],
  );
  if (uniqueChoice && uniqueChoice !== "(keep current)") {
    prefs.unique_milestone_ids = uniqueChoice === "true";
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
    "version", "always_use_skills", "prefer_skills", "avoid_skills",
    "skill_rules", "custom_instructions", "models", "skill_discovery",
    "auto_supervisor", "uat_dispatch", "unique_milestone_ids", "budget_ceiling", "remote_questions", "git",
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

const TOOL_KEYS = [
  { id: "tavily",   env: "TAVILY_API_KEY",   label: "Tavily Search",     hint: "tavily.com/app/api-keys" },
  { id: "brave",    env: "BRAVE_API_KEY",     label: "Brave Search",      hint: "brave.com/search/api" },
  { id: "context7", env: "CONTEXT7_API_KEY",  label: "Context7 Docs",     hint: "context7.com/dashboard" },
  { id: "jina",     env: "JINA_API_KEY",      label: "Jina Page Extract", hint: "jina.ai/api" },
  { id: "groq",     env: "GROQ_API_KEY",      label: "Groq Voice",        hint: "console.groq.com" },
] as const;

function getConfigAuthStorage(): InstanceType<typeof AuthStorage> {
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
    if (!choice || choice === "(done)") break;

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
  const { execFileSync } = await import("node:child_process");

  let branches: string[];
  try {
    const output = execFileSync("git", ["branch", "--list", "gsd/*"], { cwd: basePath, timeout: 10000, encoding: "utf-8" });
    branches = output.split("\n").map(b => b.trim().replace(/^\* /, "")).filter(Boolean);
  } catch {
    ctx.ui.notify("No GSD branches found.", "info");
    return;
  }

  if (branches.length === 0) {
    ctx.ui.notify("No GSD branches to clean up.", "info");
    return;
  }

  let mainBranch: string;
  try {
    mainBranch = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], { cwd: basePath, timeout: 5000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().replace("origin/", "");
  } catch {
    mainBranch = "main";
  }

  let merged: string[];
  try {
    const output = execFileSync("git", ["branch", "--merged", mainBranch, "--list", "gsd/*"], { cwd: basePath, timeout: 10000, encoding: "utf-8" });
    merged = output.split("\n").map(b => b.trim()).filter(Boolean);
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
      execFileSync("git", ["branch", "-d", branch], { cwd: basePath, timeout: 5000, stdio: "ignore" });
      deleted++;
    } catch { /* skip branches that can't be deleted */ }
  }

  ctx.ui.notify(`Cleaned up ${deleted} merged branches. ${branches.length - deleted} remain.`, "success");
}

// ─── Snapshot cleanup handler ─────────────────────────────────────────────────

async function handleCleanupSnapshots(ctx: ExtensionCommandContext, basePath: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");

  let refs: string[];
  try {
    const output = execFileSync("git", ["for-each-ref", "refs/gsd/snapshots/", "--format=%(refname)"], { cwd: basePath, timeout: 10000, encoding: "utf-8" });
    refs = output.split("\n").filter(Boolean);
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
        execFileSync("git", ["update-ref", "-d", old], { cwd: basePath, timeout: 5000, stdio: "ignore" });
        pruned++;
      } catch { /* skip */ }
    }
  }

  ctx.ui.notify(`Pruned ${pruned} old snapshot refs. ${refs.length - pruned} remain.`, "success");
}
