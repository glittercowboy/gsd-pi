// GSD Community Hooks — Context Loader
//
// Automatically injects relevant documentation into the agent's context based
// on which files or directories the user mentions. Looks for README, ADR,
// ARCHITECTURE, and CONTRIBUTING files near the mentioned paths.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { recordFire, recordAction } from "./stats.js";

/** Max size for injected context files (16KB). */
const MAX_FILE_SIZE = 16 * 1024;

/** Files to look for in directories near mentioned paths. */
const CONTEXT_FILES = [
  "README.md",
  "README",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "CHANGELOG.md",
];

/** ADR directory patterns. */
const ADR_DIRS = ["adr", "adrs", "decisions", "docs/adr", "docs/decisions"];

/** Pull file paths mentioned in the user's prompt. */
function extractPaths(text: string): string[] {
  const paths: string[] = [];

  const patterns = [
    /["'`]([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})["'`]/g,
    /["'`]([a-zA-Z0-9_./-]+\/)["'`]/g,
    /(?:^|\s)((?:src|lib|app|packages|modules|components)\/[a-zA-Z0-9_./-]+)/gm,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      paths.push(match[1]);
    }
  }

  return [...new Set(paths)];
}

/** Find context files in a directory and its parents (up to project root). */
function findContextFiles(startPath: string, projectRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  let current = startPath;

  while (current.startsWith(projectRoot) && current !== dirname(current)) {
    for (const name of CONTEXT_FILES) {
      const fullPath = join(current, name);
      if (existsSync(fullPath) && !found.has(name)) {
        try {
          const stat = statSync(fullPath);
          if (stat.size <= MAX_FILE_SIZE) {
            found.set(name, fullPath);
          }
        } catch { /* skip */ }
      }
    }

    for (const adrDir of ADR_DIRS) {
      const adrPath = join(current, adrDir);
      if (existsSync(adrPath)) {
        try {
          const entries = readdirSync(adrPath)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .slice(-5);
          for (const entry of entries) {
            const key = `ADR: ${entry}`;
            if (!found.has(key)) {
              const fp = join(adrPath, entry);
              const stat = statSync(fp);
              if (stat.size <= MAX_FILE_SIZE) {
                found.set(key, fp);
              }
            }
          }
        } catch { /* skip */ }
      }
    }

    current = dirname(current);
  }

  return found;
}

/** Build a context summary from found files. */
function buildContextBlock(files: Map<string, string>): string {
  const parts: string[] = [];

  for (const [label, filePath] of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const relativePath = filePath.replace(process.cwd() + "/", "");
      parts.push(`### ${label} (${relativePath})\n\n${content.slice(0, MAX_FILE_SIZE)}`);
    } catch { /* skip unreadable */ }
  }

  return parts.length > 0
    ? `\n\n---\n## Auto-loaded Context\n\nThe following documentation was found near the files mentioned in this request:\n\n${parts.join("\n\n---\n\n")}\n\n---\n`
    : "";
}

export function registerContextLoader(pi: ExtensionAPI): void {
  const injectedPaths = new Set<string>();

  pi.on("before_agent_start", async (event) => {
    const promptText = event.prompt ?? "";
    if (!promptText.trim()) return;

    const cwd = process.cwd();
    const mentionedPaths = extractPaths(promptText);
    if (mentionedPaths.length === 0) return;

    const allContextFiles = new Map<string, string>();

    for (const p of mentionedPaths) {
      const resolved = resolve(cwd, p);
      const dir = existsSync(resolved) && statSync(resolved).isDirectory()
        ? resolved
        : dirname(resolved);

      if (!existsSync(dir)) continue;

      const files = findContextFiles(dir, cwd);
      for (const [key, path] of files) {
        if (!injectedPaths.has(path)) {
          allContextFiles.set(key, path);
          injectedPaths.add(path);
        }
      }
    }

    if (allContextFiles.size === 0) return;

    recordFire("contextLoader");
    recordAction("contextLoader", `Injected ${allContextFiles.size} docs`);
    const contextBlock = buildContextBlock(allContextFiles);
    if (!contextBlock) return;

    return {
      message: {
        customType: "context-loader",
        content: contextBlock,
        display: false,
        details: {
          files: [...allContextFiles.entries()].map(([label, path]) => ({ label, path })),
        },
      },
    };
  });

  pi.on("session_switch", async () => {
    injectedPaths.clear();
  });
}
