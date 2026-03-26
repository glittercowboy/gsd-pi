import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { SettingsManager, getAgentDir } from "@gsd/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { PluginImporter, type ImportManifestEntry } from "./plugin-importer.js";
import type { NamespacedComponent } from "./namespaced-registry.js";

export interface ClaudeSkillCandidate {
  type: "skill";
  name: string;
  path: string;
  root: string;
  sourceLabel: string;
}

export interface ClaudePluginCandidate {
  type: "plugin";
  name: string;
  path: string;
  root: string;
  sourceLabel: string;
  packageName?: string;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".worktrees",
  "dist",
  "build",
  ".next",
  ".turbo",
  "cache",
  ".cache",
]);

function uniqueExistingDirs(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const resolvedPath = resolve(candidate);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    if (existsSync(resolvedPath)) out.push(resolvedPath);
  }
  return out;
}

export function getClaudeSearchRoots(cwd: string): { skillRoots: string[]; pluginRoots: string[] } {
  const home = homedir();
  const parent = resolve(cwd, "..");
  const grandparent = resolve(cwd, "..", "..");

  // Claude Code user-scope skills live under ~/.claude/skills.
  // Keep sibling/local clone fallbacks for developer workflows, but they are
  // examples/convenience paths rather than the primary Claude storage model.
  const skillRoots = uniqueExistingDirs([
    join(home, ".claude", "skills"),
    join(home, "repos", "claude_skills"),
    join(home, "repos", "skills"),
    join(parent, "claude_skills"),
    join(parent, "skills"),
    join(grandparent, "claude_skills"),
    join(grandparent, "skills"),
  ]);

  // Anthropic docs model marketplaces as sources users add with
  // `/plugin marketplace add ...`, and Claude stores those marketplaces under
  // ~/.claude/plugins/marketplaces/. Installed plugin payloads are copied into
  // ~/.claude/plugins/cache/. We prefer those stable Claude-managed locations
  // before local example clones.
  const pluginRoots = uniqueExistingDirs([
    join(home, ".claude", "plugins", "marketplaces"),
    join(home, ".claude", "plugins", "cache"),
    join(home, ".claude", "plugins"),
    join(home, "repos", "claude-plugins-official"),
    join(home, "repos", "claude_skills"),
    join(parent, "claude-plugins-official"),
    join(parent, "claude_skills"),
    join(grandparent, "claude-plugins-official"),
    join(grandparent, "claude_skills"),
  ]);

  return { skillRoots, pluginRoots };
}

function sourceLabel(path: string): string {
  const home = homedir();
  if (path.startsWith(join(home, ".claude"))) return "claude-home";
  if (path.startsWith(join(home, "repos"))) return "repos";
  return "local";
}

/**
 * Check if a path is a marketplace directory (contains .claude-plugin/marketplace.json).
 * Marketplace paths use the PluginImporter flow; non-marketplace use the legacy flat flow.
 */
function isMarketplacePath(pluginPath: string): boolean {
  const marketplaceJson = join(pluginPath, ".claude-plugin", "marketplace.json");
  return existsSync(marketplaceJson);
}

/**
 * Detect which plugin roots are marketplaces and which are legacy flat paths.
 *
 * Claude Code stores marketplace sources under ~/.claude/plugins/marketplaces/.
 * Each subdirectory (e.g. marketplaces/confluent/) is a marketplace repo that
 * contains .claude-plugin/marketplace.json. The parent directory itself does not
 * have a marketplace.json, so we scan one level deeper when the root isn't
 * directly a marketplace.
 */
export function categorizePluginRoots(pluginRoots: string[]): { marketplaces: string[]; flat: string[] } {
  const marketplaces: string[] = [];
  const flat: string[] = [];
  const seen = new Set<string>();

  for (const root of pluginRoots) {
    if (isMarketplacePath(root)) {
      if (!seen.has(root)) {
        marketplaces.push(root);
        seen.add(root);
      }
    } else {
      // The root itself isn't a marketplace — check if it's a container of
      // marketplaces (e.g. ~/.claude/plugins/marketplaces/ contains subdirs
      // like confluent/, claude-hud/, each with their own marketplace.json).
      let foundChild = false;
      try {
        const entries = readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (SKIP_DIRS.has(entry.name)) continue;
          const childPath = join(root, entry.name);
          if (isMarketplacePath(childPath) && !seen.has(childPath)) {
            marketplaces.push(childPath);
            seen.add(childPath);
            foundChild = true;
          }
        }
      } catch {
        // Can't read directory — fall through to flat
      }
      if (!foundChild) {
        flat.push(root);
      }
    }
  }

  return { marketplaces, flat };
}

