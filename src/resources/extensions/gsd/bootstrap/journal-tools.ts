import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";

import { queryJournal } from "../journal.js";
import { logWarning } from "../workflow-logger.js";

export function registerJournalTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "gsd_journal_query",
    label: "Query Journal",
    description:
      "Query the structured event journal for auto-mode iterations. " +
      "Returns matching journal entries filtered by flow ID, unit ID, rule name, event type, or time range.",
    promptSnippet: "Query the GSD event journal with filters (flowId, unitId, rule, eventType, time range, limit)",
    promptGuidelines: [
      "Filter by flowId to trace all events from a single auto-mode iteration.",
      "Filter by unitId to reconstruct the causal chain for a specific milestone/slice/task.",
      "Use limit to control context size — default is 100 entries.",
    ],
    parameters: Type.Object({
      flowId: Type.Optional(Type.String({ description: "Filter by flow ID (UUID grouping one iteration)" })),
      unitId: Type.Optional(Type.String({ description: "Filter by unit ID (e.g. M001/S01/T01) from event data" })),
      rule: Type.Optional(Type.String({ description: "Filter by rule name from the unified registry" })),
      eventType: Type.Optional(Type.String({ description: "Filter by event type (e.g. dispatch-match, unit-start)" })),
      after: Type.Optional(Type.String({ description: "ISO-8601 lower bound (inclusive)" })),
      before: Type.Optional(Type.String({ description: "ISO-8601 upper bound (inclusive)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum entries to return (default: 100)", default: 100 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const filters: Record<string, string | undefined> = {};
        if (params.flowId !== undefined) filters.flowId = params.flowId;
        if (params.unitId !== undefined) filters.unitId = params.unitId;
        if (params.rule !== undefined) filters.rule = params.rule;
        if (params.eventType !== undefined) filters.eventType = params.eventType;
        if (params.after !== undefined) filters.after = params.after;
        if (params.before !== undefined) filters.before = params.before;

        const entries = queryJournal(process.cwd(), filters);
        const limited = entries.slice(0, params.limit ?? 100);

        if (limited.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No matching journal entries found." }],
            details: { operation: "journal_query", count: 0 } as any,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(limited, null, 2) }],
          details: { operation: "journal_query", count: limited.length } as any,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logWarning("tool", `gsd_journal_query tool failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error querying journal: ${msg}` }],
          details: { operation: "journal_query", error: msg } as any,
        };
      }
    },
  });
}
