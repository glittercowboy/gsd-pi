// GSD Memory Ingest — turn raw content into memories
//
// Provides four entry points: ingestNote (inline text), ingestFile (local
// path), ingestUrl (HTTP resource), and ingestArtifact (a named .gsd/ artifact
// for a given milestone). Each one inserts a row into `memory_sources` and,
// if an LLM call is available, fires the extractor against the content with
// source-specific scope/tags.
//
// All four functions are safe to call without an LLM — they still persist the
// source. This means ingestion is decoupled from extraction; a later
// `/gsd memory rebuild` can re-extract from persisted sources.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { createMemorySource, type MemorySource, type MemorySourceKind } from "./memory-source-store.js";
import { buildMemoryLLMCall, extractMemoriesFromTranscript } from "./memory-extractor.js";
import type { MemoryAction } from "./memory-store.js";
import { resolveMilestoneFile } from "./paths.js";
import { logWarning } from "./workflow-logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IngestOptions {
  scope?: string;
  tags?: string[];
  /** Skip LLM extraction — just persist the source row. */
  extract?: boolean;
  /**
   * Soft upper bound on source content size (bytes). Files/URLs above this
   * are truncated before hashing and storing. Default 256 KiB.
   */
  maxBytes?: number;
}

export interface IngestResult {
  sourceId: string;
  duplicate: boolean;
  extracted: MemoryAction[];
  kind: MemorySourceKind;
  title: string | null;
  uri: string | null;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

function truncate(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= maxBytes) return content;
  return `${buf.subarray(0, maxBytes).toString("utf-8")}\n\n…[truncated to ${maxBytes} bytes]`;
}

async function maybeExtract(
  ctx: ExtensionContext | null,
  source: { kind: MemorySourceKind; id: string },
  content: string,
  opts: IngestOptions,
): Promise<MemoryAction[]> {
  if (opts.extract === false || !ctx) return [];
  const llmCallFn = buildMemoryLLMCall(ctx);
  if (!llmCallFn) return [];
  try {
    return await extractMemoriesFromTranscript(content, llmCallFn, {
      sourceType: source.kind,
      sourceId: source.id,
      scope: opts.scope,
      tags: opts.tags,
      force: true,
    });
  } catch (err) {
    logWarning("memory-ingest", `extraction failed: ${(err as Error).message}`);
    return [];
  }
}

function sourceCreateFailure(kind: MemorySourceKind): IngestResult {
  return {
    sourceId: "",
    duplicate: false,
    extracted: [],
    kind,
    title: null,
    uri: null,
  };
}

// ─── ingestNote ─────────────────────────────────────────────────────────────

export async function ingestNote(
  note: string,
  ctx: ExtensionContext | null,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const trimmed = note.trim();
  if (!trimmed) return sourceCreateFailure("note");

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const content = truncate(trimmed, maxBytes);

  const created = createMemorySource({
    kind: "note",
    uri: null,
    title: content.slice(0, 80).replace(/\s+/g, " ").trim(),
    content,
    scope: opts.scope,
    tags: opts.tags,
  });
  if (!created) return sourceCreateFailure("note");

  const extracted = created.duplicate
    ? []
    : await maybeExtract(ctx, { kind: "note", id: created.id }, content, opts);

  return {
    sourceId: created.id,
    duplicate: created.duplicate,
    extracted,
    kind: "note",
    title: content.slice(0, 80),
    uri: null,
  };
}

// ─── ingestFile ─────────────────────────────────────────────────────────────

export async function ingestFile(
  path: string,
  ctx: ExtensionContext | null,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${abs}`);
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${abs}`);
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw = readFileSync(abs, "utf-8");
  const content = truncate(raw, maxBytes);
  const title = basename(abs);

  const created = createMemorySource({
    kind: "file",
    uri: abs,
    title,
    content,
    scope: opts.scope,
    tags: opts.tags,
  });
  if (!created) return { ...sourceCreateFailure("file"), uri: abs, title };

  const extracted = created.duplicate
    ? []
    : await maybeExtract(ctx, { kind: "file", id: created.id }, content, opts);

  return {
    sourceId: created.id,
    duplicate: created.duplicate,
    extracted,
    kind: "file",
    title,
    uri: abs,
  };
}

// ─── ingestUrl ──────────────────────────────────────────────────────────────

export async function ingestUrl(
  url: string,
  ctx: ExtensionContext | null,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let body: string;
  let title: string | null = null;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    body = await res.text();
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim().slice(0, 200);
  } catch (err) {
    throw new Error(`Fetch failed for ${url}: ${(err as Error).message}`);
  }

  const content = truncate(stripHtml(body), maxBytes);
  if (!content.trim()) {
    throw new Error(`URL produced empty content: ${url}`);
  }

  const created = createMemorySource({
    kind: "url",
    uri: url,
    title: title ?? url,
    content,
    scope: opts.scope,
    tags: opts.tags,
  });
  if (!created) return { ...sourceCreateFailure("url"), uri: url, title };

  const extracted = created.duplicate
    ? []
    : await maybeExtract(ctx, { kind: "url", id: created.id }, content, opts);

  return {
    sourceId: created.id,
    duplicate: created.duplicate,
    extracted,
    kind: "url",
    title: title ?? url,
    uri: url,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── ingestArtifact ─────────────────────────────────────────────────────────

/**
 * Ingest a named artifact from a milestone directory (e.g. LEARNINGS,
 * SUMMARY, CONTEXT). Resolves through `resolveMilestoneFile` so worktree
 * layouts are handled correctly.
 */
export async function ingestArtifact(
  basePath: string,
  milestoneId: string,
  artifactType: string,
  ctx: ExtensionContext | null,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const file = resolveMilestoneFile(basePath, milestoneId, artifactType);
  if (!file || !existsSync(file)) {
    throw new Error(`Artifact not found: ${milestoneId}-${artifactType}.md`);
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const content = truncate(readFileSync(file, "utf-8"), maxBytes);
  const title = `${milestoneId}-${artifactType}`;
  const created = createMemorySource({
    kind: "artifact",
    uri: file,
    title,
    content,
    scope: opts.scope,
    tags: [...(opts.tags ?? []), milestoneId, artifactType.toLowerCase()],
  });
  if (!created) return { ...sourceCreateFailure("artifact"), uri: file, title };

  const extracted = created.duplicate
    ? []
    : await maybeExtract(ctx, { kind: "artifact", id: created.id }, content, opts);

  return {
    sourceId: created.id,
    duplicate: created.duplicate,
    extracted,
    kind: "artifact",
    title,
    uri: file,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function summarizeIngest(result: IngestResult): string {
  if (!result.sourceId) return "Ingest failed: could not persist source.";
  const status = result.duplicate ? "duplicate (content_hash match)" : "new source";
  const extracted = result.extracted.length === 0
    ? "no memories extracted"
    : `${result.extracted.length} memor${result.extracted.length === 1 ? "y" : "ies"} applied`;
  const label = result.title ? ` "${result.title}"` : "";
  return `Ingested ${result.kind}${label} as ${result.sourceId} (${status}, ${extracted}).`;
}

export type { MemorySource };
