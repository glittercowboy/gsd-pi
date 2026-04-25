/**
 * GSD Command — /gsd scan
 *
 * Rapid codebase assessment — lightweight alternative to /gsd map-codebase.
 * Spawns one focused AI analysis pass and writes structured documents to
 * .gsd/codebase/ for use by planning and execution phases.
 *
 * Usage:
 *   /gsd scan                   — tech+arch focus (default)
 *   /gsd scan --focus tech      — technology stack + integrations only
 *   /gsd scan --focus arch      — architecture + structure only
 *   /gsd scan --focus quality   — conventions + testing patterns only
 *   /gsd scan --focus concerns  — technical debt + concerns only
 *   /gsd scan --focus tech+arch — explicit default (same as no flag)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

import { loadPrompt } from "./prompt-loader.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_FOCUS = "tech+arch";

export const VALID_FOCUS_AREAS = ["tech", "arch", "quality", "concerns", "tech+arch"] as const;
export type FocusArea = (typeof VALID_FOCUS_AREAS)[number];

const FOCUS_DOCUMENTS: Record<FocusArea, string[]> = {
  tech: ["STACK", "INTEGRATIONS"],
  arch: ["ARCHITECTURE", "STRUCTURE"],
  quality: ["CONVENTIONS", "TESTING"],
  concerns: ["CONCERNS"],
  "tech+arch": ["STACK", "INTEGRATIONS", "ARCHITECTURE", "STRUCTURE"],
};

// ─── Exported functions (exported for testing) ───────────────────────────────
// Note: checkExistingDocuments reads the filesystem and is not purely functional.

/**
 * Parse --focus flag from raw args string.
 * Returns default focus when flag is missing or the value is invalid.
 * Shell-injection safe: only well-known values are accepted.
 */
export function parseScanArgs(args: string): { focus: string } {
  const match = args.match(/--focus\s+([^\s]+)/i);
  if (!match) return { focus: DEFAULT_FOCUS };

  const raw = match[1].toLowerCase();
  if ((VALID_FOCUS_AREAS as readonly string[]).includes(raw)) {
    return { focus: raw };
  }
  return { focus: DEFAULT_FOCUS };
}

/**
 * Return the list of document names (without extension) to generate for a focus.
 * Falls back to the default focus documents for unknown values.
 */
export function resolveScanDocuments(focus: string): string[] {
  return FOCUS_DOCUMENTS[focus as FocusArea] ?? FOCUS_DOCUMENTS[DEFAULT_FOCUS];
}

/**
 * Build absolute output paths for the documents produced by a scan focus.
 * All documents live under <basePath>/.gsd/codebase/
 */
export function buildScanOutputPaths(focus: string, basePath: string): string[] {
  const docs = resolveScanDocuments(focus);
  return docs.map((doc) => join(basePath, ".gsd", "codebase", `${doc}.md`));
}

/**
 * Return the subset of paths that already exist on disk.
 */
export function checkExistingDocuments(paths: string[]): string[] {
  return paths.filter((p) => existsSync(p));
}

// ─── Command handler ──────────────────────────────────────────────────────────

export async function handleScan(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const basePath = process.cwd();
  const { focus } = parseScanArgs(args);
  const outputDir = join(basePath, ".gsd", "codebase");
  const outputPaths = buildScanOutputPaths(focus, basePath);
  const existing = checkExistingDocuments(outputPaths);

  if (existing.length > 0) {
    const names = existing.map((p) => relative(outputDir, p)).join(", ");
    ctx.ui.notify(
      `Existing documents will be overwritten: ${names}\nContinuing scan with focus: ${focus}`,
      "warning",
    );
  }

  mkdirSync(outputDir, { recursive: true });

  const documents = resolveScanDocuments(focus);

  ctx.ui.notify(`Running codebase scan (focus: ${focus})…`, "info");

  try {
    const prompt = loadPrompt("scan", {
      focus,
      documents: documents.join(", "),
      outputDir: outputDir.replaceAll("\\", "/"),
      workingDirectory: basePath,
    });

    pi.sendMessage(
      { customType: "gsd-scan", content: prompt, display: false },
      { triggerTurn: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to dispatch scan: ${msg}`, "error");
  }
}
