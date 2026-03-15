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
import { startAuto, stopAuto, isAutoActive, isAutoPaused, isStepMode } from "./auto.js";
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
    description: "GSD — Get Shit Done: /gsd next|auto|stop|status|queue|prefs|config|hooks|doctor|migrate|remote",

    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["next", "auto", "stop", "status", "queue", "discuss", "prefs", "config", "hooks", "doctor", "migrate", "remote"];
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
        `Unknown: /gsd ${trimmed}. Use /gsd, /gsd next, /gsd auto, /gsd stop, /gsd status, /gsd queue, /gsd discuss, /gsd prefs, /gsd config, /gsd hooks, /gsd doctor [audit|fix|heal] [M###/S##], /gsd migrate <path>, or /gsd remote [slack|discord|status|disconnect].`,
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