function walkDirs(root: string, visit: (dir: string, depth: number) => void, maxDepth = 4): void {
  function walk(dir: string, depth: number) {
    visit(dir, depth);
    if (depth >= maxDepth) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  }
  walk(root, 0);
}

export function discoverClaudeSkills(cwd: string): ClaudeSkillCandidate[] {
  const { skillRoots } = getClaudeSearchRoots(cwd);
  const results: ClaudeSkillCandidate[] = [];
  const seen = new Set<string>();

  for (const root of skillRoots) {
    walkDirs(root, (dir) => {
      const skillFile = join(dir, "SKILL.md");
      if (!existsSync(skillFile)) return;
      const resolvedDir = resolve(dir);
      if (seen.has(resolvedDir)) return;
      seen.add(resolvedDir);
      results.push({
        type: "skill",
        name: basename(dir),
        path: resolvedDir,
        root,
        sourceLabel: sourceLabel(root),
      });
    }, 5);
  }

  return results.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export function discoverClaudePlugins(cwd: string): ClaudePluginCandidate[] {
  const { pluginRoots } = getClaudeSearchRoots(cwd);
  const results: ClaudePluginCandidate[] = [];
  const seen = new Set<string>();

  for (const root of pluginRoots) {
    walkDirs(root, (dir) => {
      // Recognize both npm-style plugins (package.json) and Claude Code plugins
      // (.claude-plugin/plugin.json). Claude marketplace-installed plugins use
      // the latter format exclusively.
      const pkgPath = join(dir, "package.json");
      const claudePluginPath = join(dir, ".claude-plugin", "plugin.json");
      const hasPkg = existsSync(pkgPath);
      const hasClaudePlugin = existsSync(claudePluginPath);
      if (!hasPkg && !hasClaudePlugin) return;

      const resolvedDir = resolve(dir);
      if (seen.has(resolvedDir)) return;
      seen.add(resolvedDir);

      let packageName: string | undefined;
      if (hasPkg) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
          packageName = pkg.name;
        } catch {
          packageName = undefined;
        }
      } else if (hasClaudePlugin) {
        try {
          const manifest = JSON.parse(readFileSync(claudePluginPath, "utf8")) as { name?: string };
          packageName = manifest.name;
        } catch {
          packageName = undefined;
        }
      }

      results.push({
        type: "plugin",
        name: packageName || basename(dir),
        packageName,
        path: resolvedDir,
        root,
        sourceLabel: sourceLabel(root),
      });
    }, 4);
  }

  return results.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

async function chooseMany<T extends { name: string; path: string; root: string; sourceLabel: string }>(
  ctx: ExtensionCommandContext,
  title: string,
  candidates: T[],
): Promise<T[]> {
  if (candidates.length === 0) return [];

  const mode = await ctx.ui.select(`${title} (${candidates.length} found)`, [
    "Import all discovered",
    "Select individually",
    "Cancel",
  ]);

  if (!mode || mode === "Cancel") return [];
  if (mode === "Import all discovered") return candidates;

  const remaining = [...candidates];
  const selected: T[] = [];
  while (remaining.length > 0) {
    const options = [
      ...remaining.map((item) => `${item.name} — ${item.sourceLabel} — ${relative(item.root, item.path) || "."}`),
      "Done selecting",
    ];
    const picked = await ctx.ui.select(`${title}: choose an item`, options);
    if (!picked || picked === "Done selecting") break;
    const pickedStr = Array.isArray(picked) ? picked[0] : picked;
    if (!pickedStr) break;
    const idx = options.indexOf(pickedStr);
    if (idx < 0 || idx >= remaining.length) break;
    selected.push(remaining[idx]!);
    remaining.splice(idx, 1);
  }
  return selected;
}

function mergeStringList(existing: unknown, additions: string[]): string[] {
  const list = Array.isArray(existing) ? existing.filter((v): v is string => typeof v === "string") : [];
  const seen = new Set(list);
  for (const item of additions) {
    if (!seen.has(item)) {
      list.push(item);
      seen.add(item);
    }
  }
  return list;
}

function mergePackageSources(existing: unknown, additions: string[]): Array<string | { source: string }> {
  const current = Array.isArray(existing)
    ? existing.filter((v): v is string | { source: string } => typeof v === "string" || (typeof v === "object" && v !== null && typeof (v as { source?: unknown }).source === "string"))
    : [];

  const seen = new Set(current.map((entry) => typeof entry === "string" ? entry : entry.source));
  const merged = [...current];
  for (const add of additions) {
    if (!seen.has(add)) {
      merged.push(add);
      seen.add(add);
    }
  }
  return merged;
}

