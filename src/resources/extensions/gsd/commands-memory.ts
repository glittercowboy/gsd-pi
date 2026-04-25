/**
 * GSD Command — `/gsd memory`
 *
 * Subcommands:
 *   list            — show recent active memories
 *   show <id>       — print one memory
 *   ingest <uri>    — persist a source row (file path, URL, or "-" for stdin-piped note)
 *   note "<text>"   — persist an inline note as a source
 *   forget <id>     — supersede a memory (CAP_EXCEEDED sentinel)
 *   stats           — category / scope counts + source count
 *   sources         — list recent memory_sources rows
 *   extract <src>   — dispatch an agent turn that distils a source into memories
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { projectRoot } from "./commands/context.js";
import { ingestFile, ingestNote, ingestUrl, summarizeIngest } from "./memory-ingest.js";
import { getMemorySource, listMemorySources } from "./memory-source-store.js";
import {
  createMemory,
  decayStaleMemories,
  enforceMemoryCap,
  getActiveMemories,
  getActiveMemoriesRanked,
  supersedeMemory,
} from "./memory-store.js";
import { _getAdapter, isDbAvailable } from "./gsd-db.js";
import { createMemoryRelation, listRelationsFor } from "./memory-relations.js";

// ─── Arg parsing ────────────────────────────────────────────────────────────

interface MemoryCmdArgs {
  sub: string;
  positional: string[];
  tags: string[];
  scope?: string;
  extract: boolean;
}

function parseArgs(raw: string): MemoryCmdArgs {
  const tokens = splitArgs(raw);
  const sub = (tokens.shift() ?? "list").toLowerCase();
  const positional: string[] = [];
  const tags: string[] = [];
  let scope: string | undefined;
  let extract = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--tag" && i + 1 < tokens.length) {
      tags.push(...tokens[++i].split(",").map((t) => t.trim()).filter(Boolean));
      continue;
    }
    if (tok.startsWith("--tag=")) {
      tags.push(...tok.slice("--tag=".length).split(",").map((t) => t.trim()).filter(Boolean));
      continue;
    }
    if (tok === "--scope" && i + 1 < tokens.length) {
      scope = tokens[++i];
      continue;
    }
    if (tok.startsWith("--scope=")) {
      scope = tok.slice("--scope=".length);
      continue;
    }
    if (tok === "--extract") {
      extract = true;
      continue;
    }
    if (tok === "--no-extract") {
      extract = false;
      continue;
    }
    positional.push(tok);
  }
  return { sub, positional, tags, scope, extract };
}

function splitArgs(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleMemory(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const parsed = parseArgs(args);

  // `/gsd memory` or `/gsd memory help`
  if (parsed.sub === "" || parsed.sub === "help") {
    ctx.ui.notify(usage(), "info");
    return;
  }

  // Most subcommands need the DB.
  await ensureDb();

  switch (parsed.sub) {
    case "list":
      handleList(ctx);
      return;
    case "show":
      handleShow(ctx, parsed.positional[0]);
      return;
    case "forget":
      handleForget(ctx, parsed.positional[0]);
      return;
    case "stats":
      handleStats(ctx);
      return;
    case "sources":
      handleSources(ctx);
      return;
    case "note":
      await handleNote(ctx, parsed);
      return;
    case "ingest":
      await handleIngest(ctx, parsed);
      return;
    case "extract":
      handleExtractSource(ctx, pi, parsed.positional[0]);
      return;
    case "export":
      handleExport(ctx, parsed.positional[0]);
      return;
    case "import":
      handleImport(ctx, parsed.positional[0]);
      return;
    case "decay":
      handleDecay(ctx);
      return;
    case "cap":
      handleCap(ctx, parsed.positional[0]);
      return;
    default:
      ctx.ui.notify(`Unknown subcommand "${parsed.sub}". ${usage()}`, "warning");
      return;
  }
}

function usage(): string {
  return [
    "Usage: /gsd memory <subcommand>",
    "  list                    list recent active memories",
    "  show <MEM###>           print one memory",
    "  forget <MEM###>         supersede a memory",
    "  stats                   counts by category / scope / sources / edges",
    "  sources                 list recent memory_sources",
    '  note "<text>"           ingest an inline note as a source',
    "  ingest <path|url>       ingest a local file path or URL",
    "  extract <SRC-xxx>       dispatch an LLM turn to extract memories from a source",
    "  export <path.json>      dump memories + relations + sources to JSON",
    "  import <path.json>      load a previous export (idempotent)",
    "  decay                   run the stale-memory decay pass immediately",
    "  cap [N]                 enforce the memory cap (default 50)",
    "",
    "Options: --tag a,b   --scope project|global|<custom>   --extract",
  ].join("\n");
}

async function ensureDb(): Promise<void> {
  if (isDbAvailable()) return;
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen();
}

function handleList(ctx: ExtensionCommandContext): void {
  if (!isDbAvailable()) {
    ctx.ui.notify("No GSD database available.", "warning");
    return;
  }
  const memories = getActiveMemoriesRanked(50);
  if (memories.length === 0) {
    ctx.ui.notify("No active memories.", "info");
    return;
  }
  const lines = memories.map(
    (m) =>
      `- [${m.id}] (${m.category}, conf ${m.confidence.toFixed(2)}, hits ${m.hit_count}${m.scope && m.scope !== "project" ? `, ${m.scope}` : ""}) ${truncate(m.content, 100)}`,
  );
  ctx.ui.notify(lines.join("\n"), "info");
}

function handleShow(ctx: ExtensionCommandContext, id: string | undefined): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd memory show <MEM###>", "warning");
    return;
  }
  const adapter = _getAdapter();
  if (!adapter) {
    ctx.ui.notify("No GSD database available.", "warning");
    return;
  }
  const row = adapter.prepare("SELECT * FROM memories WHERE id = :id").get({ ":id": id });
  if (!row) {
    ctx.ui.notify(`Memory not found: ${id}`, "warning");
    return;
  }
  const tags = row["tags"] ? safeJsonArray(row["tags"] as string) : [];
  const lines = [
    `ID: ${row["id"]}`,
    `Category: ${row["category"]}`,
    `Scope: ${row["scope"] ?? "project"}`,
    `Confidence: ${Number(row["confidence"]).toFixed(2)}`,
    `Hits: ${row["hit_count"]}`,
    `Created: ${row["created_at"]}`,
    `Updated: ${row["updated_at"]}`,
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : null,
    row["superseded_by"] ? `Superseded by: ${row["superseded_by"]}` : null,
    row["source_unit_type"] ? `Source: ${row["source_unit_type"]}/${row["source_unit_id"]}` : null,
    "",
    String(row["content"]),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  ctx.ui.notify(lines, "info");
}

function handleForget(ctx: ExtensionCommandContext, id: string | undefined): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd memory forget <MEM###>", "warning");
    return;
  }
  const ok = supersedeMemory(id, "CAP_EXCEEDED");
  if (!ok) {
    ctx.ui.notify(`Failed to forget ${id}.`, "warning");
    return;
  }
  ctx.ui.notify(`Forgot ${id}.`, "info");
}

function handleStats(ctx: ExtensionCommandContext): void {
  const adapter = _getAdapter();
  if (!adapter) {
    ctx.ui.notify("No GSD database available.", "warning");
    return;
  }
  try {
    const activeRow = adapter
      .prepare("SELECT count(*) as cnt FROM memories WHERE superseded_by IS NULL")
      .get();
    const supersededRow = adapter
      .prepare("SELECT count(*) as cnt FROM memories WHERE superseded_by IS NOT NULL")
      .get();
    const byCategory = adapter
      .prepare(
        "SELECT category, count(*) as cnt FROM memories WHERE superseded_by IS NULL GROUP BY category ORDER BY cnt DESC",
      )
      .all();
    const byScope = adapter
      .prepare(
        "SELECT scope, count(*) as cnt FROM memories WHERE superseded_by IS NULL GROUP BY scope ORDER BY cnt DESC",
      )
      .all();
    const sourcesRow = adapter.prepare("SELECT count(*) as cnt FROM memory_sources").get();
    const sourcesByKind = adapter
      .prepare("SELECT kind, count(*) as cnt FROM memory_sources GROUP BY kind ORDER BY cnt DESC")
      .all();
    const relationsRow = adapter.prepare("SELECT count(*) as cnt FROM memory_relations").get();
    const relationsByRel = adapter
      .prepare("SELECT rel, count(*) as cnt FROM memory_relations GROUP BY rel ORDER BY cnt DESC")
      .all();
    const embeddingsRow = adapter.prepare("SELECT count(*) as cnt FROM memory_embeddings").get();
    const embeddedActiveRow = adapter
      .prepare(
        `SELECT count(*) as cnt FROM memory_embeddings e
         JOIN memories m ON m.id = e.memory_id
         WHERE m.superseded_by IS NULL`,
      )
      .get();
    const activeCount = (activeRow?.["cnt"] as number) ?? 0;
    const embeddedActive = (embeddedActiveRow?.["cnt"] as number) ?? 0;
    const coverage = activeCount > 0 ? `${Math.round((embeddedActive / activeCount) * 100)}%` : "n/a";

    const out = [
      `Active memories: ${activeCount}`,
      `Superseded: ${supersededRow?.["cnt"] ?? 0}`,
      "",
      "By category:",
      ...byCategory.map((row) => `  ${row["category"]}: ${row["cnt"]}`),
      "",
      "By scope:",
      ...byScope.map((row) => `  ${row["scope"]}: ${row["cnt"]}`),
      "",
      `Memory sources: ${sourcesRow?.["cnt"] ?? 0}`,
      ...sourcesByKind.map((row) => `  ${row["kind"]}: ${row["cnt"]}`),
      "",
      `Relations: ${relationsRow?.["cnt"] ?? 0}`,
      ...relationsByRel.map((row) => `  ${row["rel"]}: ${row["cnt"]}`),
      "",
      `Embeddings: ${embeddingsRow?.["cnt"] ?? 0} total, ${embeddedActive} active (coverage ${coverage})`,
    ].join("\n");
    ctx.ui.notify(out, "info");
  } catch (err) {
    ctx.ui.notify(`Stats failed: ${(err as Error).message}`, "warning");
  }
}

function handleExport(ctx: ExtensionCommandContext, target: string | undefined): void {
  if (!target) {
    ctx.ui.notify("Usage: /gsd memory export <path.json>", "warning");
    return;
  }
  try {
    const active = getActiveMemories();
    const relations = active.flatMap((m) =>
      listRelationsFor(m.id).filter((r) => r.from === m.id),
    );
    const sources = listMemorySources(500);
    const payload = {
      version: 1,
      exported_at: new Date().toISOString(),
      memories: active.map((m) => ({
        id: m.id,
        category: m.category,
        content: m.content,
        confidence: m.confidence,
        hit_count: m.hit_count,
        scope: m.scope,
        tags: m.tags,
        source_unit_type: m.source_unit_type,
        source_unit_id: m.source_unit_id,
        created_at: m.created_at,
        updated_at: m.updated_at,
      })),
      relations: relations.map((r) => ({
        from: r.from,
        to: r.to,
        rel: r.rel,
        confidence: r.confidence,
      })),
      sources,
    };
    const abs = resolvePath(process.cwd(), target);
    writeFileSync(abs, JSON.stringify(payload, null, 2), "utf-8");
    ctx.ui.notify(
      `Exported ${payload.memories.length} memories, ${payload.relations.length} relations, ${payload.sources.length} sources → ${abs}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`Export failed: ${(err as Error).message}`, "error");
  }
}

interface ExportedMemory {
  id?: string;
  category: string;
  content: string;
  confidence?: number;
  scope?: string;
  tags?: string[];
}

interface ExportedRelation {
  from: string;
  to: string;
  rel: string;
  confidence?: number;
}

function handleImport(ctx: ExtensionCommandContext, target: string | undefined): void {
  if (!target) {
    ctx.ui.notify("Usage: /gsd memory import <path.json>", "warning");
    return;
  }
  try {
    const abs = resolvePath(process.cwd(), target);
    const raw = readFileSync(abs, "utf-8");
    const parsed = JSON.parse(raw) as { memories?: ExportedMemory[]; relations?: ExportedRelation[] };

    let memoryCount = 0;
    let relationCount = 0;

    for (const mem of parsed.memories ?? []) {
      if (!mem.category || !mem.content) continue;
      // createMemory allocates a fresh seq → new MEM### id; imports replay
      // content rather than preserving the old ID. Relations from the export
      // file still reference the old IDs, so only lossless round-trips into
      // an empty DB preserve the graph.
      const id = createMemory({
        category: mem.category,
        content: mem.content,
        confidence: mem.confidence,
        scope: mem.scope,
        tags: mem.tags,
      });
      if (id) memoryCount++;
    }

    for (const rel of parsed.relations ?? []) {
      if (!rel.from || !rel.to || !rel.rel) continue;
      if (createMemoryRelation(rel.from, rel.to, rel.rel as never, rel.confidence)) {
        relationCount++;
      }
    }

    ctx.ui.notify(`Imported ${memoryCount} memories and ${relationCount} relations.`, "info");
  } catch (err) {
    ctx.ui.notify(`Import failed: ${(err as Error).message}`, "error");
  }
}

function handleDecay(ctx: ExtensionCommandContext): void {
  const decayed = decayStaleMemories(20);
  if (decayed.length === 0) {
    ctx.ui.notify("Decay pass: no stale memories found.", "info");
    return;
  }
  ctx.ui.notify(`Decayed ${decayed.length} stale memor${decayed.length === 1 ? "y" : "ies"}: ${decayed.join(", ")}`, "info");
}

function handleCap(ctx: ExtensionCommandContext, arg: string | undefined): void {
  const max = arg ? Number.parseInt(arg, 10) : 50;
  if (!Number.isFinite(max) || max < 1) {
    ctx.ui.notify("Usage: /gsd memory cap <max>  (default 50)", "warning");
    return;
  }
  enforceMemoryCap(max);
  ctx.ui.notify(`Enforced memory cap of ${max}.`, "info");
}

function handleSources(ctx: ExtensionCommandContext): void {
  const sources = listMemorySources(30);
  if (sources.length === 0) {
    ctx.ui.notify("No memory sources yet. Use `/gsd memory ingest <path|url>` to add one.", "info");
    return;
  }
  const lines = sources.map(
    (s) =>
      `- ${s.id} [${s.kind}${s.scope !== "project" ? `/${s.scope}` : ""}] ${truncate(s.title ?? s.uri ?? s.content, 100)}`,
  );
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleNote(ctx: ExtensionCommandContext, args: MemoryCmdArgs): Promise<void> {
  const text = args.positional.join(" ").trim();
  if (!text) {
    ctx.ui.notify('Usage: /gsd memory note "your note"', "warning");
    return;
  }
  try {
    const result = await ingestNote(text, null, {
      scope: args.scope,
      tags: args.tags,
      extract: false,
    });
    ctx.ui.notify(summarizeIngest(result), "info");
  } catch (err) {
    ctx.ui.notify(`Note ingest failed: ${(err as Error).message}`, "error");
  }
}

async function handleIngest(ctx: ExtensionCommandContext, args: MemoryCmdArgs): Promise<void> {
  const target = args.positional[0];
  if (!target) {
    ctx.ui.notify("Usage: /gsd memory ingest <path|url> [--tag a,b] [--scope project|global]", "warning");
    return;
  }
  try {
    const isUrl = /^https?:\/\//i.test(target);
    const result = isUrl
      ? await ingestUrl(target, null, { scope: args.scope, tags: args.tags, extract: false })
      : await ingestFile(target, null, { scope: args.scope, tags: args.tags, extract: false });
    ctx.ui.notify(summarizeIngest(result), "info");
    if (args.extract && result.sourceId) {
      // TODO (P3): dispatch agent turn to extract memories once source is stored.
      ctx.ui.notify(
        `(Dispatching extraction turn — use \`/gsd memory extract ${result.sourceId}\` to trigger manually.)`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.notify(`Ingest failed: ${(err as Error).message}`, "error");
  }
}

function handleExtractSource(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  id: string | undefined,
): void {
  if (!id) {
    ctx.ui.notify("Usage: /gsd memory extract <SRC-xxx>", "warning");
    return;
  }
  const source = getMemorySource(id);
  if (!source) {
    ctx.ui.notify(`Source not found: ${id}`, "warning");
    return;
  }

  const prompt = buildExtractPrompt(source);
  ctx.ui.notify(`Dispatching extraction turn for ${id}...`, "info");
  pi.sendMessage(
    { customType: "gsd-memory-extract", content: prompt, display: false },
    { triggerTurn: true },
  );
}

function buildExtractPrompt(source: { id: string; kind: string; title: string | null; uri: string | null; content: string }): string {
  const header = [
    `## Memory extraction request`,
    ``,
    `Source: ${source.id} (${source.kind})`,
    source.title ? `Title: ${source.title}` : null,
    source.uri ? `URI: ${source.uri}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    header,
    "",
    "Read the content below and call the `capture_thought` tool once per durable insight",
    "(architecture, convention, gotcha, preference, environment, pattern). Skip one-off details,",
    "temporary state, and anything secret. Keep each memory to 1–3 sentences.",
    "",
    "---",
    "",
    source.content,
  ].join("\n");
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// projectRoot is imported so tests can mock it via the same path as other commands.
export const _internals = { projectRoot };
