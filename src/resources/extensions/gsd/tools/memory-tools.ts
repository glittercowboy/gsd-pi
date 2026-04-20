// GSD Memory Tools — Phase 1 executors for capture_thought, memory_query, gsd_graph
//
// These executors back the three memory-layer tools the LLM can call at any
// point in a session. They build on the existing `memory-store.ts` layer
// (SQLite memories table) and degrade gracefully when the DB is unavailable.
//
// Phase 1 scope:
//   - capture_thought → create a memory with the caller-supplied category/content
//   - memory_query    → keyword-filtered, score-ranked listing of active memories
//   - gsd_graph       → returns a memory and its supersedes edges only (Phase 4 adds memory_relations)

import { _getAdapter, isDbAvailable } from "../gsd-db.js";
import {
  createMemory,
  getActiveMemoriesRanked,
  queryMemoriesRanked,
  reinforceMemory,
} from "../memory-store.js";
import type { Memory, RankedMemory } from "../memory-store.js";
import { traverseGraph } from "../memory-relations.js";

// ─── Shared result shape (matches tools/workflow-tool-executors.ts) ─────────

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function dbUnavailable(operation: string): ToolExecutionResult {
  return {
    content: [
      {
        type: "text",
        text: "Error: GSD database is not available. Memory tools require an initialized .gsd/ project.",
      },
    ],
    details: { operation, error: "db_unavailable" },
    isError: true,
  };
}

// ─── capture_thought ────────────────────────────────────────────────────────

export interface MemoryCaptureParams {
  category: string;
  content: string;
  confidence?: number;
  tags?: string[];
  scope?: string;
  /**
   * ADR-013 Step 2: optional structured payload preserved verbatim on the
   * memories row. Used when capturing decisions that need to retain
   * gsd_save_decision-style fields (scope, decision, choice, rationale,
   * made_by, revisable) so the eventual cutover (Step 6) is lossless.
   * Plain pattern/gotcha/convention captures may omit this entirely.
   */
  structuredFields?: Record<string, unknown> | null;
}

const VALID_CATEGORIES = new Set([
  "architecture",
  "convention",
  "gotcha",
  "preference",
  "environment",
  "pattern",
]);

