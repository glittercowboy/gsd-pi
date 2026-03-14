/**
 * GSD Prompt Loader
 *
 * Reads .md prompt templates from the prompts/ directory and substitutes
 * {{variable}} placeholders with provided values.
 *
 * Templates live at prompts/ relative to this module's directory.
 * They use {{variableName}} syntax for substitution.
 *
 * Templates are cached on first read per session. This prevents a running
 * session from being invalidated when another `gsd` launch overwrites
 * ~/.gsd/agent/ with newer templates via initResources(). Without caching,
 * the in-memory extension code (which knows variable set A) can read a
 * newer template from disk (which expects variable set B), causing a
 * "template declares {{X}} but no value was provided" crash mid-session.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __extensionDir = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(__extensionDir, "prompts");
const templatesDir = join(__extensionDir, "templates");

// Cache templates on first read — a running session uses the template versions
// that were on disk when it first loaded them, immune to later overwrites.
const templateCache = new Map<string, string>();

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

  // Check BEFORE substitution: find all {{varName}} placeholders the template
  // declares and verify every one has a value in vars. Checking after substitution
  // would also flag {{...}} patterns injected by inlined content (e.g. template
  // files embedded in {{inlinedContext}}), producing false positives.
  const declared = content.match(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g);
  if (declared) {
    const missing = [...new Set(declared)]
      .map(m => m.slice(2, -2))
      .filter(key => !(key in vars));
    if (missing.length > 0) {
      throw new Error(
        `loadPrompt("${name}"): template declares {{${missing.join("}}, {{")}}}} but no value was provided. ` +
        `This usually means the extension code in memory is older than the template on disk. ` +
        `Restart pi to reload the extension.`
      );
    }
  }

  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
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