// ============================================================================
// Marketplace PluginImporter Integration (T02)
// ============================================================================

/**
 * Component candidate from marketplace discovery.
 * Extends NamespacedComponent with UI-friendly fields.
 */
interface MarketplaceComponentCandidate {
  component: NamespacedComponent;
  displayName: string;
  pluginName: string;
}

/**
 * Format a component for display in selection UI.
 */
function formatComponentForSelection(comp: NamespacedComponent): string {
  const typeLabel = comp.type === 'skill' ? '🔧' : '🤖';
  const nsLabel = comp.namespace ? `${comp.namespace}:` : '';
  return `${typeLabel} ${nsLabel}${comp.name}`;
}

/**
 * Present marketplace components for user selection, grouped by plugin.
 * Returns the selected components for import.
 */
async function selectMarketplaceComponents(
  ctx: ExtensionCommandContext,
  importer: PluginImporter,
  scope: "global" | "project"
): Promise<NamespacedComponent[]> {
  const plugins = importer.getDiscoveredPlugins();

  if (plugins.length === 0) {
    ctx.ui.notify("No plugins discovered in marketplace.", "info");
    return [];
  }

  // Build component candidates grouped by plugin
  const allComponents: MarketplaceComponentCandidate[] = [];
  for (const plugin of plugins) {
    const components = importer.selectComponents(c => c.namespace === plugin.canonicalName);
    for (const comp of components) {
      allComponents.push({
        component: comp,
        displayName: formatComponentForSelection(comp),
        pluginName: plugin.canonicalName,
      });
    }
  }

  if (allComponents.length === 0) {
    ctx.ui.notify("No components (skills/agents) found in marketplace plugins.", "info");
    return [];
  }

  // Ask user for selection mode
  const mode = await ctx.ui.select(
    `Marketplace components → ${scope} config (${allComponents.length} found across ${plugins.length} plugins)`,
    [
      "Import all components",
      "Select by plugin",
      "Select individually",
      "Cancel",
    ]
  );

  if (!mode || mode === "Cancel") return [];

  if (mode === "Import all components") {
    return allComponents.map(c => c.component);
  }

  if (mode === "Select by plugin") {
    // Let user select plugins, then import all their components
    const pluginNames = plugins.map(p => p.canonicalName);
    const selectedPluginNames: string[] = [];

    while (true) {
      const remaining = pluginNames.filter(n => !selectedPluginNames.includes(n));
      if (remaining.length === 0) break;

      const options = [...remaining, "Done selecting"];
      const picked = await ctx.ui.select("Select a plugin to import all its components", options);

      if (!picked || picked === "Done selecting") break;
      const pickedStr = Array.isArray(picked) ? picked[0] : picked;
      if (!pickedStr) break;
      selectedPluginNames.push(pickedStr);
    }

    return allComponents
      .filter(c => selectedPluginNames.includes(c.pluginName))
      .map(c => c.component);
  }

  // Select individually
  const remaining = [...allComponents];
  const selected: NamespacedComponent[] = [];

  while (remaining.length > 0) {
    const options = remaining.map(c =>
      `${c.displayName} — ${c.pluginName}`
    );
    options.push("Done selecting");

    const picked = await ctx.ui.select("Select a component to import", options);
    if (!picked || picked === "Done selecting") break;
    const pickedStr = Array.isArray(picked) ? picked[0] : picked;
    if (!pickedStr) break;

    const idx = options.indexOf(pickedStr);
    if (idx < 0 || idx >= remaining.length) break;

    selected.push(remaining[idx]!.component);
    remaining.splice(idx, 1);
  }

  return selected;
}

/**
 * Format diagnostics for display to user.
 * Returns a human-readable summary string.
 */