export function executeMemoryCapture(params: MemoryCaptureParams): ToolExecutionResult {
  if (!isDbAvailable()) return dbUnavailable("memory_capture");

  const category = (params.category ?? "").trim().toLowerCase();
  const content = (params.content ?? "").trim();
  if (!category || !content) {
    return {
      content: [{ type: "text", text: "Error: category and content are required." }],
      details: { operation: "memory_capture", error: "missing_fields" },
      isError: true,
    };
  }
  if (!VALID_CATEGORIES.has(category)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: invalid category "${category}". Must be one of: ${[...VALID_CATEGORIES].join(", ")}.`,
        },
      ],
      details: { operation: "memory_capture", error: "invalid_category" },
      isError: true,
    };
  }
  const confidence = clampConfidence(params.confidence);
  const scope = normalizeScope(params.scope);
  const tags = normalizeTags(params.tags);

  const structuredFields = normalizeStructuredFields(params.structuredFields);
  const id = createMemory({ category, content, confidence, scope, tags, structuredFields });
  if (!id) {
    return {
      content: [{ type: "text", text: "Error: failed to create memory." }],
      details: { operation: "memory_capture", error: "create_failed" },
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `Captured ${id} (${category}): ${content}` }],
    details: { operation: "memory_capture", id, category, confidence, scope, tags },
  };
}

function normalizeScope(value: unknown): string {
  if (typeof value !== "string") return "project";
  const trimmed = value.trim();
  return trimmed.length === 0 ? "project" : trimmed;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 10);
}

function normalizeStructuredFields(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  // Only accept plain objects (Object.prototype or null prototype). Class
  // instances and exotic objects won't round-trip cleanly through JSON, so
  // reject them here instead of producing a partially-serialized payload.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return null;
  return value as Record<string, unknown>;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.8;
  if (value < 0.1) return 0.1;
  if (value > 0.99) return 0.99;
  return value;
}

// ─── memory_query ───────────────────────────────────────────────────────────

export interface MemoryQueryParams {
  query: string;
  k?: number;
  category?: string;
  scope?: string;
  tag?: string;
  include_superseded?: boolean;
  reinforce_hits?: boolean;
}

export interface MemoryQueryHit {
  id: string;
  category: string;
  content: string;
  confidence: number;
  hit_count: number;
  score: number;
  reason: "keyword" | "semantic" | "both" | "ranked";
  keyword_rank: number | null;
  semantic_rank: number | null;
}

export function executeMemoryQuery(params: MemoryQueryParams): ToolExecutionResult {
  if (!isDbAvailable()) return dbUnavailable("memory_query");

  const query = (params.query ?? "").trim();
  const k = clampTopK(params.k, 10);
  const includeSuperseded = params.include_superseded === true;
  const category = params.category?.trim().toLowerCase() || undefined;
  const scopeFilter = params.scope?.trim() || undefined;
  const tagFilter = params.tag?.trim().toLowerCase() || undefined;

  try {
    let ranked: RankedMemory[] = [];
    if (query) {
      ranked = queryMemoriesRanked({
        query,
        k,
        category,
        scope: scopeFilter,
        tag: tagFilter,
        include_superseded: includeSuperseded,
      });
    } else {
      const candidates: Memory[] = includeSuperseded
        ? includeSupersededMemories(getActiveMemoriesRanked(200))
        : getActiveMemoriesRanked(200);
      ranked = candidates
        .filter((m) => {
          if (category && m.category.toLowerCase() !== category) return false;
          if (scopeFilter && m.scope !== scopeFilter) return false;
          if (tagFilter && !m.tags.map((t) => t.toLowerCase()).includes(tagFilter)) return false;
          return true;
        })
        .slice(0, k)
        .map((memory) => ({
          memory,
          score: memory.confidence * (1 + memory.hit_count * 0.1),
          keywordRank: null,
          semanticRank: null,
          confidenceBoost: memory.confidence * (1 + memory.hit_count * 0.1),
          reason: "ranked" as const,
        }));
    }

    const hits: MemoryQueryHit[] = ranked.map((r) => ({
      id: r.memory.id,
      category: r.memory.category,
      content: r.memory.content,
      confidence: r.memory.confidence,
      hit_count: r.memory.hit_count,
      score: r.score,
      reason: r.reason,
      keyword_rank: r.keywordRank,
      semantic_rank: r.semanticRank,
    }));

    if (params.reinforce_hits) {
      for (const h of hits) reinforceMemory(h.id);
    }

    const summary = hits.length === 0
      ? "No matching memories."
      : hits.map((h) => `- [${h.id}] (${h.category}) ${h.content}`).join("\n");

    return {
      content: [{ type: "text", text: summary }],
      details: {
        operation: "memory_query",
        query,
        k,
        returned: hits.length,
        hits,
      },
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: memory query failed: ${(err as Error).message}` }],
      details: { operation: "memory_query", error: (err as Error).message },
      isError: true,
    };
  }
}

function clampTopK(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 1) return 1;
  if (value > 50) return 50;
  return Math.floor(value);
}

