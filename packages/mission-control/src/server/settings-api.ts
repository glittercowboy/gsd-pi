/**
 * Settings API — two-tier config (global + project) with merge.
 * Also discovers GSD 2 configuration from two sources:
 *
 *   ~/.claude/ (Claude Code / Anthropic provider):
 *     - Skills from ~/.claude/skills/
 *     - Commands from ~/.claude/commands/
 *     - Agents from ~/.claude/agents/
 *     - Plugins from ~/.claude/plugins/installed_plugins.json
 *     - Settings from ~/.claude/settings.json
 *
 *   ~/.gsd/ (provider-agnostic fallback for GitHub Copilot, OpenRouter, API Key users):
 *     - Skills from ~/.gsd/skills/
 *     - Commands from ~/.gsd/commands/
 *     - Agents from ~/.gsd/agents/
 *
 * Skills, commands, and agents are merged (union, deduplicated) so non-Claude-Code
 * users can place their assets in ~/.gsd/ and they will be discovered automatically.
 *
 * Project preferences are stored in {planningDir}/preferences.md as YAML frontmatter.
 * Parse with gray-matter; write back as YAML frontmatter block.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import matter from "gray-matter";

/** Override for testing — points to the .gsd directory (not homedir) */
let globalDirOverride: string | null = null;

/** Set global dir for test isolation. Pass null to reset. */
export function _setGlobalDir(dir: string | null): void {
  globalDirOverride = dir;
}

function getGlobalDir(): string {
  return globalDirOverride ?? join(homedir(), ".gsd");
}

function getClaudeDir(): string {
  return join(homedir(), ".claude");
}

function globalPath(): string {
  return join(getGlobalDir(), "defaults.json");
}

function projectPath(planningDir: string): string {
  return join(planningDir, "preferences.md");
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Read a preferences.md file and return the parsed YAML frontmatter data.
 * Returns empty object if file does not exist or has no frontmatter.
 */
async function readPreferencesMd(filePath: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(filePath, "utf-8");
    const { data } = matter(content);
    return data as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write GSD2Preferences data to a preferences.md file as YAML frontmatter.
 * Merges with existing frontmatter data (partial update).
 */
async function writePreferencesMd(filePath: string, updates: Record<string, unknown>): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const content = await readFile(filePath, "utf-8");
    existing = matter(content).data as Record<string, unknown>;
  } catch {
    // File doesn't exist yet — start fresh
  }
  const merged = { ...existing, ...updates };
  const output = matter.stringify("", merged);
  await writeFile(filePath, output);
}

async function listDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink() || e.name.endsWith(".md"))
      .map((e) => e.name.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

async function listSubcommands(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const commands: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        // Directory = command namespace (e.g., "gsd")
        const subDir = join(dirPath, e.name);
        const subEntries = await readdir(subDir).catch(() => []);
        for (const sub of subEntries) {
          if (typeof sub === "string" && sub.endsWith(".md")) {
            commands.push(`${e.name}:${sub.replace(/\.md$/, "")}`);
          }
        }
      } else if (e.name.endsWith(".md")) {
        commands.push(e.name.replace(/\.md$/, ""));
      }
    }
    return commands;
  } catch {
    return [];
  }
}

/**
 * Discover configuration from ~/.gsd/ — provider-agnostic fallback.
 * Used by non-Claude-Code providers (GitHub Copilot, OpenRouter, API Key).
 */
async function discoverGsdConfig(): Promise<{
  skills: string[];
  commands: string[];
  agents: string[];
}> {
  const gsdDir = getGlobalDir();
  const [skills, commands, agents] = await Promise.all([
    listDirNames(join(gsdDir, "skills")),
    listSubcommands(join(gsdDir, "commands")),
    listDirNames(join(gsdDir, "agents")).then((names) =>
      names.filter((n) => !n.startsWith("gsd-")),
    ),
  ]);
  return { skills, commands, agents };
}

