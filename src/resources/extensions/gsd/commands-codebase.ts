/**
 * GSD Command — /gsd codebase
 *
 * Generate and manage the codebase map (.gsd/CODEBASE.md).
 * Subcommands: generate, update, stats, help
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  generateCodebaseMap,
  updateCodebaseMap,
  writeCodebaseMap,
  getCodebaseMapStats,
  readCodebaseMap,
} from "./codebase-generator.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import type { CodebaseMapOptions } from "./codebase-generator.js";

const USAGE =
  "Usage: /gsd codebase [generate|update|stats]\n\n" +
  "  generate [--max-files N] [--collapse-threshold N]  — Generate or regenerate CODEBASE.md\n" +
  "  update [--max-files N] [--collapse-threshold N]    — Incremental update (preserves descriptions)\n" +
  "  stats                                              — Show file count, coverage, and generation time\n" +
  "  help                                               — Show this help\n\n" +
  "With no subcommand, shows stats if a map exists or help if not.\n\n" +
  "Configure defaults via preferences.md:\n" +
  "  codebase:\n" +
  "    exclude_patterns: [\"docs/\", \"fixtures/\"]\n" +
  "    max_files: 1000\n" +
  "    collapse_threshold: 15";

export async function handleCodebase(
  args: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] ?? "";

  switch (sub) {
    case "generate": {
      const options = resolveCodebaseOptions(args, ctx);
      if (options === false) return; // validation failed, message already shown

      const existing = readCodebaseMap(basePath);
      const existingDescriptions = existing
        ? (await import("./codebase-generator.js")).parseCodebaseMap(existing)
        : undefined;

      const result = generateCodebaseMap(basePath, options, existingDescriptions);

      if (result.fileCount === 0) {
        ctx.ui.notify(
          "Codebase map generated with 0 files.\n" +
          "Is this a git repository? Run 'git ls-files' to verify.",
          "warning",
        );
        return;
      }

      const outPath = writeCodebaseMap(basePath, result.content);
      ctx.ui.notify(
        `Codebase map generated: ${result.fileCount} files\n` +
        `Written to: ${outPath}` +
        (result.truncated ? `\n⚠ Truncated — increase --max-files to include all files` : ""),
        "success",
      );
      return;
    }

    case "update": {
      const existing = readCodebaseMap(basePath);
      if (!existing) {
        ctx.ui.notify(
          "No codebase map found. Run /gsd codebase generate to create one.",
          "warning",
        );
        return;
      }

      const options = resolveCodebaseOptions(args, ctx);
      if (options === false) return;

      const result = updateCodebaseMap(basePath, options);
      writeCodebaseMap(basePath, result.content);

      ctx.ui.notify(
        `Codebase map updated: ${result.fileCount} files\n` +
        `  Added: ${result.added} | Removed: ${result.removed} | Unchanged: ${result.unchanged}` +
        (result.truncated ? `\n⚠ Truncated — increase --max-files to include all files` : ""),
        "success",
      );
      return;
    }

    case "stats": {
      showStats(basePath, ctx);
      return;
    }

    case "help":
      ctx.ui.notify(USAGE, "info");
      return;

    case "": {
      // Safe default: show stats if map exists, help if not
      const existing = readCodebaseMap(basePath);
      if (existing) {
        showStats(basePath, ctx);
      } else {
        ctx.ui.notify(USAGE, "info");
      }
      return;
    }

    default:
      ctx.ui.notify(
        `Unknown subcommand "${sub}".\n\n${USAGE}`,
        "warning",
      );
  }
}

function showStats(basePath: string, ctx: ExtensionCommandContext): void {
  const stats = getCodebaseMapStats(basePath);
  if (!stats.exists) {
    ctx.ui.notify("No codebase map found. Run /gsd codebase generate to create one.", "info");
    return;
  }

  const coverage = stats.fileCount > 0
    ? Math.round((stats.describedCount / stats.fileCount) * 100)
    : 0;

  ctx.ui.notify(
    `Codebase Map Stats:\n` +
    `  Files: ${stats.fileCount}\n` +
    `  Described: ${stats.describedCount} (${coverage}%)\n` +
    `  Undescribed: ${stats.undescribedCount}\n` +
    `  Generated: ${stats.generatedAt ?? "unknown"}\n\n` +
    (stats.undescribedCount > 0
      ? `Tip: Run /gsd codebase update to refresh after file changes.`
      : `Coverage is complete.`),
    "info",
  );
}

/**
 * Resolve codebase map options by merging preferences with CLI flags.
 * CLI flags override preferences; preferences override built-in defaults.
 * Returns false if validation failed (error already shown to user).
 */
function resolveCodebaseOptions(args: string, ctx: ExtensionCommandContext): CodebaseMapOptions | false {
  // Load preferences defaults
  const prefs = loadEffectiveGSDPreferences()?.preferences?.codebase;

  // Parse CLI flags
  const maxFilesStr = extractFlag(args, "--max-files");
  const collapseStr = extractFlag(args, "--collapse-threshold");

  // Validate --max-files
  let maxFiles: number | undefined;
  if (maxFilesStr) {
    maxFiles = parseInt(maxFilesStr, 10);
    if (isNaN(maxFiles) || maxFiles < 1) {
      ctx.ui.notify("--max-files must be a positive integer (e.g. --max-files 200).", "warning");
      return false;
    }
  }

  // Validate --collapse-threshold
  let collapseThreshold: number | undefined;
  if (collapseStr) {
    collapseThreshold = parseInt(collapseStr, 10);
    if (isNaN(collapseThreshold) || collapseThreshold < 1) {
      ctx.ui.notify("--collapse-threshold must be a positive integer (e.g. --collapse-threshold 15).", "warning");
      return false;
    }
  }

  return {
    // CLI flags override preferences
    maxFiles: maxFiles ?? prefs?.max_files,
    collapseThreshold: collapseThreshold ?? prefs?.collapse_threshold,
    excludePatterns: prefs?.exclude_patterns,
  };
}

function extractFlag(args: string, flag: string): string | undefined {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}[=\\s]+(\\S+)`);
  const match = args.match(regex);
  return match?.[1];
}