function includeSupersededMemories(rankedActive: Memory[]): Memory[] {
  const adapter = _getAdapter();
  if (!adapter) return rankedActive;
  try {
    const rows = adapter.prepare("SELECT * FROM memories").all();
    return rows.map((row) => {
      let tags: string[] = [];
      if (typeof row["tags"] === "string") {
        try {
          const parsed = JSON.parse(row["tags"] as string);
          if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
        } catch {
          /* leave empty */
        }
      }
      let structuredFields: Record<string, unknown> | null = null;
      if (typeof row["structured_fields"] === "string" && (row["structured_fields"] as string).length > 0) {
        try {
          const parsed = JSON.parse(row["structured_fields"] as string);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            structuredFields = parsed as Record<string, unknown>;
          }
        } catch { /* leave null */ }
      }
      return {
        seq: row["seq"] as number,
        id: row["id"] as string,
        category: row["category"] as string,
        content: row["content"] as string,
        confidence: row["confidence"] as number,
        source_unit_type: (row["source_unit_type"] as string) ?? null,
        source_unit_id: (row["source_unit_id"] as string) ?? null,
        created_at: row["created_at"] as string,
        updated_at: row["updated_at"] as string,
        superseded_by: (row["superseded_by"] as string) ?? null,
        hit_count: row["hit_count"] as number,
        scope: (row["scope"] as string) ?? "project",
        tags,
        structured_fields: structuredFields,
      };
    });
  } catch {
    return rankedActive;
  }
}

// ─── gsd_graph ──────────────────────────────────────────────────────────────

export interface GsdGraphParams {
  mode: "build" | "query";
  memoryId?: string;
  depth?: number;
  rel?: string;
}

export interface GraphNode {
  id: string;
  category: string;
  content: string;
  confidence: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: string;
  confidence: number;
}

export function executeGsdGraph(params: GsdGraphParams): ToolExecutionResult {
  if (!isDbAvailable()) return dbUnavailable("gsd_graph");

  if (params.mode === "build") {
    // The extractor emits LINK actions incrementally (Phase 4). There is no
    // batch rebuild step to run today — ingest artifacts via `/gsd memory
    // extract <SRC-...>` and the next extraction turn will add edges.
    return {
      content: [
        {
          type: "text",
          text:
            "gsd_graph build acknowledged. Graph edges are populated incrementally by memory " +
            "extraction (including LINK actions). Use `/gsd memory extract <SRC-...>` to trigger " +
            "extraction against a specific ingested source.",
        },
      ],
      details: { operation: "gsd_graph", mode: "build", built: 0 },
    };
  }

  if (params.mode !== "query") {
    return {
      content: [{ type: "text", text: `Error: unknown mode "${params.mode}". Must be "build" or "query".` }],
      details: { operation: "gsd_graph", error: "invalid_mode" },
      isError: true,
    };
  }

  const memoryId = params.memoryId?.trim();
  if (!memoryId) {
    return {
      content: [{ type: "text", text: "Error: memoryId is required for mode=query." }],
      details: { operation: "gsd_graph", error: "missing_memory_id" },
      isError: true,
    };
  }

  try {
    const graph = traverseGraph(memoryId, clampDepth(params.depth));
    const rel = params.rel?.trim().toLowerCase() || null;
    const edges = rel ? graph.edges.filter((e) => e.rel === rel) : graph.edges;
    const relevantIds = new Set<string>([memoryId]);
    for (const e of edges) {
      relevantIds.add(e.from);
      relevantIds.add(e.to);
    }
    const nodes = graph.nodes.filter((n) => relevantIds.has(n.id));

    if (nodes.length === 0) {
      return {
        content: [{ type: "text", text: `No memory found with id ${memoryId}.` }],
        details: { operation: "gsd_graph", mode: "query", memoryId, nodes: [], edges: [] },
      };
    }

    const summary = [
      `Memory ${memoryId} — ${nodes.length} node(s), ${edges.length} edge(s).`,
      ...nodes.map((n) => `  [${n.id}] (${n.category}) ${n.content}`),
      ...edges.map((e) => `  ${e.from} --${e.rel}-> ${e.to}`),
    ].join("\n");
    return {
      content: [{ type: "text", text: summary }],
      details: {
        operation: "gsd_graph",
        mode: "query",
        memoryId,
        nodes: nodes.map((n) => ({ id: n.id, category: n.category, content: n.content })),
        edges: edges.map((e) => ({ from: e.from, to: e.to, rel: e.rel })),
      },
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: graph query failed: ${(err as Error).message}` }],
      details: { operation: "gsd_graph", error: (err as Error).message },
      isError: true,
    };
  }
}

function clampDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 5) return 5;
  return Math.floor(value);
}
