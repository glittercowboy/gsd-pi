import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";

import { findMilestoneIds, nextMilestoneId, claimReservedId, getReservedMilestoneIds } from "../guided-flow.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { ensureDbOpen } from "./dynamic-tools.js";

/**
 * Register an alias tool that shares the same execute function as its canonical counterpart.
 * The alias description and promptGuidelines direct the LLM to prefer the canonical name.
 */
function registerAlias(pi: ExtensionAPI, toolDef: any, aliasName: string, canonicalName: string): void {
  pi.registerTool({
    ...toolDef,
    name: aliasName,
    description: toolDef.description + ` (alias for ${canonicalName} — prefer the canonical name)`,
    promptGuidelines: [`Alias for ${canonicalName} — prefer the canonical name.`],
  });
}

export function registerDbTools(pi: ExtensionAPI): void {
  // ─── gsd_decision_save (formerly gsd_save_decision) ─────────────────────

  const decisionSaveExecute = async (_toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot save decision." }],
        details: { operation: "save_decision", error: "db_unavailable" } as any,
      };
    }
    try {
      const { saveDecisionToDb } = await import("../db-writer.js");
      const { id } = await saveDecisionToDb(
        {
          scope: params.scope,
          decision: params.decision,
          choice: params.choice,
          rationale: params.rationale,
          revisable: params.revisable,
          when_context: params.when_context,
          made_by: params.made_by,
        },
        process.cwd(),
      );
      return {
        content: [{ type: "text" as const, text: `Saved decision ${id}` }],
        details: { operation: "save_decision", id } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`gsd-db: gsd_decision_save tool failed: ${msg}\n`);
      return {
        content: [{ type: "text" as const, text: `Error saving decision: ${msg}` }],
        details: { operation: "save_decision", error: msg } as any,
      };
    }
  };

  const decisionSaveTool = {
    name: "gsd_decision_save",
    label: "Save Decision",
    description:
      "Record a project decision to the GSD database and regenerate DECISIONS.md. " +
      "Decision IDs are auto-assigned — never provide an ID manually.",
    promptSnippet: "Record a project decision to the GSD database (auto-assigns ID, regenerates DECISIONS.md)",
    promptGuidelines: [
      "Use gsd_decision_save when recording an architectural, pattern, library, or observability decision.",
      "Decision IDs are auto-assigned (D001, D002, ...) — never guess or provide an ID.",
      "All fields except revisable, when_context, and made_by are required.",
      "The tool writes to the DB and regenerates .gsd/DECISIONS.md automatically.",
      "Set made_by to 'human' when the user explicitly directed the decision, 'agent' when the LLM chose autonomously (default), or 'collaborative' when it was discussed and agreed together.",
    ],
    parameters: Type.Object({
      scope: Type.String({ description: "Scope of the decision (e.g. 'architecture', 'library', 'observability')" }),
      decision: Type.String({ description: "What is being decided" }),
      choice: Type.String({ description: "The choice made" }),
      rationale: Type.String({ description: "Why this choice was made" }),
      revisable: Type.Optional(Type.String({ description: "Whether this can be revisited (default: 'Yes')" })),
      when_context: Type.Optional(Type.String({ description: "When/context for the decision (e.g. milestone ID)" })),
      made_by: Type.Optional(Type.Union([
        Type.Literal("human"),
        Type.Literal("agent"),
        Type.Literal("collaborative"),
      ], { description: "Who made this decision: 'human' (user directed), 'agent' (LLM decided autonomously), or 'collaborative' (discussed and agreed). Default: 'agent'" })),
    }),
    execute: decisionSaveExecute,
    renderCall(args: any, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("decision_save "));
      if (args.scope) text += theme.fg("accent", `[${args.scope}] `);
      if (args.decision) text += theme.fg("muted", args.decision);
      if (args.choice) text += theme.fg("dim", ` — ${args.choice}`);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const d = result.details;
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Decision ${d?.id ?? ""} saved`);
      if (d?.id) text += theme.fg("dim", ` → DECISIONS.md`);
      return new Text(text, 0, 0);
    },
  };

  pi.registerTool(decisionSaveTool);
  registerAlias(pi, decisionSaveTool, "gsd_save_decision", "gsd_decision_save");

  // ─── gsd_requirement_update (formerly gsd_update_requirement) ───────────

  const requirementUpdateExecute = async (_toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot update requirement." }],
        details: { operation: "update_requirement", id: params.id, error: "db_unavailable" } as any,
      };
    }
    try {
      const db = await import("../gsd-db.js");
      const existing = db.getRequirementById(params.id);
      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `Error: Requirement ${params.id} not found.` }],
          details: { operation: "update_requirement", id: params.id, error: "not_found" } as any,
        };
      }
      const { updateRequirementInDb } = await import("../db-writer.js");
      const updates: Record<string, string | undefined> = {};
      if (params.status !== undefined) updates.status = params.status;
      if (params.validation !== undefined) updates.validation = params.validation;
      if (params.notes !== undefined) updates.notes = params.notes;
      if (params.description !== undefined) updates.description = params.description;
      if (params.primary_owner !== undefined) updates.primary_owner = params.primary_owner;
      if (params.supporting_slices !== undefined) updates.supporting_slices = params.supporting_slices;
      await updateRequirementInDb(params.id, updates, process.cwd());
      return {
        content: [{ type: "text" as const, text: `Updated requirement ${params.id}` }],
        details: { operation: "update_requirement", id: params.id } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`gsd-db: gsd_requirement_update tool failed: ${msg}\n`);
      return {
        content: [{ type: "text" as const, text: `Error updating requirement: ${msg}` }],
        details: { operation: "update_requirement", id: params.id, error: msg } as any,
      };
    }
  };

  const requirementUpdateTool = {
    name: "gsd_requirement_update",
    label: "Update Requirement",
    description:
      "Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md. " +
      "Provide the requirement ID (e.g. R001) and any fields to update.",
    promptSnippet: "Update an existing GSD requirement by ID (regenerates REQUIREMENTS.md)",
    promptGuidelines: [
      "Use gsd_requirement_update to change status, validation, notes, or other fields on an existing requirement.",
      "The id parameter is required — it must be an existing RXXX identifier.",
      "All other fields are optional — only provided fields are updated.",
      "The tool verifies the requirement exists before updating.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The requirement ID (e.g. R001, R014)" }),
      status: Type.Optional(Type.String({ description: "New status (e.g. 'active', 'validated', 'deferred')" })),
      validation: Type.Optional(Type.String({ description: "Validation criteria or proof" })),
      notes: Type.Optional(Type.String({ description: "Additional notes" })),
      description: Type.Optional(Type.String({ description: "Updated description" })),
      primary_owner: Type.Optional(Type.String({ description: "Primary owning slice" })),
      supporting_slices: Type.Optional(Type.String({ description: "Supporting slices" })),
    }),
    execute: requirementUpdateExecute,
    renderCall(args: any, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("requirement_update "));
      if (args.id) text += theme.fg("accent", args.id);
      const fields = ["status", "validation", "notes", "description"].filter((f) => args[f]);
      if (fields.length > 0) text += theme.fg("dim", ` (${fields.join(", ")})`);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const d = result.details;
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Requirement ${d?.id ?? ""} updated`);
      text += theme.fg("dim", ` → REQUIREMENTS.md`);
      return new Text(text, 0, 0);
    },
  };

  pi.registerTool(requirementUpdateTool);
  registerAlias(pi, requirementUpdateTool, "gsd_update_requirement", "gsd_requirement_update");

  // ─── gsd_summary_save (formerly gsd_save_summary) ──────────────────────

  const summarySaveExecute = async (_toolCallId: any, params: any, _signal: any, _onUpdate: any, _ctx: any) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot save artifact." }],
        details: { operation: "save_summary", error: "db_unavailable" } as any,
      };
    }
    const validTypes = ["SUMMARY", "RESEARCH", "CONTEXT", "ASSESSMENT"];
    if (!validTypes.includes(params.artifact_type)) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid artifact_type "${params.artifact_type}". Must be one of: ${validTypes.join(", ")}` }],
        details: { operation: "save_summary", error: "invalid_artifact_type" } as any,
      };
    }
    try {
      let relativePath: string;
      if (params.task_id && params.slice_id) {
        relativePath = `milestones/${params.milestone_id}/slices/${params.slice_id}/tasks/${params.task_id}-${params.artifact_type}.md`;
      } else if (params.slice_id) {
        relativePath = `milestones/${params.milestone_id}/slices/${params.slice_id}/${params.slice_id}-${params.artifact_type}.md`;
      } else {
        relativePath = `milestones/${params.milestone_id}/${params.milestone_id}-${params.artifact_type}.md`;
      }
      const { saveArtifactToDb } = await import("../db-writer.js");
      await saveArtifactToDb(
        {
          path: relativePath,
          artifact_type: params.artifact_type,
          content: params.content,
          milestone_id: params.milestone_id,
          slice_id: params.slice_id,
          task_id: params.task_id,
        },
        process.cwd(),
      );
      return {
        content: [{ type: "text" as const, text: `Saved ${params.artifact_type} artifact to ${relativePath}` }],
        details: { operation: "save_summary", path: relativePath, artifact_type: params.artifact_type } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`gsd-db: gsd_summary_save tool failed: ${msg}\n`);
      return {
        content: [{ type: "text" as const, text: `Error saving artifact: ${msg}` }],
        details: { operation: "save_summary", error: msg } as any,
      };
    }
  };

  const summarySaveTool = {
    name: "gsd_summary_save",
    label: "Save Summary",
    description:
      "Save a summary, research, context, or assessment artifact to the GSD database and write it to disk. " +
      "Computes the file path from milestone/slice/task IDs automatically.",
    promptSnippet: "Save a GSD artifact (summary/research/context/assessment) to DB and disk",
    promptGuidelines: [
      "Use gsd_summary_save to persist structured artifacts (SUMMARY, RESEARCH, CONTEXT, ASSESSMENT).",
      "milestone_id is required. slice_id and task_id are optional — they determine the file path.",
      "The tool computes the relative path automatically: milestones/M001/M001-SUMMARY.md, milestones/M001/slices/S01/S01-SUMMARY.md, etc.",
      "artifact_type must be one of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT.",
    ],
    parameters: Type.Object({
      milestone_id: Type.String({ description: "Milestone ID (e.g. M001)" }),
      slice_id: Type.Optional(Type.String({ description: "Slice ID (e.g. S01)" })),
      task_id: Type.Optional(Type.String({ description: "Task ID (e.g. T01)" })),
      artifact_type: Type.String({ description: "One of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT" }),
      content: Type.String({ description: "The full markdown content of the artifact" }),
    }),
    execute: summarySaveExecute,
    renderCall(args: any, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("summary_save "));
      if (args.artifact_type) text += theme.fg("accent", args.artifact_type);
      const path = [args.milestone_id, args.slice_id, args.task_id].filter(Boolean).join("/");
      if (path) text += theme.fg("dim", ` ${path}`);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const d = result.details;
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `${d?.artifact_type ?? "Artifact"} saved`);
      if (d?.path) text += theme.fg("dim", ` → ${d.path}`);
      return new Text(text, 0, 0);
    },
  };

  pi.registerTool(summarySaveTool);
  registerAlias(pi, summarySaveTool, "gsd_save_summary", "gsd_summary_save");

  // ─── gsd_milestone_generate_id (formerly gsd_generate_milestone_id) ────

  const milestoneGenerateIdExecute = async (_toolCallId: any, _params: any, _signal: any, _onUpdate: any, _ctx: any) => {
    try {
      // Claim a reserved ID if the guided-flow already previewed one to the user.
      // This guarantees the ID shown in the UI matches the one materialised on disk.
      const reserved = claimReservedId();
      if (reserved) {
        return {
          content: [{ type: "text" as const, text: reserved }],
          details: { operation: "generate_milestone_id", id: reserved, source: "reserved" } as any,
        };
      }

      const basePath = process.cwd();
      const existingIds = findMilestoneIds(basePath);
      const uniqueEnabled = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const allIds = [...new Set([...existingIds, ...getReservedMilestoneIds()])];
      const newId = nextMilestoneId(allIds, uniqueEnabled);
      return {
        content: [{ type: "text" as const, text: newId }],
        details: { operation: "generate_milestone_id", id: newId, existingCount: existingIds.length, uniqueEnabled } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error generating milestone ID: ${msg}` }],
        details: { operation: "generate_milestone_id", error: msg } as any,
      };
    }
  };

  const milestoneGenerateIdTool = {
    name: "gsd_milestone_generate_id",
    label: "Generate Milestone ID",
    description:
      "Generate the next milestone ID for a new GSD milestone. " +
      "Scans existing milestones on disk and respects the unique_milestone_ids preference. " +
      "Always use this tool when creating a new milestone — never invent milestone IDs manually.",
    promptSnippet: "Generate a valid milestone ID (respects unique_milestone_ids preference)",
    promptGuidelines: [
      "ALWAYS call gsd_milestone_generate_id before creating a new milestone directory or writing milestone files.",
      "Never invent or hardcode milestone IDs like M001, M002 — always use this tool.",
      "Call it once per milestone you need to create. For multi-milestone projects, call it once for each milestone in sequence.",
      "The tool returns the correct format based on project preferences (e.g. M001 or M001-r5jzab).",
    ],
    parameters: Type.Object({}),
    execute: milestoneGenerateIdExecute,
    renderCall(_args: any, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("milestone_generate_id")), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const d = result.details;
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Generated ${d?.id ?? "ID"}`);
      if (d?.source === "reserved") text += theme.fg("dim", " (reserved)");
      return new Text(text, 0, 0);
    },
  };

  pi.registerTool(milestoneGenerateIdTool);
  registerAlias(pi, milestoneGenerateIdTool, "gsd_generate_milestone_id", "gsd_milestone_generate_id");
}
