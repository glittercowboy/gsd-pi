import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";

import { findMilestoneIds, nextMilestoneId, claimReservedId, getReservedMilestoneIds } from "../guided-flow.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { ensureDbOpen } from "./dynamic-tools.js";
import { StringEnum } from "@gsd/pi-ai";
import { logError } from "../workflow-logger.js";
import { getErrorMessage } from "../error-utils.js";
import { shouldBlockContextArtifactSave } from "./write-gate.js";

const SUPPORTED_SUMMARY_ARTIFACT_TYPES = ["SUMMARY", "RESEARCH", "CONTEXT", "ASSESSMENT", "CONTEXT-DRAFT"] as const;

export function isSupportedSummaryArtifactType(
  artifactType: string,
): artifactType is (typeof SUPPORTED_SUMMARY_ARTIFACT_TYPES)[number] {
  return (SUPPORTED_SUMMARY_ARTIFACT_TYPES as readonly string[]).includes(artifactType);
}

/**
 * Register an alias tool that shares the same execute function as its canonical counterpart.
 * The alias description and promptGuidelines direct the LLM to prefer the canonical name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- toolDef shape matches ToolDefinition but typing it fully requires generics
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

  const decisionSaveExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
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
      logError("tool", `gsd_decision_save tool failed: ${msg}`, { tool: "gsd_decision_save", error: String(err) });
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

  const requirementUpdateExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot update requirement." }],
        details: { operation: "update_requirement", id: params.id, error: "db_unavailable" } as any,
      };
    }
    try {
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
      logError("tool", `gsd_requirement_update tool failed: ${msg}`, { tool: "gsd_requirement_update", error: String(err) });
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

  // ─── gsd_requirement_save ─────────────────────────────────────────────

  const requirementSaveExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot save requirement." }],
        details: { operation: "save_requirement", error: "db_unavailable" } as any,
      };
    }
    try {
      const { saveRequirementToDb } = await import("../db-writer.js");
      const result = await saveRequirementToDb(
        {
          class: params.class,
          status: params.status,
          description: params.description,
          why: params.why,
          source: params.source,
          primary_owner: params.primary_owner,
          supporting_slices: params.supporting_slices,
          validation: params.validation,
          notes: params.notes,
        },
        process.cwd(),
      );
      return {
        content: [{ type: "text" as const, text: `Saved requirement ${result.id}` }],
        details: { operation: "save_requirement", id: result.id } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `gsd_requirement_save tool failed: ${msg}`, { tool: "gsd_requirement_save", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error saving requirement: ${msg}` }],
        details: { operation: "save_requirement", error: msg } as any,
      };
    }
  };

  const requirementSaveTool = {
    name: "gsd_requirement_save",
    label: "Save Requirement",
    description:
      "Record a new requirement to the GSD database and regenerate REQUIREMENTS.md. " +
      "Requirement IDs are auto-assigned — never provide an ID manually.",
    promptSnippet: "Record a new GSD requirement to the database (auto-assigns ID, regenerates REQUIREMENTS.md)",
    promptGuidelines: [
      "Use gsd_requirement_save when recording a new functional, non-functional, or operational requirement.",
      "Requirement IDs are auto-assigned (R001, R002, ...) — never guess or provide an ID.",
      "class, description, why, and source are required. All other fields are optional.",
      "The tool writes to the DB and regenerates .gsd/REQUIREMENTS.md automatically.",
    ],
    parameters: Type.Object({
      class: Type.String({ description: "Requirement class (e.g. 'functional', 'non-functional', 'operational')" }),
      description: Type.String({ description: "Short description of the requirement" }),
      why: Type.String({ description: "Why this requirement matters" }),
      source: Type.String({ description: "Origin of the requirement (e.g. 'user-research', 'design', 'M001')" }),
      status: Type.Optional(Type.String({ description: "Status (default: 'active')" })),
      primary_owner: Type.Optional(Type.String({ description: "Primary owning slice" })),
      supporting_slices: Type.Optional(Type.String({ description: "Supporting slices" })),
      validation: Type.Optional(Type.String({ description: "Validation criteria" })),
      notes: Type.Optional(Type.String({ description: "Additional notes" })),
    }),
    execute: requirementSaveExecute,
    renderCall(args: any, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("requirement_save "));
      if (args.class) text += theme.fg("accent", `[${args.class}] `);
      if (args.description) text += theme.fg("muted", args.description);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const d = result.details;
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Requirement ${d?.id ?? ""} saved`);
      text += theme.fg("dim", ` → REQUIREMENTS.md`);
      return new Text(text, 0, 0);
    },
  };

  pi.registerTool(requirementSaveTool);
  registerAlias(pi, requirementSaveTool, "gsd_save_requirement", "gsd_requirement_save");

  // ─── gsd_summary_save (formerly gsd_save_summary) ──────────────────────

  const summarySaveExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot save artifact." }],
        details: { operation: "save_summary", error: "db_unavailable" } as any,
      };
    }
    if (!isSupportedSummaryArtifactType(params.artifact_type)) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid artifact_type "${params.artifact_type}". Must be one of: ${SUPPORTED_SUMMARY_ARTIFACT_TYPES.join(", ")}` }],
        details: { operation: "save_summary", error: "invalid_artifact_type" } as any,
      };
    }
    const contextGuard = shouldBlockContextArtifactSave(
      params.artifact_type,
      params.milestone_id ?? null,
      params.slice_id ?? null,
    );
    if (contextGuard.block) {
      return {
        content: [{ type: "text" as const, text: `Error saving artifact: ${contextGuard.reason ?? "context write blocked"}` }],
        details: { operation: "save_summary", error: "context_write_blocked" } as any,
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
      logError("tool", `gsd_summary_save tool failed: ${msg}`, { tool: "gsd_summary_save", error: String(err) });
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
      "Use gsd_summary_save to persist structured artifacts (SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT).",
      "milestone_id is required. slice_id and task_id are optional — they determine the file path.",
      "The tool computes the relative path automatically: milestones/M001/M001-SUMMARY.md, milestones/M001/slices/S01/S01-SUMMARY.md, etc.",
      "artifact_type must be one of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT.",
      "Use CONTEXT-DRAFT for incremental draft persistence; use CONTEXT for the final milestone context after depth verification.",
    ],
    parameters: Type.Object({
      milestone_id: Type.String({ description: "Milestone ID (e.g. M001)" }),
      slice_id: Type.Optional(Type.String({ description: "Slice ID (e.g. S01)" })),
      task_id: Type.Optional(Type.String({ description: "Task ID (e.g. T01)" })),
      artifact_type: Type.String({ description: "One of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT" }),
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

  const milestoneGenerateIdExecute = async (_toolCallId: string, _params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    try {
      // Claim a reserved ID if the guided-flow already previewed one to the user.
      // This guarantees the ID shown in the UI matches the one materialised on disk.
      const reserved = claimReservedId();
      if (reserved) {
        await ensureMilestoneDbRow(reserved);
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
      await ensureMilestoneDbRow(newId);
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

  /**
   * Insert a minimal DB row for a milestone ID so it's visible to the state
   * machine. Uses INSERT OR IGNORE — safe to call even if gsd_plan_milestone
   * later writes the full row. Silently skips if the DB isn't available yet
   * (pre-migration).
   */
  async function ensureMilestoneDbRow(milestoneId: string): Promise<void> {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) return;
    try {
      const { insertMilestone } = await import("../gsd-db.js");
      insertMilestone({ id: milestoneId, status: "queued" });
    } catch (e) {
      logError("tool", `insertMilestone failed for ${milestoneId}: ${(e as Error).message}`);
    }
  }

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

  // ─── gsd_plan_milestone (gsd_milestone_plan alias) ─────────────────────

  const planMilestoneExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot plan milestone." }],
        details: { operation: "plan_milestone", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handlePlanMilestone } = await import("../tools/plan-milestone.js");
      const result = await handlePlanMilestone(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error planning milestone: ${result.error}` }],
          details: { operation: "plan_milestone", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Planned milestone ${result.milestoneId}` }],
        details: {
          operation: "plan_milestone",
          milestoneId: result.milestoneId,
          roadmapPath: result.roadmapPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `plan_milestone tool failed: ${msg}`, { tool: "gsd_plan_milestone", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error planning milestone: ${msg}` }],
        details: { operation: "plan_milestone", error: msg } as any,
      };
    }
  };

  const planMilestoneTool = {
    name: "gsd_plan_milestone",
    label: "Plan Milestone",
    description:
      "Write milestone planning state to the GSD database, render ROADMAP.md from DB, and clear caches after a successful render.",
    promptSnippet: "Plan a milestone via DB write + roadmap render + cache invalidation",
    promptGuidelines: [
      "Use gsd_plan_milestone for milestone planning instead of writing ROADMAP.md directly.",
      "Keep parameters flat and provide the full milestone planning payload, including slices.",
      "The tool validates input, writes milestone and slice planning data transactionally, renders ROADMAP.md from DB, and clears both state and parse caches after success.",
      "Use the canonical name gsd_plan_milestone; gsd_milestone_plan is only an alias.",
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      title: Type.String({ description: "Milestone title" }),
      vision: Type.String({ description: "Milestone vision" }),
      slices: Type.Array(Type.Object({
        sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
        title: Type.String({ description: "Slice title" }),
        risk: Type.String({ description: "Slice risk" }),
        depends: Type.Array(Type.String(), { description: "Slice dependency IDs" }),
        demo: Type.String({ description: "Roadmap demo text / After this" }),
        goal: Type.String({ description: "Slice goal" }),
        successCriteria: Type.String({ description: "Slice success criteria block" }),
        proofLevel: Type.String({ description: "Slice proof level" }),
        integrationClosure: Type.String({ description: "Slice integration closure" }),
        observabilityImpact: Type.String({ description: "Slice observability impact" }),
      }), { description: "Planned slices for the milestone" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      status: Type.Optional(Type.String({ description: "Milestone status (defaults to active)" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Milestone dependencies" })),
      successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Top-level success criteria bullets" })),
      keyRisks: Type.Optional(Type.Array(Type.Object({
        risk: Type.String({ description: "Risk statement" }),
        whyItMatters: Type.String({ description: "Why the risk matters" }),
      }), { description: "Structured risk entries" })),
      proofStrategy: Type.Optional(Type.Array(Type.Object({
        riskOrUnknown: Type.String({ description: "Risk or unknown to retire" }),
        retireIn: Type.String({ description: "Where it will be retired" }),
        whatWillBeProven: Type.String({ description: "What proof will be produced" }),
      }), { description: "Structured proof strategy entries" })),
      verificationContract: Type.Optional(Type.String({ description: "Verification contract text" })),
      verificationIntegration: Type.Optional(Type.String({ description: "Integration verification text" })),
      verificationOperational: Type.Optional(Type.String({ description: "Operational verification text" })),
      verificationUat: Type.Optional(Type.String({ description: "UAT verification text" })),
      definitionOfDone: Type.Optional(Type.Array(Type.String(), { description: "Definition of done bullets" })),
      requirementCoverage: Type.Optional(Type.String({ description: "Requirement coverage text" })),
      boundaryMapMarkdown: Type.Optional(Type.String({ description: "Boundary map markdown block" })),
    }),
    execute: planMilestoneExecute,
  };

  pi.registerTool(planMilestoneTool);
  registerAlias(pi, planMilestoneTool, "gsd_milestone_plan", "gsd_plan_milestone");

  // ─── gsd_plan_slice (gsd_slice_plan alias) ─────────────────────────────

  const planSliceExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot plan slice." }],
        details: { operation: "plan_slice", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handlePlanSlice } = await import("../tools/plan-slice.js");
      const result = await handlePlanSlice(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error planning slice: ${result.error}` }],
          details: { operation: "plan_slice", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Planned slice ${result.sliceId} (${result.milestoneId})` }],
        details: {
          operation: "plan_slice",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          planPath: result.planPath,
          taskPlanPaths: result.taskPlanPaths,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `plan_slice tool failed: ${msg}`, { tool: "gsd_plan_slice", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error planning slice: ${msg}` }],
        details: { operation: "plan_slice", error: msg } as any,
      };
    }
  };

  const planSliceTool = {
    name: "gsd_plan_slice",
    label: "Plan Slice",
    description:
      "Write slice planning state to the GSD database, render S##-PLAN.md plus task PLAN artifacts from DB, and clear caches after a successful render.",
    promptSnippet: "Plan a slice via DB write + PLAN render + cache invalidation",
    promptGuidelines: [
      "Use gsd_plan_slice for slice planning instead of writing S##-PLAN.md or task PLAN files directly.",
      "Keep parameters flat and provide the full slice planning payload, including tasks.",
      "The tool validates input, requires an existing parent slice, writes slice/task planning data, renders PLAN.md and task plan files from DB, and clears both state and parse caches after success.",
      "Use the canonical name gsd_plan_slice; gsd_slice_plan is only an alias.",
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      goal: Type.String({ description: "Slice goal" }),
      tasks: Type.Array(Type.Object({
        taskId: Type.String({ description: "Task ID (e.g. T01)" }),
        title: Type.String({ description: "Task title" }),
        description: Type.String({ description: "Task description / steps block" }),
        estimate: Type.String({ description: "Task estimate string" }),
        files: Type.Array(Type.String(), { description: "Files likely touched" }),
        verify: Type.String({ description: "Verification command or block" }),
        inputs: Type.Array(Type.String(), { description: "Input files or references" }),
        expectedOutput: Type.Array(Type.String(), { description: "Expected output files or artifacts" }),
        observabilityImpact: Type.Optional(Type.String({ description: "Task observability impact" })),
      }), { description: "Planned tasks for the slice" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      successCriteria: Type.Optional(Type.String({ description: "Slice success criteria block" })),
      proofLevel: Type.Optional(Type.String({ description: "Slice proof level" })),
      integrationClosure: Type.Optional(Type.String({ description: "Slice integration closure" })),
      observabilityImpact: Type.Optional(Type.String({ description: "Slice observability impact" })),
    }),
    execute: planSliceExecute,
  };

  pi.registerTool(planSliceTool);
  registerAlias(pi, planSliceTool, "gsd_slice_plan", "gsd_plan_slice");

  // ─── gsd_plan_task (gsd_task_plan alias) ───────────────────────────────

  const planTaskExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot plan task." }],
        details: { operation: "plan_task", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handlePlanTask } = await import("../tools/plan-task.js");
      const result = await handlePlanTask(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error planning task: ${result.error}` }],
          details: { operation: "plan_task", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
        details: {
          operation: "plan_task",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          taskId: result.taskId,
          taskPlanPath: result.taskPlanPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `plan_task tool failed: ${msg}`, { tool: "gsd_plan_task", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error planning task: ${msg}` }],
        details: { operation: "plan_task", error: msg } as any,
      };
    }
  };

  const planTaskTool = {
    name: "gsd_plan_task",
    label: "Plan Task",
    description:
      "Write task planning state to the GSD database, render tasks/T##-PLAN.md from DB, and clear caches after a successful render.",
    promptSnippet: "Plan a task via DB write + task PLAN render + cache invalidation",
    promptGuidelines: [
      "Use gsd_plan_task for task planning instead of writing tasks/T##-PLAN.md directly.",
      "Keep parameters flat and provide the full task planning payload.",
      "The tool validates input, requires an existing parent slice, writes task planning data, renders the task PLAN file from DB, and clears both state and parse caches after success.",
      "Use the canonical name gsd_plan_task; gsd_task_plan is only an alias.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      taskId: Type.String({ description: "Task ID (e.g. T01)" }),
      title: Type.String({ description: "Task title" }),
      description: Type.String({ description: "Task description / steps block" }),
      estimate: Type.String({ description: "Task estimate string" }),
      files: Type.Array(Type.String(), { description: "Files likely touched" }),
      verify: Type.String({ description: "Verification command or block" }),
      inputs: Type.Array(Type.String(), { description: "Input files or references" }),
      expectedOutput: Type.Array(Type.String(), { description: "Expected output files or artifacts" }),
      observabilityImpact: Type.Optional(Type.String({ description: "Task observability impact" })),
    }),
    execute: planTaskExecute,
  };

  pi.registerTool(planTaskTool);
  registerAlias(pi, planTaskTool, "gsd_task_plan", "gsd_plan_task");

  // ─── gsd_task_complete (gsd_complete_task alias) ────────────────────────

  const taskCompleteExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot complete task." }],
        details: { operation: "complete_task", error: "db_unavailable" } as any,
      };
    }
    try {
      // Coerce string items to objects for verificationEvidence (#3541).
      const coerced = { ...params };
      coerced.verificationEvidence = (params.verificationEvidence ?? []).map((v: any) =>
        typeof v === "string" ? { command: v, exitCode: -1, verdict: "unknown (coerced from string)", durationMs: 0 } : v,
      );

      const { handleCompleteTask } = await import("../tools/complete-task.js");
      const result = await handleCompleteTask(coerced, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error completing task: ${result.error}` }],
          details: { operation: "complete_task", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Completed task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
        details: {
          operation: "complete_task",
          taskId: result.taskId,
          sliceId: result.sliceId,
          milestoneId: result.milestoneId,
          summaryPath: result.summaryPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `complete_task tool failed: ${msg}`, { tool: "gsd_task_complete", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error completing task: ${msg}` }],
        details: { operation: "complete_task", error: msg } as any,
      };
    }
  };

  const taskCompleteTool = {
    name: "gsd_task_complete",
    label: "Complete Task",
    description:
      "Record a completed task to the GSD database, render a SUMMARY.md to disk, and toggle the plan checkbox — all in one atomic operation. " +
      "Writes the task row inside a transaction, then performs filesystem writes outside the transaction.",
    promptSnippet: "Complete a GSD task (DB write + summary render + checkbox toggle)",
    promptGuidelines: [
      "Use gsd_task_complete (or gsd_complete_task) when a task is finished and needs to be recorded.",
      "All string fields are required. verificationEvidence is an array of objects with command, exitCode, verdict, durationMs.",
      "The tool validates required fields and returns an error message if any are missing.",
      "On success, returns the summaryPath where the SUMMARY.md was written.",
      "Idempotent — calling with the same params twice will upsert (INSERT OR REPLACE) without error.",
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      taskId: Type.String({ description: "Task ID (e.g. T01)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      oneLiner: Type.String({ description: "One-line summary of what was accomplished" }),
      narrative: Type.String({ description: "Detailed narrative of what happened during the task" }),
      verification: Type.String({ description: "What was verified and how — commands run, tests passed, behavior confirmed" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      deviations: Type.Optional(Type.String({ description: "Deviations from the task plan, or 'None.'" })),
      knownIssues: Type.Optional(Type.String({ description: "Known issues discovered but not fixed, or 'None.'" })),
      keyFiles: Type.Optional(Type.Array(Type.String(), { description: "List of key files created or modified" })),
      keyDecisions: Type.Optional(Type.Array(Type.String(), { description: "List of key decisions made during this task" })),
      blockerDiscovered: Type.Optional(Type.Boolean({ description: "Whether a plan-invalidating blocker was discovered" })),
      verificationEvidence: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            command: Type.String({ description: "Verification command that was run" }),
            exitCode: Type.Number({ description: "Exit code of the command" }),
            verdict: Type.String({ description: "Pass/fail verdict (e.g. '✅ pass', '❌ fail')" }),
            durationMs: Type.Number({ description: "Duration of the command in milliseconds" }),
          }),
          Type.String({ description: "Fallback: verification summary string" }),
        ]),
        { description: "Array of verification evidence entries" },
      )),
    }),
    execute: taskCompleteExecute,
  };

  pi.registerTool(taskCompleteTool);
  registerAlias(pi, taskCompleteTool, "gsd_complete_task", "gsd_task_complete");

  // ─── gsd_slice_complete (gsd_complete_slice alias) ─────────────────────

  const sliceCompleteExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot complete slice." }],
        details: { operation: "complete_slice", error: "db_unavailable" } as any,
      };
    }
    try {
      // Coerce string items to objects for fields where LLMs sometimes pass
      // plain strings instead of the expected { key, value } shape (#3541).
      // Parses "key — value" or "key - value" format when possible.
      const splitPair = (s: string): [string, string] => {
        const m = s.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
        return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ""];
      };
      const coerced = { ...params };
      // Coerce simple string-array fields: LLMs sometimes pass a plain string
      // instead of a single-element array (#3585).
      const wrapArray = (v: any): any[] =>
        v == null ? [] : Array.isArray(v) ? v : [v];
      coerced.provides = wrapArray(params.provides);
      coerced.keyFiles = wrapArray(params.keyFiles);
      coerced.keyDecisions = wrapArray(params.keyDecisions);
      coerced.patternsEstablished = wrapArray(params.patternsEstablished);
      coerced.observabilitySurfaces = wrapArray(params.observabilitySurfaces);
      coerced.requirementsSurfaced = wrapArray(params.requirementsSurfaced);
      coerced.drillDownPaths = wrapArray(params.drillDownPaths);
      coerced.affects = wrapArray(params.affects);
      coerced.filesModified = wrapArray(params.filesModified).map((f: any) => {
        if (typeof f !== "string") return f;
        const [path, description] = splitPair(f);
        return { path, description };
      });
      coerced.requires = wrapArray(params.requires).map((r: any) => {
        if (typeof r !== "string") return r;
        const [slice, provides] = splitPair(r);
        return { slice, provides };
      });
      coerced.requirementsAdvanced = wrapArray(params.requirementsAdvanced).map((r: any) => {
        if (typeof r !== "string") return r;
        const [id, how] = splitPair(r);
        return { id, how };
      });
      coerced.requirementsValidated = wrapArray(params.requirementsValidated).map((r: any) => {
        if (typeof r !== "string") return r;
        const [id, proof] = splitPair(r);
        return { id, proof };
      });
      coerced.requirementsInvalidated = wrapArray(params.requirementsInvalidated).map((r: any) => {
        if (typeof r !== "string") return r;
        const [id, what] = splitPair(r);
        return { id, what };
      });

      const { handleCompleteSlice } = await import("../tools/complete-slice.js");
      const result = await handleCompleteSlice(coerced, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error completing slice: ${result.error}` }],
          details: { operation: "complete_slice", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Completed slice ${result.sliceId} (${result.milestoneId})` }],
        details: {
          operation: "complete_slice",
          sliceId: result.sliceId,
          milestoneId: result.milestoneId,
          summaryPath: result.summaryPath,
          uatPath: result.uatPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `complete_slice tool failed: ${msg}`, { tool: "gsd_slice_complete", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error completing slice: ${msg}` }],
        details: { operation: "complete_slice", error: msg } as any,
      };
    }
  };

  const sliceCompleteTool = {
    name: "gsd_slice_complete",
    label: "Complete Slice",
    description:
      "Record a completed slice to the GSD database, render SUMMARY.md + UAT.md to disk, and toggle the roadmap checkbox — all in one atomic operation. " +
      "Validates all tasks are complete before proceeding. Writes the slice row inside a transaction, then performs filesystem writes outside the transaction.",
    promptSnippet: "Complete a GSD slice (DB write + summary/UAT render + roadmap checkbox toggle)",
    promptGuidelines: [
      "Use gsd_slice_complete (or gsd_complete_slice) when all tasks in a slice are finished and the slice needs to be recorded.",
      "All tasks in the slice must have status 'complete' — the handler validates this before proceeding.",
      "On success, returns summaryPath and uatPath where the files were written.",
      "Idempotent — calling with the same params twice will not crash.",
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceTitle: Type.String({ description: "Title of the slice" }),
      oneLiner: Type.String({ description: "One-line summary of what the slice accomplished" }),
      narrative: Type.String({ description: "Detailed narrative of what happened across all tasks" }),
      verification: Type.String({ description: "What was verified across all tasks" }),
      uatContent: Type.String({ description: "UAT test content (markdown body)" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      deviations: Type.Optional(Type.String({ description: "Deviations from the slice plan, or 'None.'" })),
      knownLimitations: Type.Optional(Type.String({ description: "Known limitations or gaps, or 'None.'" })),
      followUps: Type.Optional(Type.String({ description: "Follow-up work discovered during execution, or 'None.'" })),
      keyFiles: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Key files created or modified" })),
      keyDecisions: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Key decisions made during this slice" })),
      patternsEstablished: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Patterns established by this slice" })),
      observabilitySurfaces: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Observability surfaces added" })),
      provides: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "What this slice provides to downstream slices" })),
      requirementsSurfaced: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "New requirements surfaced" })),
      drillDownPaths: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Paths to task summaries for drill-down" })),
      affects: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Downstream slices affected" })),
      requirementsAdvanced: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            id: Type.String({ description: "Requirement ID" }),
            how: Type.String({ description: "How it was advanced" }),
          }),
          Type.String({ description: "Fallback: 'ID — how' string" }),
        ]),
        { description: "Requirements advanced by this slice" },
      )),
      requirementsValidated: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            id: Type.String({ description: "Requirement ID" }),
            proof: Type.String({ description: "What proof validates it" }),
          }),
          Type.String({ description: "Fallback: 'ID — proof' string" }),
        ]),
        { description: "Requirements validated by this slice" },
      )),
      requirementsInvalidated: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            id: Type.String({ description: "Requirement ID" }),
            what: Type.String({ description: "What changed" }),
          }),
          Type.String({ description: "Fallback: 'ID — what' string" }),
        ]),
        { description: "Requirements invalidated or re-scoped" },
      )),
      filesModified: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            path: Type.String({ description: "File path" }),
            description: Type.String({ description: "What changed" }),
          }),
          Type.String({ description: "Fallback: file path string" }),
        ]),
        { description: "Files modified with descriptions" },
      )),
      requires: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            slice: Type.String({ description: "Dependency slice ID" }),
            provides: Type.String({ description: "What was consumed from it" }),
          }),
          Type.String({ description: "Fallback: slice ID string" }),
        ]),
        { description: "Upstream slice dependencies consumed" },
      )),
    }),
    execute: sliceCompleteExecute,
  };

  pi.registerTool(sliceCompleteTool);
  registerAlias(pi, sliceCompleteTool, "gsd_complete_slice", "gsd_slice_complete");

  // ─── gsd_skip_slice (#3477 / #3487) ───────────────────────────────────

  const skipSliceExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot skip slice." }],
        details: { operation: "skip_slice", error: "db_unavailable" } as any,
      };
    }
    try {
      const { getSlice, updateSliceStatus } = await import("../gsd-db.js");
      const { invalidateStateCache } = await import("../state.js");

      const slice = getSlice(params.milestoneId, params.sliceId);
      if (!slice) {
        return {
          content: [{ type: "text" as const, text: `Error: Slice ${params.sliceId} not found in milestone ${params.milestoneId}` }],
          details: { operation: "skip_slice", error: "slice_not_found" } as any,
        };
      }

      if (slice.status === "complete" || slice.status === "done") {
        return {
          content: [{ type: "text" as const, text: `Error: Slice ${params.sliceId} is already complete — cannot skip.` }],
          details: { operation: "skip_slice", error: "already_complete" } as any,
        };
      }

      if (slice.status === "skipped") {
        return {
          content: [{ type: "text" as const, text: `Slice ${params.sliceId} is already skipped.` }],
          details: { operation: "skip_slice", sliceId: params.sliceId, milestoneId: params.milestoneId } as any,
        };
      }

      updateSliceStatus(params.milestoneId, params.sliceId, "skipped");
      invalidateStateCache();

      // Rebuild STATE.md so it reflects the skip immediately (#3477).
      // Without this, /gsd auto reads stale STATE.md and resumes the skipped slice.
      try {
        const basePath = process.cwd();
        const { rebuildState } = await import("../doctor.js");
        await rebuildState(basePath);
      } catch (err) {
        logError("tool", `skip_slice rebuildState failed: ${(err as Error).message}`, { tool: "gsd_skip_slice" });
      }

      return {
        content: [{ type: "text" as const, text: `Skipped slice ${params.sliceId} (${params.milestoneId}). Reason: ${params.reason ?? "User-directed skip"}. Auto-mode will advance past this slice.` }],
        details: {
          operation: "skip_slice",
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          reason: params.reason,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `skip_slice tool failed: ${msg}`, { tool: "gsd_skip_slice", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error skipping slice: ${msg}` }],
        details: { operation: "skip_slice", error: msg } as any,
      };
    }
  };

  pi.registerTool({
    name: "gsd_skip_slice",
    label: "Skip Slice",
    description:
      "Mark a slice as skipped so auto-mode advances past it without executing. " +
      "The slice data is preserved for reference. The state machine treats skipped slices like completed ones for dependency satisfaction.",
    promptSnippet: "Skip a GSD slice (mark as skipped, auto-mode will advance past it)",
    promptGuidelines: [
      "Use gsd_skip_slice when a slice should be bypassed — descoped, superseded, or no longer relevant.",
      "Cannot skip a slice that is already complete.",
      "Skipped slices satisfy downstream dependencies just like completed slices.",
    ],
    parameters: Type.Object({
      sliceId: Type.String({ description: "Slice ID (e.g. S02)" }),
      milestoneId: Type.String({ description: "Milestone ID (e.g. M003)" }),
      reason: Type.Optional(Type.String({ description: "Reason for skipping this slice" })),
    }),
    execute: skipSliceExecute,
  });

  // ─── gsd_complete_milestone ────────────────────────────────────────────

  const milestoneCompleteExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot complete milestone." }],
        details: { operation: "complete_milestone", error: "db_unavailable" } as any,
      };
    }
    try {
      // ── Input sanitization: normalize markdown parameters (#3013) ──────
      const { sanitizeCompleteMilestoneParams } = await import("./sanitize-complete-milestone.js");
      const sanitized = sanitizeCompleteMilestoneParams(params);

      const { handleCompleteMilestone } = await import("../tools/complete-milestone.js");
      const result = await handleCompleteMilestone(sanitized, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error completing milestone: ${result.error}` }],
          details: { operation: "complete_milestone", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Completed milestone ${result.milestoneId}. Summary written to ${result.summaryPath}` }],
        details: {
          operation: "complete_milestone",
          milestoneId: result.milestoneId,
          summaryPath: result.summaryPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `complete_milestone tool failed: ${msg}`, { tool: "gsd_complete_milestone", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error completing milestone: ${msg}` }],
        details: { operation: "complete_milestone", error: msg } as any,
      };
    }
  };

  const milestoneCompleteTool = {
    name: "gsd_complete_milestone",
    label: "Complete Milestone",
    description:
      "Record a completed milestone to the GSD database, render MILESTONE-SUMMARY.md to disk — all in one atomic operation. " +
      "Validates all slices are complete before proceeding.",
    promptSnippet: "Complete a GSD milestone (DB write + summary render)",
    promptGuidelines: [
      "Use gsd_complete_milestone when all slices in a milestone are finished and the milestone needs to be recorded.",
      "All slices in the milestone must have status 'complete' — the handler validates this before proceeding.",
      "verificationPassed must be explicitly set to true — the handler rejects completion if verification did not pass.",
      "On success, returns summaryPath where the MILESTONE-SUMMARY.md was written.",
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      title: Type.String({ description: "Milestone title" }),
      oneLiner: Type.String({ description: "One-sentence summary of what the milestone achieved" }),
      narrative: Type.String({ description: "Detailed narrative of what happened during the milestone" }),
      verificationPassed: Type.Boolean({ description: "Must be true — confirms that code change verification, success criteria, and definition of done checks all passed before completion" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      successCriteriaResults: Type.Optional(Type.String({ description: "Markdown detailing how each success criterion was met or not met" })),
      definitionOfDoneResults: Type.Optional(Type.String({ description: "Markdown detailing how each definition-of-done item was met" })),
      requirementOutcomes: Type.Optional(Type.String({ description: "Markdown detailing requirement status transitions with evidence" })),
      keyDecisions: Type.Optional(Type.Array(Type.String(), { description: "Key architectural/pattern decisions made during the milestone" })),
      keyFiles: Type.Optional(Type.Array(Type.String(), { description: "Key files created or modified during the milestone" })),
      lessonsLearned: Type.Optional(Type.Array(Type.String(), { description: "Lessons learned during the milestone" })),
      followUps: Type.Optional(Type.String({ description: "Follow-up items for future milestones" })),
      deviations: Type.Optional(Type.String({ description: "Deviations from the original plan" })),
    }),
    execute: milestoneCompleteExecute,
  };

  pi.registerTool(milestoneCompleteTool);
  registerAlias(pi, milestoneCompleteTool, "gsd_milestone_complete", "gsd_complete_milestone");

  // ─── gsd_validate_milestone (gsd_milestone_validate alias) ─────────────

  const milestoneValidateExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot validate milestone." }],
        details: { operation: "validate_milestone", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handleValidateMilestone } = await import("../tools/validate-milestone.js");
      const result = await handleValidateMilestone(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error validating milestone: ${result.error}` }],
          details: { operation: "validate_milestone", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Validated milestone ${result.milestoneId} — verdict: ${result.verdict}. Written to ${result.validationPath}` }],
        details: {
          operation: "validate_milestone",
          milestoneId: result.milestoneId,
          verdict: result.verdict,
          validationPath: result.validationPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `validate_milestone tool failed: ${msg}`, { tool: "gsd_validate_milestone", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error validating milestone: ${msg}` }],
        details: { operation: "validate_milestone", error: msg } as any,
      };
    }
  };

  const milestoneValidateTool = {
    name: "gsd_validate_milestone",
    label: "Validate Milestone",
    description:
      "Validate a milestone before completion — persist validation results to the DB, render VALIDATION.md to disk. " +
      "Records verdict (pass/needs-attention/needs-remediation) and rationale.",
    promptSnippet: "Validate a GSD milestone (DB write + VALIDATION.md render)",
    promptGuidelines: [
      "Use gsd_validate_milestone when all slices are done and the milestone needs validation before completion.",
      "Parameters: milestoneId, verdict, remediationRound, successCriteriaChecklist, sliceDeliveryAudit, crossSliceIntegration, requirementCoverage, verificationClasses (optional), verdictRationale, remediationPlan (optional).",
      "If verdict is 'needs-remediation', also provide remediationPlan and use gsd_reassess_roadmap to add remediation slices to the roadmap.",
      "On success, returns validationPath where VALIDATION.md was written.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      verdict: StringEnum(["pass", "needs-attention", "needs-remediation"], { description: "Validation verdict" }),
      remediationRound: Type.Number({ description: "Remediation round (0 for first validation)" }),
      successCriteriaChecklist: Type.String({ description: "Markdown checklist of success criteria with pass/fail and evidence" }),
      sliceDeliveryAudit: Type.String({ description: "Markdown table auditing each slice's claimed vs delivered output" }),
      crossSliceIntegration: Type.String({ description: "Markdown describing any cross-slice boundary mismatches" }),
      requirementCoverage: Type.String({ description: "Markdown describing any unaddressed requirements" }),
      verificationClasses: Type.Optional(Type.String({ description: "Markdown describing verification class compliance and gaps" })),
      verdictRationale: Type.String({ description: "Why this verdict was chosen" }),
      remediationPlan: Type.Optional(Type.String({ description: "Remediation plan (required if verdict is needs-remediation)" })),
    }),
    execute: milestoneValidateExecute,
  };

  pi.registerTool(milestoneValidateTool);
  registerAlias(pi, milestoneValidateTool, "gsd_milestone_validate", "gsd_validate_milestone");

  // ─── gsd_replan_slice (gsd_slice_replan alias) ─────────────────────────

  const replanSliceExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot replan slice." }],
        details: { operation: "replan_slice", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handleReplanSlice } = await import("../tools/replan-slice.js");
      const result = await handleReplanSlice(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error replanning slice: ${result.error}` }],
          details: { operation: "replan_slice", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Replanned slice ${result.sliceId} (${result.milestoneId})` }],
        details: {
          operation: "replan_slice",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          replanPath: result.replanPath,
          planPath: result.planPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `replan_slice tool failed: ${msg}`, { tool: "gsd_replan_slice", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error replanning slice: ${msg}` }],
        details: { operation: "replan_slice", error: msg } as any,
      };
    }
  };

  const replanSliceTool = {
    name: "gsd_replan_slice",
    label: "Replan Slice",
    description:
      "Replan a slice after a blocker is discovered. Structurally enforces preservation of completed tasks — " +
      "mutations to completed task IDs are rejected with actionable error payloads. Writes replan history to DB, " +
      "applies task mutations, re-renders PLAN.md, and renders REPLAN.md.",
    promptSnippet: "Replan a GSD slice with structural enforcement of completed tasks",
    promptGuidelines: [
      "Use gsd_replan_slice (canonical) or gsd_slice_replan (alias) when a blocker is discovered and the slice plan needs rewriting.",
      "The tool structurally enforces that completed tasks cannot be updated or removed — violations return specific error payloads naming the blocked task ID.",
      "Parameters: milestoneId, sliceId, blockerTaskId, blockerDescription, whatChanged, updatedTasks (array), removedTaskIds (array).",
      "updatedTasks items: taskId, title, description, estimate, files, verify, inputs, expectedOutput.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      blockerTaskId: Type.String({ description: "Task ID that discovered the blocker" }),
      blockerDescription: Type.String({ description: "Description of the blocker" }),
      whatChanged: Type.String({ description: "Summary of what changed in the plan" }),
      updatedTasks: Type.Array(
        Type.Object({
          taskId: Type.String({ description: "Task ID (e.g. T01)" }),
          title: Type.String({ description: "Task title" }),
          description: Type.String({ description: "Task description / steps block" }),
          estimate: Type.String({ description: "Task estimate string" }),
          files: Type.Array(Type.String(), { description: "Files likely touched" }),
          verify: Type.String({ description: "Verification command or block" }),
          inputs: Type.Array(Type.String(), { description: "Input files or references" }),
          expectedOutput: Type.Array(Type.String(), { description: "Expected output files or artifacts" }),
        }),
        { description: "Tasks to upsert (update existing or insert new)" },
      ),
      removedTaskIds: Type.Array(Type.String(), { description: "Task IDs to remove from the slice" }),
    }),
    execute: replanSliceExecute,
  };

  pi.registerTool(replanSliceTool);
  registerAlias(pi, replanSliceTool, "gsd_slice_replan", "gsd_replan_slice");

  // ─── gsd_reassess_roadmap (gsd_roadmap_reassess alias) ─────────────────

  const reassessRoadmapExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot reassess roadmap." }],
        details: { operation: "reassess_roadmap", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handleReassessRoadmap } = await import("../tools/reassess-roadmap.js");
      const result = await handleReassessRoadmap(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error reassessing roadmap: ${result.error}` }],
          details: { operation: "reassess_roadmap", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Reassessed roadmap for milestone ${result.milestoneId} after ${result.completedSliceId}` }],
        details: {
          operation: "reassess_roadmap",
          milestoneId: result.milestoneId,
          completedSliceId: result.completedSliceId,
          assessmentPath: result.assessmentPath,
          roadmapPath: result.roadmapPath,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `reassess_roadmap tool failed: ${msg}`, { tool: "gsd_reassess_roadmap", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error reassessing roadmap: ${msg}` }],
        details: { operation: "reassess_roadmap", error: msg } as any,
      };
    }
  };

  const reassessRoadmapTool = {
    name: "gsd_reassess_roadmap",
    label: "Reassess Roadmap",
    description:
      "Reassess the milestone roadmap after a slice completes. Structurally enforces preservation of completed slices — " +
      "mutations to completed slice IDs are rejected with actionable error payloads. Writes assessment to DB, " +
      "applies slice mutations, re-renders ROADMAP.md, and renders ASSESSMENT.md.",
    promptSnippet: "Reassess a GSD roadmap with structural enforcement of completed slices",
    promptGuidelines: [
      "Use gsd_reassess_roadmap (canonical) or gsd_roadmap_reassess (alias) after a slice completes to reassess the roadmap.",
      "The tool structurally enforces that completed slices cannot be modified or removed — violations return specific error payloads naming the blocked slice ID.",
      "Parameters: milestoneId, completedSliceId, verdict, assessment, sliceChanges (object with modified, added, removed arrays).",
      "sliceChanges.modified items: sliceId, title, risk (optional), depends (optional), demo (optional).",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      completedSliceId: Type.String({ description: "Slice ID that just completed" }),
      verdict: Type.String({ description: "Assessment verdict (e.g. 'roadmap-confirmed', 'roadmap-adjusted')" }),
      assessment: Type.String({ description: "Assessment text explaining the decision" }),
      sliceChanges: Type.Object({
        modified: Type.Array(
          Type.Object({
            sliceId: Type.String({ description: "Slice ID to modify" }),
            title: Type.String({ description: "Updated slice title" }),
            risk: Type.Optional(Type.String({ description: "Updated risk level" })),
            depends: Type.Optional(Type.Array(Type.String(), { description: "Updated dependencies" })),
            demo: Type.Optional(Type.String({ description: "Updated demo text" })),
          }),
          { description: "Slices to modify" },
        ),
        added: Type.Array(
          Type.Object({
            sliceId: Type.String({ description: "New slice ID" }),
            title: Type.String({ description: "New slice title" }),
            risk: Type.Optional(Type.String({ description: "Risk level" })),
            depends: Type.Optional(Type.Array(Type.String(), { description: "Dependencies" })),
            demo: Type.Optional(Type.String({ description: "Demo text" })),
          }),
          { description: "New slices to add" },
        ),
        removed: Type.Array(Type.String(), { description: "Slice IDs to remove" }),
      }, { description: "Slice changes to apply" }),
    }),
    execute: reassessRoadmapExecute,
  };

  pi.registerTool(reassessRoadmapTool);
  registerAlias(pi, reassessRoadmapTool, "gsd_roadmap_reassess", "gsd_reassess_roadmap");

  // ─── gsd_save_gate_result ──────────────────────────────────────────────

  const saveGateResultExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available." }],
        details: { operation: "save_gate_result", error: "db_unavailable" } as any,
      };
    }
    const validGates = ["Q3", "Q4", "Q5", "Q6", "Q7", "Q8"];
    if (!validGates.includes(params.gateId)) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid gateId "${params.gateId}". Must be one of: ${validGates.join(", ")}` }],
        details: { operation: "save_gate_result", error: "invalid_gate_id" } as any,
      };
    }
    const validVerdicts = ["pass", "flag", "omitted"];
    if (!validVerdicts.includes(params.verdict)) {
      return {
        content: [{ type: "text" as const, text: `Error: Invalid verdict "${params.verdict}". Must be one of: ${validVerdicts.join(", ")}` }],
        details: { operation: "save_gate_result", error: "invalid_verdict" } as any,
      };
    }
    try {
      const { saveGateResult } = await import("../gsd-db.js");
      const { invalidateStateCache } = await import("../state.js");
      saveGateResult({
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        gateId: params.gateId,
        taskId: params.taskId ?? "",
        verdict: params.verdict,
        rationale: params.rationale,
        findings: params.findings ?? "",
      });
      invalidateStateCache();
      return {
        content: [{ type: "text" as const, text: `Gate ${params.gateId} result saved: verdict=${params.verdict}` }],
        details: { operation: "save_gate_result", gateId: params.gateId, verdict: params.verdict } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `gsd_save_gate_result failed: ${msg}`, { tool: "gsd_save_gate_result", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error saving gate result: ${msg}` }],
        details: { operation: "save_gate_result", error: msg } as any,
      };
    }
  };

  const saveGateResultTool = {
    name: "gsd_save_gate_result",
    label: "Save Gate Result",
    description:
      "Save the result of a quality gate evaluation (Q3-Q8) to the GSD database. " +
      "Called by gate evaluation sub-agents after analyzing a specific quality question.",
    promptSnippet: "Save quality gate evaluation result (verdict, rationale, findings)",
    promptGuidelines: [
      "Use gsd_save_gate_result after evaluating a quality gate question.",
      "gateId must be one of: Q3, Q4, Q5, Q6, Q7, Q8.",
      "verdict must be: pass (no concerns), flag (concerns found), or omitted (not applicable).",
      "rationale should be a one-sentence justification for the verdict.",
      "findings should contain detailed markdown analysis (or empty string if omitted).",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      gateId: Type.String({ description: "Gate ID: Q3, Q4, Q5, Q6, Q7, or Q8" }),
      taskId: Type.Optional(Type.String({ description: "Task ID for task-scoped gates (Q5/Q6/Q7)" })),
      verdict: Type.String({ description: "pass, flag, or omitted" }),
      rationale: Type.String({ description: "One-sentence justification" }),
      findings: Type.Optional(Type.String({ description: "Detailed markdown findings" })),
    }),
    execute: saveGateResultExecute,
    renderCall(args: any, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("save_gate_result "));
      text += theme.fg("accent", args.gateId ?? "");
      text += theme.fg("dim", ` → ${args.verdict ?? ""}`);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const d = result.details;
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      const color = d?.verdict === "flag" ? "warning" : "success";
      return new Text(theme.fg(color, `${d?.gateId}: ${d?.verdict}`), 0, 0);
    },
  };

  pi.registerTool(saveGateResultTool);
}