function formatDiagnosticsForUser(
  diagnostics: Array<{ severity: string; class: string; remediation: string; involvedCanonicalNames: string[] }>
): string {
  const lines: string[] = [];

  const errors = diagnostics.filter(d => d.severity === 'error');
  const warnings = diagnostics.filter(d => d.severity === 'warning');

  if (errors.length > 0) {
    lines.push(`❌ ${errors.length} error(s) blocking import:`);
    for (const err of errors) {
      lines.push(`   - ${err.class}: ${err.involvedCanonicalNames.join(', ')}`);
      lines.push(`     ${err.remediation}`);
    }
  }

  if (warnings.length > 0) {
    lines.push(`⚠️ ${warnings.length} warning(s):`);
    for (const warn of warnings) {
      lines.push(`   - ${warn.class}: ${warn.involvedCanonicalNames.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Persist import manifest entries to settings.
 * Maps manifest entries to the appropriate settings format.
 */
function persistManifestToSettings(
  manifestEntries: ImportManifestEntry[],
  settingsManager: SettingsManager,
  scope: "global" | "project"
): void {
  // Group entries by namespace for organized persistence
  const skillPaths = manifestEntries
    .filter(e => e.type === 'skill')
    .map(e => e.filePath);

  const agentPaths = manifestEntries
    .filter(e => e.type === 'agent')
    .map(e => e.filePath);

  // For marketplace plugins, we also want to store plugin-level metadata
  // Currently this adds component paths to skills/agents lists
  // Future enhancement: store canonical names with metadata

  if (skillPaths.length > 0) {
    if (scope === "project") {
      settingsManager.setProjectSkillPaths(
        mergeStringList(settingsManager.getProjectSettings().skills, skillPaths)
      );
    } else {
      settingsManager.setSkillPaths(
        mergeStringList(settingsManager.getGlobalSettings().skills, skillPaths)
      );
    }
  }

  // Do not persist imported marketplace agents into settings.packages.
  // Claude plugin agent directories contain markdown agent definitions, not loadable Pi
  // extension packages. Writing `.../agents` paths into packages makes startup treat
  // them as extension roots and produces module-load errors.
  //
  // For now, marketplace agents remain discoverable via the import manifest and
  // canonical metadata, but are not persisted into package sources.
}


export async function runClaudeImportFlow(
  ctx: ExtensionCommandContext,
  scope: "global" | "project",
  readPrefs: () => Record<string, unknown>,
  writePrefs: (prefs: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const cwd = process.cwd();
  const settingsManager = SettingsManager.create(cwd, getAgentDir());
  const { skillRoots, pluginRoots } = getClaudeSearchRoots(cwd);

  // Categorize plugin roots into marketplaces vs flat paths
  const { marketplaces, flat } = categorizePluginRoots(pluginRoots);

  // Determine import mode
  const assetChoice = await ctx.ui.select("Import Claude assets into GSD/Pi config", [
    "Skills + plugins",
    "Skills only",
    "Plugins only",
    "Cancel",
  ]);
  if (!assetChoice || assetChoice === "Cancel") return;

  const importSkills = assetChoice !== "Plugins only";
  const importPlugins = assetChoice !== "Skills only";

  // Track what we're importing
  let importedSkillsCount = 0;
  let importedPluginsCount = 0;
  let importedMarketplaceComponents = 0;
  const canonicalNamesPersisted: string[] = [];

  // ========== SKILLS (legacy flat flow) ==========
  if (importSkills) {
    const discoveredSkills = discoverClaudeSkills(cwd);
    const selectedSkills = await chooseMany(ctx, `Claude skills → ${scope} preferences`, discoveredSkills);

    if (selectedSkills.length > 0) {
      const prefMode = await ctx.ui.select("How should GSD treat the imported skills?", [
        "Always use when relevant",
        "Prefer when relevant",
        "Do not modify skill preferences",
      ]);

      const prefs = readPrefs();
      const skillPaths = selectedSkills.map((skill) => skill.path);
      if (prefMode === "Always use when relevant") {
        prefs.always_use_skills = mergeStringList(prefs.always_use_skills, skillPaths);
      } else if (prefMode === "Prefer when relevant") {
        prefs.prefer_skills = mergeStringList(prefs.prefer_skills, skillPaths);
      }

      await writePrefs(prefs);

      if (scope === "project") {
        settingsManager.setProjectSkillPaths(mergeStringList(settingsManager.getProjectSettings().skills, skillPaths));
      } else {
        settingsManager.setSkillPaths(mergeStringList(settingsManager.getGlobalSettings().skills, skillPaths));
      }

      importedSkillsCount = selectedSkills.length;
    }
  }

  // ========== MARKETPLACE PLUGINS (new PluginImporter flow) ==========
  if (importPlugins && marketplaces.length > 0) {
    const marketplaceChoice = await ctx.ui.select(
      `Found ${marketplaces.length} marketplace(s). Import from marketplace?`,
      [
        "Yes - discover plugins and select components",
        "Skip marketplaces (use legacy plugin paths only)",
        "Cancel",
      ]
    );

    if (marketplaceChoice === "Yes - discover plugins and select components") {
      // Instantiate PluginImporter and discover
      const importer = new PluginImporter();
      const discovery = importer.discover(marketplaces);

      if (discovery.summary.totalPlugins > 0) {
        // Present components for selection
        const selectedComponents = await selectMarketplaceComponents(ctx, importer, scope);

        if (selectedComponents.length > 0) {
          // Run validation (pre-import diagnostics)
          const validation = importer.validateImport(selectedComponents);

          // Show diagnostics
          if (validation.diagnostics.length > 0) {
            const diagMessage = formatDiagnosticsForUser(validation.diagnostics);
            ctx.ui.notify(diagMessage, validation.canProceed ? "warning" : "error");

            // Block if errors exist
            if (!validation.canProceed) {
              ctx.ui.notify(
                "Import blocked due to canonical name conflicts. Please resolve the errors above.",
                "error"
              );
              return;
            }

            // Warn but allow proceed for warnings
            const proceed = await ctx.ui.select(
              "Warnings detected. Continue with import?",
              ["Yes, continue", "Cancel"]
            );
            if (proceed !== "Yes, continue") {
              return;
            }
          }

          // Generate manifest and persist
          const manifest = importer.getImportManifest(selectedComponents);
          persistManifestToSettings(manifest.entries, settingsManager, scope);

          importedMarketplaceComponents = selectedComponents.length;
          canonicalNamesPersisted.push(...manifest.entries.map(e => e.canonicalName));
        }
      } else {
        ctx.ui.notify(`No plugins discovered in ${marketplaces.length} marketplace(s).`, "info");
      }
    }
  }

  // ========== FLAT PLUGIN PATHS (legacy flow) ==========
  if (importPlugins && flat.length > 0) {
    // Use legacy discovery for non-marketplace paths
    const discoveredPlugins: ClaudePluginCandidate[] = [];
    const seen = new Set<string>();

    for (const root of flat) {
      walkDirs(root, (dir) => {
        const pkgPath = join(dir, "package.json");
        if (!existsSync(pkgPath)) return;
        const resolvedDir = resolve(dir);
        if (seen.has(resolvedDir)) return;
        seen.add(resolvedDir);
        let packageName: string | undefined;
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
          packageName = pkg.name;
        } catch {
          packageName = undefined;
        }
        discoveredPlugins.push({
          type: "plugin",
          name: packageName || basename(dir),
          packageName,
          path: resolvedDir,
          root,
          sourceLabel: sourceLabel(root),
        });
      }, 4);
    }

    const sortedPlugins = discoveredPlugins.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    const selectedPlugins = await chooseMany(ctx, `Claude plugins/packages → ${scope} Pi settings`, sortedPlugins);

    if (selectedPlugins.length > 0) {
      const pluginPaths = selectedPlugins.map((plugin) => plugin.path);
      if (scope === "project") {
        settingsManager.setProjectPackages(mergePackageSources(settingsManager.getProjectSettings().packages, pluginPaths));
      } else {
        settingsManager.setPackages(mergePackageSources(settingsManager.getGlobalSettings().packages, pluginPaths));
      }
      importedPluginsCount = selectedPlugins.length;
    }
  }

  // ========== FINAL SUMMARY ==========
  if (importedSkillsCount === 0 && importedPluginsCount === 0 && importedMarketplaceComponents === 0) {
    ctx.ui.notify("Claude import cancelled or nothing selected.", "info");
    return;
  }

  await ctx.waitForIdle();
  await ctx.reload();

  const lines = [
    `Imported Claude assets into ${scope} config:`,
    `- Skills (flat): ${importedSkillsCount}`,
    `- Plugins (flat paths): ${importedPluginsCount}`,
    `- Marketplace components: ${importedMarketplaceComponents}`,
  ];
  if (importedSkillsCount > 0) {
    lines.push(`- Skill paths added to Pi settings (${scope}) for availability`);
    lines.push(`- Skill refs added to GSD preferences (${scope}) when selected`);
  }
  if (importedPluginsCount > 0) {
    lines.push(`- Plugin/package paths added to Pi settings (${scope}) packages`);
  }
  if (importedMarketplaceComponents > 0) {
    lines.push(`- Canonical names preserved: ${canonicalNamesPersisted.length} entries`);
    if (canonicalNamesPersisted.length <= 10) {
      lines.push(`  Names: ${canonicalNamesPersisted.join(', ')}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
