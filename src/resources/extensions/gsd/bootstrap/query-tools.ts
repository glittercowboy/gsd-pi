// GSD2 — Read-only query tools exposing DB state to the LLM via the WAL connection

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { ensureDbOpen } from "./dynamic-tools.js";
import { executeMilestoneStatus } from "../tools/workflow-tool-executors.js";
import { checkpointDatabase } from "../gsd-db.js";

export function registerQueryTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "gsd_milestone_status",
    label: "Milestone Status",
    description:
      "Read the current status of a milestone and all its slices from the GSD database. " +
      "Returns milestone metadata, per-slice status, and task counts per slice. " +
      "Use this instead of querying .gsd/gsd.db directly via sqlite3 or better-sqlite3.",
    promptSnippet: "Get milestone status, slice statuses, and task counts for a given milestoneId",
    promptGuidelines: [
      "Use this tool — not sqlite3 or better-sqlite3 — to inspect milestone or slice state from the DB.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID to query (e.g. M001)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const dbAvailable = await ensureDbOpen();
      if (!dbAvailable) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available. Cannot read milestone status." }],
          details: { operation: "milestone_status", error: "db_unavailable" },
        };
      }
      return executeMilestoneStatus(params);
    },
  });

  pi.registerTool({
    name: "gsd_checkpoint_db",
    label: "Checkpoint GSD Database",
    description:
      "Flush the SQLite WAL (Write-Ahead Log) into the base gsd.db file. " +
      "Call this before `git add .gsd/gsd.db` to ensure the committed database " +
      "contains current milestone/slice/task state rather than stale pre-session content. " +
      "Safe to call at any time while GSD is running.",
    promptSnippet: "Flush WAL into gsd.db so git add stages current state",
    promptGuidelines: [
      "Call gsd_checkpoint_db immediately before staging .gsd/gsd.db with git add.",
      "Do not use sqlite3 or shell commands to checkpoint — they are blocked. Use this tool instead.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const dbAvailable = await ensureDbOpen();
      if (!dbAvailable) {
        return {
          content: [{ type: "text", text: "Error: GSD database is not available. Cannot checkpoint." }],
          details: { operation: "checkpoint_db", error: "db_unavailable" },
        };
      }
      checkpointDatabase();
      return {
        content: [{ type: "text", text: "WAL checkpoint complete. gsd.db is now up to date and safe to stage with git add." }],
        details: { operation: "checkpoint_db", status: "ok" },
      };
    },
  });
}
