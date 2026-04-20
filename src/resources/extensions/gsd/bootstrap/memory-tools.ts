// GSD2 — Memory tool registration
//
// Exposes the memory-layer tools (capture_thought, memory_query, gsd_graph)
// to the LLM over MCP. All three degrade gracefully when the GSD database
// is unavailable.

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { ensureDbOpen } from "./dynamic-tools.js";
import {
  executeGsdGraph,
  executeMemoryCapture,
  executeMemoryQuery,
} from "../tools/memory-tools.js";

export function registerMemoryTools(pi: ExtensionAPI): void {
  // ─── capture_thought ────────────────────────────────────────────────────

  pi.registerTool({
    name: "capture_thought",
    label: "Capture Thought",
    description:
      "Record a durable piece of project knowledge (decision, convention, gotcha, pattern, " +
      "preference, or environment detail) into the GSD memory store. Use sparingly — one memory " +
      "per genuinely reusable insight, not per task.",
    promptSnippet:
      "Capture a durable project insight into the GSD memory store (categories: architecture, convention, gotcha, pattern, preference, environment)",
    promptGuidelines: [
      "Use capture_thought for insights that will remain useful across future sessions.",
      "Do NOT capture one-off bug fixes, temporary state, secrets, or task-specific details.",
      "Keep content to 1–3 sentences.",
      "Set confidence: 0.6 tentative, 0.8 solid, 0.95 well-confirmed (default 0.8).",
    ],
    parameters: Type.Object({
      category: Type.Union(
        [
          Type.Literal("architecture"),
          Type.Literal("convention"),
          Type.Literal("gotcha"),
          Type.Literal("preference"),
          Type.Literal("environment"),
          Type.Literal("pattern"),
        ],
        { description: "Memory category" },
      ),
      content: Type.String({ description: "The memory text (1–3 sentences, no secrets)" }),
      confidence: Type.Optional(
        Type.Number({ description: "0.1–0.99, default 0.8", minimum: 0.1, maximum: 0.99 }),
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Free-form tags (reserved for future use)" })),
      scope: Type.Optional(Type.String({ description: "Scope name (reserved for future use; defaults to project)" })),
      structuredFields: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional structured payload preserved alongside content (ADR-013). Use for decisions to retain scope/decision/choice/rationale/made_by/revisable. Omit for plain captures.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const ok = await ensureDbOpen();
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot capture memory." }],
          details: { operation: "memory_capture", error: "db_unavailable" },
          isError: true,
        };
      }
      return executeMemoryCapture(params as Parameters<typeof executeMemoryCapture>[0]);
    },
  });

  // ─── memory_query ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_query",
    label: "Query Memory",
    description:
      "Search the GSD memory store for relevant memories. Phase 1 uses keyword matching ranked " +
      "by confidence and reinforcement; future phases add semantic (embedding) retrieval.",
    promptSnippet:
      "Search the GSD memory store by keyword; returns ranked memories with id, category, and content",
    promptGuidelines: [
      "Use memory_query when you need durable project context that may not be in the current prompt.",
      "Provide a short keyword-style query — not a full question.",
      "Use category to narrow results to gotchas, conventions, architecture notes, etc.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Keyword query (2+ char terms)" }),
      k: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)", minimum: 1, maximum: 50 })),
      category: Type.Optional(
        Type.Union(
          [
            Type.Literal("architecture"),
            Type.Literal("convention"),
            Type.Literal("gotcha"),
            Type.Literal("preference"),
            Type.Literal("environment"),
            Type.Literal("pattern"),
          ],
          { description: "Restrict results to a single category" },
        ),
      ),
      scope: Type.Optional(Type.String({ description: "Only include memories with this scope (e.g. 'project', 'global')" })),
      tag: Type.Optional(Type.String({ description: "Only include memories tagged with this value" })),
      include_superseded: Type.Optional(Type.Boolean({ description: "Include superseded memories (default false)" })),
      reinforce_hits: Type.Optional(
        Type.Boolean({ description: "Increment hit_count on returned memories (default false)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const ok = await ensureDbOpen();
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot query memory." }],
          details: { operation: "memory_query", error: "db_unavailable" },
          isError: true,
        };
      }
      return executeMemoryQuery(params as Parameters<typeof executeMemoryQuery>[0]);
    },
  });

  // ─── gsd_graph ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "gsd_graph",
    label: "GSD Knowledge Graph",
    description:
      "Inspect the relationship graph between memories. mode=query walks supersedes edges from a " +
      "given memoryId; mode=build is a placeholder that future phases will use to rebuild graph " +
      "edges from milestone LEARNINGS artifacts.",
    promptSnippet: "Query the memory relationship graph or trigger a rebuild",
    promptGuidelines: [
      "Use mode=query with a memoryId when you want to see how a memory relates to others.",
      "Phase 1 only exposes supersedes edges; additional relation types arrive in later phases.",
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("build"), Type.Literal("query")], {
        description: "build = recompute graph (placeholder), query = inspect edges",
      }),
      memoryId: Type.Optional(Type.String({ description: "Memory ID (required when mode=query)" })),
      depth: Type.Optional(Type.Number({ description: "Hops to traverse (0–5, default 1)", minimum: 0, maximum: 5 })),
      rel: Type.Optional(Type.Union([
        Type.Literal("related_to"),
        Type.Literal("depends_on"),
        Type.Literal("contradicts"),
        Type.Literal("elaborates"),
        Type.Literal("supersedes"),
      ], { description: "Only include edges with this relation type" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const ok = await ensureDbOpen();
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: "Error: GSD database is not available." }],
          details: { operation: "gsd_graph", error: "db_unavailable" },
          isError: true,
        };
      }
      return executeGsdGraph(params as Parameters<typeof executeGsdGraph>[0]);
    },
  });
}