/** Discover Claude Code configuration from filesystem. */
async function discoverClaudeConfig(): Promise<{
  skills: string[];
  commands: string[];
  agents: string[];
  plugins: Array<{ name: string; scope: string }>;
  claudeSettings: Record<string, unknown>;
}> {
  const claudeDir = getClaudeDir();

  const [claudeSkills, claudeCommands, claudeAgents, pluginsData, claudeSettings, gsd] =
    await Promise.all([
      listDirNames(join(claudeDir, "skills")),
      listSubcommands(join(claudeDir, "commands")),
      listDirNames(join(claudeDir, "agents")).then((names) =>
        names.filter((n) => !n.startsWith("gsd-")),
      ),
      readJsonSafe(join(claudeDir, "plugins", "installed_plugins.json")),
      readJsonSafe(join(claudeDir, "settings.json")),
      discoverGsdConfig(),
    ]);

  // Merge ~/.claude/ and ~/.gsd/ — ~/.gsd/ provides fallback for non-Claude-Code providers.
  // Union with deduplication: ~/.claude/ entries take precedence.
  const skills = [...new Set([...claudeSkills, ...gsd.skills])];
  const commands = [...new Set([...claudeCommands, ...gsd.commands])];
  const agents = [...new Set([...claudeAgents, ...gsd.agents])];

  // Parse plugins from installed_plugins.json
  const pluginEntries: Array<{ name: string; scope: string }> = [];
  const pluginMap = (pluginsData as Record<string, unknown>).plugins as
    | Record<string, Array<{ scope?: string }>>
    | undefined;
  if (pluginMap && typeof pluginMap === "object") {
    for (const [name, installs] of Object.entries(pluginMap)) {
      if (Array.isArray(installs) && installs.length > 0) {
        pluginEntries.push({
          name,
          scope: installs[0]?.scope ?? "user",
        });
      }
    }
  }

  // Extract enabled plugins from settings
  const enabledPlugins = claudeSettings.enabledPlugins as
    | Record<string, boolean>
    | undefined;

  return {
    skills,
    commands,
    agents,
    plugins: pluginEntries.map((p) => ({
      ...p,
      enabled: enabledPlugins?.[p.name] ?? false,
    })),
    claudeSettings,
  };
}

/**
 * Read settings from both tiers and return merged result.
 * Merged = { ...global, ...project } (project overrides global).
 * Also includes discovered configuration merged from ~/.claude/ and ~/.gsd/.
 */
export async function getSettings(
  planningDir: string,
): Promise<{
  global: Record<string, unknown>;
  project: Record<string, unknown>;
  merged: Record<string, unknown>;
  claude: Awaited<ReturnType<typeof discoverClaudeConfig>>;
}> {
  const [global, project, claude] = await Promise.all([
    readJsonSafe(globalPath()),
    readPreferencesMd(projectPath(planningDir)),
    discoverClaudeConfig(),
  ]);
  return {
    global,
    project,
    merged: { ...global, ...project },
    claude,
  };
}

/**
 * Save settings to the specified tier, merging with existing data.
 */
export async function saveSettings(
  tier: "global" | "project",
  settings: Record<string, unknown>,
  planningDir?: string,
): Promise<void> {
  const filePath =
    tier === "global" ? globalPath() : projectPath(planningDir!);

  // Ensure parent directory exists
  const dir = tier === "global" ? getGlobalDir() : planningDir!;
  await mkdir(dir, { recursive: true });

  if (tier === "global") {
    // Global tier: JSON file (defaults.json)
    const existing = await readJsonSafe(filePath);
    const merged = { ...existing, ...settings };
    await writeFile(filePath, JSON.stringify(merged, null, 2));
  } else {
    // Project tier: preferences.md — YAML frontmatter
    await writePreferencesMd(filePath, settings);
  }
}

/**
 * HTTP request handler for /api/settings routes.
 * Returns Response or null if route not matched.
 */
export async function handleSettingsRequest(
  req: Request,
  url: URL,
  planningDir: string,
): Promise<Response | null> {
  const { pathname } = url;

  // GET /api/settings — return merged settings + claude config
  if (pathname === "/api/settings" && req.method === "GET") {
    const result = await getSettings(planningDir);
    return Response.json(result);
  }

  // PUT /api/settings — save settings to a tier
  if (pathname === "/api/settings" && req.method === "PUT") {
    let body: { tier?: string; settings?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { tier, settings } = body;

    if (!tier || !settings || (tier !== "global" && tier !== "project")) {
      return Response.json(
        {
          error:
            "Body must include tier ('global'|'project') and settings object",
        },
        { status: 400 },
      );
    }

    if (tier === "project" && !planningDir) {
      return Response.json(
        {
          error:
            "Cannot save project settings: no planning directory configured",
        },
        { status: 400 },
      );
    }

    await saveSettings(
      tier as "global" | "project",
      settings,
      planningDir || undefined,
    );

    return Response.json({ saved: true, tier });
  }

  return null;
}
