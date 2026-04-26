/**
 * GSD Prompt Loader
 *
 * Reads .md prompt templates from the prompts/ directory and substitutes
 * {{variable}} placeholders with provided values.
 *
 * Templates live at prompts/ relative to this module's directory.
 * They use {{variableName}} syntax for substitution.
 *
 * Templates are snapshotted shortly after module init via warmCache().
 * This keeps import/extension-registration fast while still preventing a
 * running session from being invalidated when another `gsd` launch overwrites
 * ~/.gsd/agent/ with newer templates via initResources(). Without caching, the
 * in-memory extension code (which knows variable set A) can read a newer
 * template from disk (which expects variable set B), causing a
 * "template declares {{X}} but no value was provided" crash mid-session.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { GSDError, GSD_PARSE_ERROR } from "./errors.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { logWarning } from "./workflow-logger.js";

type ExistsFn = (path: string) => boolean;

function hasRequiredExtensionAssets(rootDir: string, exists: ExistsFn = existsSync): boolean {
  return (
    exists(join(rootDir, "prompts")) &&
    exists(join(rootDir, "templates", "task-summary.md"))
  );
}

export function resolveExtensionDirFromCandidates(
  moduleDir: string,
  agentGsdDir: string,
  exists: ExistsFn = existsSync,
): string {
  const moduleUsable = hasRequiredExtensionAssets(moduleDir, exists);
  const agentUsable = hasRequiredExtensionAssets(agentGsdDir, exists);

  // Prefer the user-local extension tree when both are valid. This avoids
  // leaking npm/global-install paths into prompts on Windows.
  if (agentUsable) return agentGsdDir;
  if (moduleUsable) return moduleDir;

  // Degraded fallback: if required template is missing in both locations,
  // keep previous behavior and prefer whichever still has prompts/.
  if (exists(join(moduleDir, "prompts"))) return moduleDir;
  if (exists(join(agentGsdDir, "prompts"))) return agentGsdDir;
  return moduleDir;
}

/**
 * Resolve the GSD extension directory.
 *
 * `import.meta.url` resolves to whichever copy of this module is executing.
 * On Windows (npm global install via MSYS2 / Git Bash) this can resolve to
 * the npm-global `AppData/Roaming/npm/…` path, which does NOT contain the
 * prompts/ and templates/ subtrees that initResources() copies to
 * `~/.gsd/agent/extensions/gsd/`. Detect the mismatch and fall back to
 * the user-local agent directory.
 */
function resolveExtensionDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const gsdHome = process.env.GSD_HOME || join(homedir(), ".gsd");
  const agentGsdDir = join(gsdHome, "agent", "extensions", "gsd");
  return resolveExtensionDirFromCandidates(moduleDir, agentGsdDir);
}

const __extensionDir = resolveExtensionDir();
const promptsDir = join(__extensionDir, "prompts");
const templatesDir = join(__extensionDir, "templates");

/**
 * Return the resolved templates directory path for use in prompts.
 * Avoids hardcoding `~/.gsd/agent/extensions/gsd/templates/` in templates. (#3575)
 */
export function getTemplatesDir(): string {
  return templatesDir;
}

// Cache all templates from a startup snapshot — a running session uses the
// template versions that were on disk near startup, immune to later overwrites.
const templateCache = new Map<string, string>();

/**
 * Eagerly read all .md files from prompts/ and templates/ into cache.
 * Called once at module init so that every template is snapshot before
 * a concurrent initResources() can overwrite files on disk.
 */
