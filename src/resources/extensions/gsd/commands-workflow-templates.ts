/**
 * GSD Workflow Template Commands — /gsd start, /gsd templates
 *
 * Handles the `/gsd start [template] [description]` and `/gsd templates` commands.
 * Resolves templates by name or auto-detection, then dispatches the workflow prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveByName,
  autoDetect,
  listTemplates,
  getTemplateInfo,
  loadWorkflowTemplate,
  loadRegistry,
  type TemplateMatch,
} from "./workflow-templates.js";
import { loadPrompt } from "./prompt-loader.js";
import { gsdRoot } from "./paths.js";
import { createGitService, runGit } from "./git-service.js";
import { isAutoActive, isAutoPaused } from "./auto.js";
import { getErrorMessage } from "./error-utils.js";
import { resolvePlugin, type WorkflowPlugin } from "./workflow-plugins.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a URL-friendly slug from text.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

/**
 * Get the next workflow task number by scanning existing directories.
 */
function getNextWorkflowNum(workflowDir: string): number {
  if (!existsSync(workflowDir)) return 1;
  try {
    const entries = readdirSync(workflowDir, { withFileTypes: true });
    let max = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(\d{6})-(\d+)-/);
      if (match) {
        const num = parseInt(match[2], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * Format the date as YYMMDD for directory naming.
 */
function datePrefix(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// ─── State Types ─────────────────────────────────────────────────────────────

interface WorkflowPhaseState {
  name: string;
  index: number;
  status: "pending" | "active" | "completed";
}

interface WorkflowState {
  template: string;
  templateName: string;
  description: string;
  branch: string;
  phases: WorkflowPhaseState[];
  currentPhase: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  artifactDir: string;
}

/**
 * Write a STATE.json file to track workflow execution state.
 */
function writeWorkflowState(
  artifactDir: string,
  templateId: string,
  templateName: string,
  phases: string[],
  description: string,
  branch: string,
): void {
  const statePath = join(artifactDir, "STATE.json");
  const state: WorkflowState = {
    template: templateId,
    templateName,
    description,
    branch,
    phases: phases.map((p, i) => ({
      name: p,
      index: i,
      status: i === 0 ? "active" as const : "pending" as const,
    })),
    currentPhase: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifactDir,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Scan all workflow artifact directories for in-progress STATE.json files.
 * Returns workflows that were started but not completed.
 */
function findInProgressWorkflows(basePath: string): WorkflowState[] {
  const workflowsRoot = join(gsdRoot(basePath), "workflows");
  if (!existsSync(workflowsRoot)) return [];

  const results: WorkflowState[] = [];
  try {
    // Scan each category dir (bugfixes/, features/, spikes/, etc.)
    for (const category of readdirSync(workflowsRoot, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const categoryDir = join(workflowsRoot, category.name);

      for (const workflow of readdirSync(categoryDir, { withFileTypes: true })) {
        if (!workflow.isDirectory()) continue;
        const statePath = join(categoryDir, workflow.name, "STATE.json");
        if (!existsSync(statePath)) continue;

        try {
          const raw = readFileSync(statePath, "utf-8");
          const state = JSON.parse(raw) as WorkflowState;
          if (!state.completedAt) {
            results.push(state);
          }
        } catch { /* corrupted state file — skip */ }
      }
    }
  } catch { /* workflows dir unreadable — skip */ }

  // Sort by most recently updated
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

// ─── /gsd start ──────────────────────────────────────────────────────────────

export async function handleStart(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const trimmed = args.trim();

  // /gsd start --list → same as /gsd templates
  if (trimmed === "--list" || trimmed === "list") {
    ctx.ui.notify(listTemplates(), "info");
    return;
  }

  // ─── Auto-mode conflict guard ──────────────────────────────────────────
  // Workflow templates dispatch their own messages and switch git branches,
  // which would conflict with an active auto-mode dispatch loop.
  if (isAutoActive()) {
    ctx.ui.notify(
      "Cannot start a workflow template while auto-mode is running.\n" +
      "Run /gsd pause first, then /gsd start.",
      "warning",
    );
    return;
  }

  if (isAutoPaused()) {
    ctx.ui.notify(
      "Auto-mode is paused. Starting a workflow template will run independently.\n" +
      "The paused auto-mode session can be resumed later with /gsd auto.",
      "info",
    );
  }

  // ─── Resume detection ───────────────────────────────────────────────────
  // /gsd start --resume or /gsd start resume → resume in-progress workflow
  if (trimmed === "--resume" || trimmed === "resume") {
    const basePath = process.cwd();
    const inProgress = findInProgressWorkflows(basePath);
    if (inProgress.length === 0) {
      ctx.ui.notify("No in-progress workflows found.", "info");
      return;
    }

    // Resume the most recent one
    const wf = inProgress[0];
    const activePhase = wf.phases.find(p => p.status === "active");
    const completedCount = wf.phases.filter(p => p.status === "completed").length;

    ctx.ui.notify(
      `Resuming: ${wf.templateName}\n` +
      `Description: ${wf.description}\n` +
      `Progress: ${completedCount}/${wf.phases.length} phases completed\n` +
      `Current phase: ${activePhase?.name ?? "unknown"}\n` +
      `Branch: ${wf.branch}\n` +
      `Artifacts: ${wf.artifactDir}`,
      "info",
    );

    const workflowContent = loadWorkflowTemplate(wf.template);
    if (!workflowContent) {
      ctx.ui.notify(`Template "${wf.template}" workflow file not found.`, "warning");
      return;
    }

    const prompt = loadPrompt("workflow-start", {
      templateId: wf.template,
      templateName: wf.templateName,
      templateDescription: `RESUMING — pick up from phase "${activePhase?.name ?? "unknown"}" (${completedCount}/${wf.phases.length} phases done)`,
      phases: wf.phases.map(p => `${p.name}${p.status === "completed" ? " ✓" : p.status === "active" ? " ←" : ""}`).join(" → "),
      complexity: "resume",
      artifactDir: wf.artifactDir,
      branch: wf.branch,
      description: wf.description,
      issueRef: "(none)",
      date: new Date().toISOString().split("T")[0],
      workflowContent,
    });

    pi.sendMessage(
      { customType: "gsd-workflow-template", content: prompt, display: false },
      { triggerTurn: true },
    );
    return;
  }

  // Show in-progress workflows when /gsd start is called with no args
  if (!trimmed) {
    const basePath = process.cwd();
    const inProgress = findInProgressWorkflows(basePath);
    if (inProgress.length > 0) {
      const wf = inProgress[0];
      const activePhase = wf.phases.find(p => p.status === "active");
      const completedCount = wf.phases.filter(p => p.status === "completed").length;
      ctx.ui.notify(
        `In-progress workflow found:\n` +
        `  ${wf.templateName}: "${wf.description}"\n` +
        `  Phase ${completedCount + 1}/${wf.phases.length}: ${activePhase?.name ?? "unknown"}\n\n` +
        `Run /gsd start resume to continue it.\n`,
        "info",
      );
    }
  }

  // /gsd start --dry-run <template> → preview without executing
  const dryRun = trimmed.includes("--dry-run");
  const cleanedArgs = trimmed.replace(/--dry-run\s*/, "").trim();

  // Parse: first word might be a template name, rest is description
  const parts = cleanedArgs.split(/\s+/);
  const firstWord = parts[0] ?? "";

  // Check for --issue flag (bugfix shortcut)
  const issueMatch = cleanedArgs.match(/--issue\s+(\S+)/);
  const issueRef = issueMatch ? issueMatch[1] : null;

  // Try resolving first word as a template name
  let match: TemplateMatch | null = null;
  let description = "";

  if (firstWord) {
    match = resolveByName(firstWord);
    if (match) {
      // First word was a template name; rest is description
      description = parts.slice(1).join(" ").replace(/--issue\s+\S+/, "").trim();
    }
  }

  // If no explicit template, try auto-detection from the full input
  if (!match && cleanedArgs) {
    const detected = autoDetect(cleanedArgs);
    if (detected.length === 1 || (detected.length > 0 && detected[0].confidence === "high")) {
      match = detected[0];
      description = cleanedArgs;
      ctx.ui.notify(
        `Auto-detected template: ${match.template.name} (matched: "${match.matchedTrigger}")`,
        "info",
      );
    } else if (detected.length > 1) {
      const choices = detected.slice(0, 4).map(
        (m) => `  /gsd start ${m.id} ${cleanedArgs}`
      );
      ctx.ui.notify(
        `Multiple templates could match. Pick one:\n\n${choices.join("\n")}\n\nOr specify explicitly: /gsd start <template> <description>`,
        "info",
      );
      return;
    }
  }

  // No template resolved at all
  if (!match) {
    if (!trimmed) {
      ctx.ui.notify(
        "Usage: /gsd start <template> [description]\n\n" +
        "Templates:\n" +
        "  bugfix          Triage → fix → verify → ship\n" +
        "  small-feature   Scope → plan → implement → verify\n" +
        "  spike           Scope → research → synthesize\n" +
        "  hotfix          Fix → ship (minimal ceremony)\n" +
        "  refactor        Inventory → plan → migrate → verify\n" +
        "  security-audit  Scan → triage → remediate → re-scan\n" +
        "  dep-upgrade     Assess → upgrade → fix → verify\n" +
        "  full-project    Complete GSD with full ceremony\n\n" +
        "Examples:\n" +
        "  /gsd start bugfix fix login button not responding\n" +
        "  /gsd start spike evaluate auth libraries\n" +
        "  /gsd start hotfix critical: API returns 500\n\n" +
        "Flags:\n" +
        "  --dry-run       Preview what would happen without executing\n" +
        "  --issue <ref>   Link to a GitHub issue\n\n" +
        "Run /gsd templates for detailed template info.",
        "info",
      );
    } else {
      ctx.ui.notify(
        `No template matched "${firstWord}". Run /gsd start to see available templates.`,
        "warning",
      );
    }
    return;
  }

  // ─── Resolved template ───────────────────────────────────────────────────

  const templateId = match.id;
  const template = match.template;
  const basePath = process.cwd();
  const date = new Date().toISOString().split("T")[0];

  // Load the workflow template content — prefer a project/global plugin
  // override if one exists (same name, .md format).
  let workflowContent: string | null = null;
  const pluginOverride = resolvePlugin(basePath, templateId);
  if (pluginOverride && pluginOverride.source !== "bundled" && pluginOverride.format === "md") {
    try {
      workflowContent = readFileSync(pluginOverride.path, "utf-8");
    } catch { /* fall through to bundled */ }
  }
  if (workflowContent == null) {
    workflowContent = loadWorkflowTemplate(templateId);
  }
  if (!workflowContent) {
    ctx.ui.notify(
      `Template "${templateId}" is registered but its workflow file (${template.file}) hasn't been created yet.`,
      "warning",
    );
    return;
  }

  // ─── Dry-run mode: preview without executing ────────────────────────────

  if (dryRun) {
    const slug = slugify(description || templateId);
    const lines = [
      `DRY RUN — ${template.name} (${templateId})\n`,
      `Description: ${description || "(none)"}`,
      `Complexity:  ${template.estimated_complexity}`,
      `Phases:      ${template.phases.join(" → ")}`,
      "",
    ];
    if (template.artifact_dir) {
      const prefix = datePrefix();
      const num = getNextWorkflowNum(join(basePath, template.artifact_dir));
      lines.push(`Artifact dir: ${template.artifact_dir}${prefix}-${num}-${slug}`);
    } else {
      lines.push("Artifact dir: (none — hotfix mode)");
    }
    lines.push(`Branch:       gsd/${templateId}/${slug}`);
    if (issueRef) lines.push(`Issue:        ${issueRef}`);
    lines.push("", "No changes made. Remove --dry-run to execute.");
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  // ─── Route full-project to standard GSD workflow ────────────────────────

  if (templateId === "full-project") {
    const root = gsdRoot(basePath);
    if (!existsSync(root)) {
      ctx.ui.notify(
        "Routing to /gsd init for full project setup...",
        "info",
      );
      // Trigger /gsd init by dispatching to the handler
      pi.sendMessage(
        {
          customType: "gsd-workflow-template",
          content: "The user wants to start a full GSD project. Run `/gsd init` to bootstrap the project, then `/gsd auto` to begin execution.",
          display: false,
        },
        { triggerTurn: true },
      );
    } else {
      ctx.ui.notify(
        "Project already initialized. Use `/gsd auto` to continue or `/gsd discuss` to start a new milestone.",
        "info",
      );
    }
    return;
  }

  // ─── Create artifact directory ──────────────────────────────────────────

  let artifactDir = "";
  if (template.artifact_dir) {
    const slug = slugify(description || templateId);
    const prefix = datePrefix();
    const num = getNextWorkflowNum(join(basePath, template.artifact_dir));
    artifactDir = `${template.artifact_dir}${prefix}-${num}-${slug}`;
    mkdirSync(join(basePath, artifactDir), { recursive: true });
  }

  // ─── Create git branch (unless isolation: none) ─────────────────────────

  const git = createGitService(basePath);
  const skipBranch = git.prefs.isolation === "none";
  const slug = slugify(description || templateId);
  const branchName = `gsd/${templateId}/${slug}`;
  let branchCreated = false;

  if (!skipBranch) {
    try {
      const current = git.getCurrentBranch();
      if (current !== branchName) {
        try {
          git.autoCommit("workflow-template", templateId, []);
        } catch { /* nothing to commit */ }
        runGit(basePath, ["checkout", "-b", branchName]);
        branchCreated = true;
      }
    } catch (err) {
      const message = getErrorMessage(err);
      ctx.ui.notify(
        `Could not create branch ${branchName}: ${message}. Working on current branch.`,
        "warning",
      );
    }
  }

  const actualBranch = branchCreated ? branchName : git.getCurrentBranch();

  // ─── Write workflow state for resume support ────────────────────────────

  if (artifactDir) {
    writeWorkflowState(
      join(basePath, artifactDir),
      templateId,
      template.name,
      template.phases,
      description,
      actualBranch,
    );
  }

  // ─── Notify and dispatch ────────────────────────────────────────────────

  const infoLines = [
    `Starting workflow: ${template.name}`,
    `Phases: ${template.phases.join(" → ")}`,
  ];
  if (artifactDir) infoLines.push(`Artifacts: ${artifactDir}`);
  infoLines.push(`Branch: ${actualBranch}`);
  ctx.ui.notify(infoLines.join("\n"), "info");

  const prompt = loadPrompt("workflow-start", {
    templateId,
    templateName: template.name,
    templateDescription: template.description,
    phases: template.phases.join(" → "),
    complexity: template.estimated_complexity,
    artifactDir: artifactDir || "(none)",
    branch: actualBranch,
    description: description || "(none provided)",
    issueRef: issueRef || "(none)",
    date,
    workflowContent,
  });

  pi.sendMessage(
    {
      customType: "gsd-workflow-template",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}

// ─── /gsd templates ──────────────────────────────────────────────────────────

export async function handleTemplates(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = args.trim();

  // /gsd templates info <name>
  if (trimmed.startsWith("info ")) {
    const name = trimmed.replace(/^info\s+/, "").trim();
    const info = getTemplateInfo(name);
    if (info) {
      ctx.ui.notify(info, "info");
    } else {
      ctx.ui.notify(
        `Unknown template "${name}". Run /gsd templates to see available templates.`,
        "warning",
      );
    }
    return;
  }

  // /gsd templates — list all
  ctx.ui.notify(listTemplates(), "info");
}

/**
 * Return template IDs for autocomplete in /gsd templates info <name>.
 */
export function getTemplateCompletions(prefix: string): Array<{ value: string; label: string; description: string }> {
  try {
    const registry = loadRegistry();
    return Object.entries(registry.templates)
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, entry]) => ({
        value: `info ${id}`,
        label: id,
        description: entry.description,
      }));
  } catch {
    return [];
  }
}

// ─── Shared markdown-phase dispatcher (used by /gsd workflow <name>) ────────

/**
 * Dispatch a markdown-phase workflow plugin. Mirrors `handleStart`'s execution
 * branch for resolved templates, but accepts a pre-resolved plugin (from the
 * unified plugin resolver).
 *
 * Writes STATE.json into an artifact dir, creates a git branch, and dispatches
 * the `workflow-start` prompt.
 */
export function dispatchMarkdownPhasePlugin(
  plugin: WorkflowPlugin,
  description: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): void {
  if (plugin.meta.mode !== "markdown-phase") return;

  if (isAutoActive()) {
    ctx.ui.notify(
      "Cannot start a markdown-phase workflow while auto-mode is running.\n" +
      "Run /gsd pause first.",
      "warning",
    );
    return;
  }

  const templateId = plugin.name;
  const basePath = process.cwd();
  const date = new Date().toISOString().split("T")[0];
  let workflowContent: string;
  try {
    workflowContent = readFileSync(plugin.path, "utf-8");
  } catch (err) {
    ctx.ui.notify(
      `Failed to read template: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }

  // Create artifact directory.
  let artifactDir = "";
  if (plugin.meta.artifactDir) {
    const slug = slugify(description || templateId);
    const prefix = datePrefix();
    const num = getNextWorkflowNum(join(basePath, plugin.meta.artifactDir));
    artifactDir = `${plugin.meta.artifactDir}${prefix}-${num}-${slug}`;
    mkdirSync(join(basePath, artifactDir), { recursive: true });
  }

  // Create git branch unless isolation: none.
  const git = createGitService(basePath);
  const skipBranch = git.prefs.isolation === "none";
  const slug = slugify(description || templateId);
  const branchName = `gsd/${templateId}/${slug}`;
  let branchCreated = false;

  if (!skipBranch) {
    try {
      const current = git.getCurrentBranch();
      if (current !== branchName) {
        try { git.autoCommit("workflow-template", templateId, []); } catch { /* nothing to commit */ }
        runGit(basePath, ["checkout", "-b", branchName]);
        branchCreated = true;
      }
    } catch (err) {
      ctx.ui.notify(
        `Could not create branch ${branchName}: ${getErrorMessage(err)}. Working on current branch.`,
        "warning",
      );
    }
  }

  const actualBranch = branchCreated ? branchName : git.getCurrentBranch();

  // Write STATE.json.
  if (artifactDir && plugin.meta.phases && plugin.meta.phases.length > 0) {
    writeWorkflowState(
      join(basePath, artifactDir),
      templateId,
      plugin.meta.displayName,
      plugin.meta.phases,
      description,
      actualBranch,
    );
  }

  const infoLines = [
    `Starting workflow: ${plugin.meta.displayName}`,
    `Phases: ${(plugin.meta.phases ?? []).join(" → ")}`,
  ];
  if (artifactDir) infoLines.push(`Artifacts: ${artifactDir}`);
  infoLines.push(`Branch: ${actualBranch}`);
  ctx.ui.notify(infoLines.join("\n"), "info");

  const prompt = loadPrompt("workflow-start", {
    templateId,
    templateName: plugin.meta.displayName,
    templateDescription: plugin.meta.description ?? "",
    phases: (plugin.meta.phases ?? []).join(" → "),
    complexity: plugin.meta.complexity ?? "medium",
    artifactDir: artifactDir || "(none)",
    branch: actualBranch,
    description: description || "(none provided)",
    issueRef: "(none)",
    date,
    workflowContent,
  });

  pi.sendMessage(
    { customType: "gsd-workflow-template", content: prompt, display: false },
    { triggerTurn: true },
  );
}
