/**
 * GSD Workflow Templates — Registry & Resolution
 *
 * Loads the workflow template registry and resolves templates by name,
 * alias, or trigger-keyword matching against user input.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __extensionDir = resolveGsdExtensionDir();
const registryPath = join(__extensionDir, "workflow-templates", "registry.json");

/** Resolve the GSD extension dir with fallback to ~/.gsd/agent/extensions/gsd/. */
function resolveGsdExtensionDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  if (existsSync(join(moduleDir, "workflow-templates"))) return moduleDir;
  const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
  const agentGsdDir = join(gsdHome, "agent", "extensions", "gsd");
  if (existsSync(join(agentGsdDir, "workflow-templates"))) return agentGsdDir;
  return moduleDir;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TemplateEntry {
  name: string;
  description: string;
  file: string;
  phases: string[];
  triggers: string[];
  artifact_dir: string | null;
  estimated_complexity: string;
  requires_project: boolean;
}

export interface TemplateRegistry {
  version: number;
  templates: Record<string, TemplateEntry>;
}

export interface TemplateMatch {
  id: string;
  template: TemplateEntry;
  confidence: "exact" | "high" | "medium" | "low";
  matchedTrigger?: string;
}

// ─── Registry Cache ──────────────────────────────────────────────────────────

let cachedRegistry: TemplateRegistry | null = null;

/**
 * Load and cache the workflow template registry.
 */
export function loadRegistry(): TemplateRegistry {
  if (cachedRegistry) return cachedRegistry;

  if (!existsSync(registryPath)) {
    cachedRegistry = { version: 1, templates: {} };
    return cachedRegistry;
  }

  try {
    const content = readFileSync(registryPath, "utf-8");
    cachedRegistry = JSON.parse(content) as TemplateRegistry;
  } catch {
    cachedRegistry = { version: 1, templates: {} };
  }
  return cachedRegistry;
}

/**
 * Resolve a template by exact name or alias.
 * Returns null if no match found.
 */
export function resolveByName(nameOrAlias: string): TemplateMatch | null {
  const registry = loadRegistry();
  const normalized = nameOrAlias.toLowerCase().trim();

  // Exact key match
  if (registry.templates[normalized]) {
    return {
      id: normalized,
      template: registry.templates[normalized],
      confidence: "exact",
    };
  }

  // Match by template name (case-insensitive)
  for (const [id, entry] of Object.entries(registry.templates)) {
    if (entry.name.toLowerCase() === normalized) {
      return { id, template: entry, confidence: "exact" };
    }
  }

  // Fuzzy: prefix match on id
  for (const [id, entry] of Object.entries(registry.templates)) {
    if (id.startsWith(normalized) || normalized.startsWith(id)) {
      return { id, template: entry, confidence: "high" };
    }
  }

  // Common aliases
  const aliases: Record<string, string> = {
    "bug": "bugfix",
    "fix": "bugfix",
    "feature": "small-feature",
    "feat": "small-feature",
    "research": "spike",
    "investigate": "spike",
    "hot": "hotfix",
    "urgent": "hotfix",
    "security": "security-audit",
    "audit": "security-audit",
    "upgrade": "dep-upgrade",
    "deps": "dep-upgrade",
    "update-deps": "dep-upgrade",
    "migration": "refactor",
    "project": "full-project",
    "full": "full-project",
  };

  const aliasMatch = aliases[normalized];
  if (aliasMatch && registry.templates[aliasMatch]) {
    return {
      id: aliasMatch,
      template: registry.templates[aliasMatch],
      confidence: "high",
    };
  }

  return null;
}

/**
 * Auto-detect the best template based on user description text.
 * Returns ranked matches sorted by confidence.
 */
export function autoDetect(description: string): TemplateMatch[] {
  const registry = loadRegistry();
  const lower = description.toLowerCase();
  const words = lower.split(/\s+/);
  const matches: TemplateMatch[] = [];

  for (const [id, entry] of Object.entries(registry.templates)) {
    let bestScore = 0;
    let bestTrigger = "";

    for (const trigger of entry.triggers) {
      const triggerLower = trigger.toLowerCase();

      // Exact phrase match in description
      if (lower.includes(triggerLower)) {
        const score = triggerLower.split(/\s+/).length * 2; // multi-word triggers score higher
        if (score > bestScore) {
          bestScore = score;
          bestTrigger = trigger;
        }
        continue;
      }

      // Single-word trigger match against description words
      if (!triggerLower.includes(" ") && words.includes(triggerLower)) {
        if (1 > bestScore) {
          bestScore = 1;
          bestTrigger = trigger;
        }
      }
    }

    if (bestScore > 0) {
      const confidence = bestScore >= 4 ? "high" : bestScore >= 2 ? "medium" : "low";
      matches.push({
        id,
        template: entry,
        confidence,
        matchedTrigger: bestTrigger,
      });
    }
  }

  // Sort by confidence (high > medium > low), then alphabetically
  const order = { exact: 0, high: 1, medium: 2, low: 3 };
  matches.sort((a, b) => order[a.confidence] - order[b.confidence] || a.id.localeCompare(b.id));

  return matches;
}

/**
 * List all templates as formatted text for display.
 */
export function listTemplates(): string {
  const registry = loadRegistry();
  const lines: string[] = ["Workflow Templates\n"];

  for (const [id, entry] of Object.entries(registry.templates)) {
    const phases = entry.phases.join(" → ");
    const complexity = entry.estimated_complexity;
    lines.push(`  ${id.padEnd(16)} ${entry.name}`);
    lines.push(`  ${"".padEnd(16)} ${entry.description}`);
    lines.push(`  ${"".padEnd(16)} Phases: ${phases}  |  Complexity: ${complexity}`);
    lines.push("");
  }

  lines.push("Usage: /gsd start <template> [description]");
  lines.push("       /gsd templates info <name>");

  return lines.join("\n");
}

/**
 * Get detailed info about a specific template.
 */
export function getTemplateInfo(name: string): string | null {
  const match = resolveByName(name);
  if (!match) return null;

  const { id, template: t } = match;
  const lines = [
    `Template: ${t.name} (${id})`,
    "",
    `Description: ${t.description}`,
    `Complexity:  ${t.estimated_complexity}`,
    `Requires .gsd/: ${t.requires_project ? "yes" : "no"}`,
    "",
    "Phases:",
    ...t.phases.map((p, i) => `  ${i + 1}. ${p}`),
    "",
    "Triggers:",
    `  ${t.triggers.join(", ")}`,
  ];

  if (t.artifact_dir) {
    lines.push("", `Artifacts: ${t.artifact_dir}`);
  }

  const templateFilePath = join(__extensionDir, "workflow-templates", t.file);
  if (existsSync(templateFilePath)) {
    lines.push("", "Template file: loaded");
  } else {
    lines.push("", "Template file: not yet created");
  }

  return lines.join("\n");
}

/**
 * Load the raw content of a workflow template .md file.
 */
export function loadWorkflowTemplate(templateId: string): string | null {
  const match = resolveByName(templateId);
  if (!match) return null;

  const filePath = join(__extensionDir, "workflow-templates", match.template.file);
  if (!existsSync(filePath)) return null;

  return readFileSync(filePath, "utf-8");
}