function warmCache(): void {
  try {
    for (const file of readdirSync(promptsDir)) {
      if (!file.endsWith(".md")) continue;
      const name = file.slice(0, -3);
      if (!templateCache.has(name)) {
        templateCache.set(name, readFileSync(join(promptsDir, file), "utf-8"));
      }
    }
  } catch {
    // prompts/ may not exist in test environments — lazy loading still works.
    // Emit a diagnostic when running outside tests so wrong-path bugs are visible.
    if (!process.env.VITEST && !process.env.NODE_TEST) {
      logWarning("prompt", `warmCache: prompts dir not found: ${promptsDir}`);
    }
  }

  try {
    for (const file of readdirSync(templatesDir)) {
      if (!file.endsWith(".md")) continue;
      const cacheKey = `tpl:${file.slice(0, -3)}`;
      if (!templateCache.has(cacheKey)) {
        templateCache.set(cacheKey, readFileSync(join(templatesDir, file), "utf-8"));
      }
    }
  } catch {
    // templates/ may not exist in test environments — lazy loading still works.
    if (!process.env.VITEST && !process.env.NODE_TEST) {
      logWarning("prompt", `warmCache: templates dir not found: ${templatesDir}`);
    }
  }
}

let warmCacheScheduled = false;

function scheduleWarmCache(): void {
  if (warmCacheScheduled) return;
  warmCacheScheduled = true;

  const run = () => {
    warmCache();
  };

  const timer = setTimeout(run, 1000);
  timer.unref?.();
}

// Snapshot the full prompt/template tree after import so extension startup only
// pays for prompts that are actually needed immediately.
scheduleWarmCache();

/**
 * Load a prompt template and substitute variables.
 *
 * @param name - Template filename without .md extension (e.g. "execute-task")
 * @param vars - Key-value pairs to substitute for {{key}} placeholders
 */
export function loadPrompt(name: string, vars: Record<string, string> = {}): string {
  let content = templateCache.get(name);
  if (content === undefined) {
    const path = join(promptsDir, `${name}.md`);
    content = readFileSync(path, "utf-8");
    templateCache.set(name, content);
  }

  const effectiveVars = {
    skillActivation: "If a `GSD Skill Preferences` block is present in system context, use it and the `<available_skills>` catalog in your system prompt to decide which skills to load and follow for this unit, without relaxing required verification or artifact rules.",
    ...vars,
  };

  // Check BEFORE substitution: find all {{varName}} placeholders the template
  // declares and verify every one has a value in vars. Checking after substitution
  // would also flag {{...}} patterns injected by inlined content (e.g. template
  // files embedded in {{inlinedContext}}), producing false positives.
  const declared = content.match(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g);
  if (declared) {
    const missing = [...new Set(declared)]
      .map(m => m.slice(2, -2))
      .filter(key => !(key in effectiveVars));
    if (missing.length > 0) {
      throw new GSDError(
        GSD_PARSE_ERROR,
        `loadPrompt("${name}"): template declares {{${missing.join("}}, {{")}}}} but no value was provided. ` +
        `This usually means the extension code in memory is older than the template on disk. ` +
        `Restart pi to reload the extension.`,
      );
    }
  }

  for (const [key, value] of Object.entries(effectiveVars)) {
    const safeValue =
      key === "workingDirectory" && typeof value === "string"
        ? value.replaceAll("\\", "/")
        : value;

    // Use split/join instead of replaceAll to avoid JavaScript's special
    // replacement patterns ($', $`, $&) being interpreted in the value.
    // See: https://github.com/gsd-build/gsd-2/issues/2968
    content = content.split(`{{${key}}}`).join(safeValue);
  }

  return content.trim();
}

/**
 * Load a raw template file from the templates/ directory.
 * Cached with a `tpl:` prefix to avoid collisions with prompt cache keys.
 */
export function loadTemplate(name: string): string {
  const cacheKey = `tpl:${name}`;
  let content = templateCache.get(cacheKey);
  if (content === undefined) {
    const path = join(templatesDir, `${name}.md`);
    content = readFileSync(path, "utf-8");
    templateCache.set(cacheKey, content);
  }
  return content.trim();
}

/**
 * Load a template and wrap it with a labeled footer for inlining into prompts.
 * The template body is emitted first so that any YAML frontmatter (---) remains
 * at the first non-whitespace line of the template content.
 */
export function inlineTemplate(name: string, label: string): string {
  const content = loadTemplate(name);
  return `${content}\n\n### Output Template: ${label}\nSource: \`templates/${name}.md\``;
}
