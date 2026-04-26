import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { Text } from "@gsd/pi-tui";

import { loadEffectiveGSDPreferences } from "../preferences.js";
import { ensureDbOpen } from "./dynamic-tools.js";
import { StringEnum } from "@gsd/pi-ai";
import { logError } from "../workflow-logger.js";
import { getErrorMessage } from "../error-utils.js";

async function loadWorkflowExecutors(): Promise<typeof import("../tools/workflow-tool-executors.js")> {
  return import("../tools/workflow-tool-executors.js");
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

/**
 * Read a tool result's structured payload, accommodating MCP's `details` →
 * `structuredContent` rename (#4472, #4477). In-process executions still
 * deliver the payload on `result.details`; MCP-routed executions deliver it
 * on `result.structuredContent` (post `adaptExecutorResult` transform). All
 * `renderResult` callbacks in this file route through this helper so a future
 * field rename only needs to be applied in one place.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- result shape varies by tool
function readDetails(result: any): any {
  return result?.details ?? result?.structuredContent;
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
      const d = readDetails(result);
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
      const d = readDetails(result);
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
      const d = readDetails(result);
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
    const { executeSummarySave } = await loadWorkflowExecutors();
    return executeSummarySave(params, process.cwd());
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
      const d = readDetails(result);
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
      const { claimReservedId, findMilestoneIds, getReservedMilestoneIds, nextMilestoneId } = await import("../guided-flow.js");
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
      const d = readDetails(result);
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
    const { executePlanMilestone } = await loadWorkflowExecutors();
    return executePlanMilestone(params, process.cwd());
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
        // ADR-011: heavy planning fields are optional for sketch slices; required for full slices.
        successCriteria: Type.Optional(Type.String({ description: "Slice success criteria block (required for full slices; omit for sketches)" })),
        proofLevel: Type.Optional(Type.String({ description: "Slice proof level (required for full slices; omit for sketches)" })),
        integrationClosure: Type.Optional(Type.String({ description: "Slice integration closure (required for full slices; omit for sketches)" })),
        observabilityImpact: Type.Optional(Type.String({ description: "Slice observability impact (required for full slices; omit for sketches)" })),
        // ADR-011 sketch-then-refine fields.
        isSketch: Type.Optional(Type.Boolean({ description: "ADR-011: true marks this slice as a sketch awaiting refine-slice expansion" })),
        sketchScope: Type.Optional(Type.String({ description: "ADR-011: 2–3 sentence scope boundary, required when isSketch=true" })),
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'plan-phase complete')" })),
    }),
    execute: planMilestoneExecute,
  };

  pi.registerTool(planMilestoneTool);
  registerAlias(pi, planMilestoneTool, "gsd_milestone_plan", "gsd_plan_milestone");

  // ─── gsd_plan_slice (gsd_slice_plan alias) ─────────────────────────────

  const planSliceExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const { executePlanSlice } = await loadWorkflowExecutors();
    return executePlanSlice(params, process.cwd());
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'plan-phase complete')" })),
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'plan-phase complete')" })),
    }),
    execute: planTaskExecute,
  };

  pi.registerTool(planTaskTool);
  registerAlias(pi, planTaskTool, "gsd_task_plan", "gsd_plan_task");

  // ─── gsd_task_complete (gsd_complete_task alias) ────────────────────────

  const taskCompleteExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const { executeTaskComplete } = await loadWorkflowExecutors();
    return executeTaskComplete(params, process.cwd());
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
      // ADR-011 Phase 2: mid-execution escalation — agent asks the user to resolve an ambiguity.
      escalation: Type.Optional(Type.Object({
        question: Type.String({ description: "The question the user needs to answer — one clear sentence." }),
        options: Type.Array(Type.Object({
          id: Type.String({ description: "Short id (e.g. 'A', 'B') used by /gsd escalate resolve." }),
          label: Type.String({ description: "One-line label." }),
          tradeoffs: Type.String({ description: "1-2 sentences on the tradeoffs of this option." }),
        }), { minItems: 2, maxItems: 4, description: "2–4 options the user can choose between." }),
        recommendation: Type.String({ description: "Option id the executor recommends." }),
        recommendationRationale: Type.String({ description: "Why the recommendation — 1–2 sentences." }),
        continueWithDefault: Type.Boolean({
          description: "When true, loop continues (artifact logged for later review). When false, auto-mode pauses until the user resolves via /gsd escalate resolve.",
        }),
      }, { description: "ADR-011 Phase 2: optional escalation payload. Only honored when phases.mid_execution_escalation is true." })),
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'task verified after retry')" })),
    }),
    execute: taskCompleteExecute,
  };

  pi.registerTool(taskCompleteTool);
  registerAlias(pi, taskCompleteTool, "gsd_complete_task", "gsd_task_complete");

  // ─── gsd_slice_complete (gsd_complete_slice alias) ─────────────────────

  const sliceCompleteExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const { executeSliceComplete } = await loadWorkflowExecutors();
    return executeSliceComplete(params, process.cwd());
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'all tasks verified')" })),
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
      const { handleSkipSlice } = await import("../tools/skip-slice.js");
      const { invalidateStateCache } = await import("../state.js");

      const result = handleSkipSlice({
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        reason: params.reason,
      });

      if (result.error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          details: {
            operation: "skip_slice",
            error: result.error,
            errorCode: result.errorCode ?? "skip_failed",
          } as any,
        };
      }

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

      const suffix = result.wasAlreadySkipped
        ? result.tasksSkipped > 0
          ? ` (already skipped; cascaded ${result.tasksSkipped} leftover task(s) to skipped).`
          : " (already skipped; no pending tasks to cascade)."
        : ` Cascaded ${result.tasksSkipped} task(s) to skipped. Auto-mode will advance past this slice.`;

      return {
        content: [{ type: "text" as const, text: `Skipped slice ${params.sliceId} (${params.milestoneId}). Reason: ${params.reason ?? "User-directed skip"}.${suffix}` }],
        details: {
          operation: "skip_slice",
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          reason: params.reason,
          tasksSkipped: result.tasksSkipped,
          wasAlreadySkipped: result.wasAlreadySkipped,
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
      "Non-closed tasks within the slice are cascaded to skipped so milestone completion is not blocked by leftover pending tasks (#4375). " +
      "The slice data is preserved for reference. The state machine treats skipped slices like completed ones for dependency satisfaction.",
    promptSnippet: "Skip a GSD slice (mark as skipped, auto-mode will advance past it)",
    promptGuidelines: [
      "Use gsd_skip_slice when a slice should be bypassed — descoped, superseded, or no longer relevant.",
      "Cannot skip a slice that is already complete.",
      "Skipped slices satisfy downstream dependencies just like completed slices.",
      "All pending/active tasks in the slice are cascaded to skipped; completed tasks are never downgraded.",
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
    const { executeCompleteMilestone } = await loadWorkflowExecutors();
    return executeCompleteMilestone(params, process.cwd());
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'milestone validation passed')" })),
    }),
    execute: milestoneCompleteExecute,
  };

  pi.registerTool(milestoneCompleteTool);
  registerAlias(pi, milestoneCompleteTool, "gsd_milestone_complete", "gsd_complete_milestone");

  // ─── gsd_validate_milestone (gsd_milestone_validate alias) ─────────────

  const milestoneValidateExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const { executeValidateMilestone } = await loadWorkflowExecutors();
    return executeValidateMilestone(params, process.cwd());
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
    const { executeReplanSlice } = await loadWorkflowExecutors();
    return executeReplanSlice(params, process.cwd());
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'blocker discovered during execution')" })),
    }),
    execute: replanSliceExecute,
  };

  pi.registerTool(replanSliceTool);
  registerAlias(pi, replanSliceTool, "gsd_slice_replan", "gsd_replan_slice");

  // ─── gsd_reassess_roadmap (gsd_roadmap_reassess alias) ─────────────────

  const reassessRoadmapExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const { executeReassessRoadmap } = await loadWorkflowExecutors();
    return executeReassessRoadmap(params, process.cwd());
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
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'slice S01 completed, reassessing remaining roadmap')" })),
    }),
    execute: reassessRoadmapExecute,
  };

  pi.registerTool(reassessRoadmapTool);
  registerAlias(pi, reassessRoadmapTool, "gsd_roadmap_reassess", "gsd_reassess_roadmap");

  // ─── gsd_task_reopen (gsd_reopen_task alias) ───────────────────────────
  // Single-writer v3, Stream 3: reversibility tools for closed units.

  const reopenTaskExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot reopen task." }],
        details: { operation: "reopen_task", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handleReopenTask } = await import("../tools/reopen-task.js");
      const result = await handleReopenTask(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error reopening task: ${result.error}` }],
          details: { operation: "reopen_task", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Reopened task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
        details: {
          operation: "reopen_task",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          taskId: result.taskId,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `reopen_task tool failed: ${msg}`, { tool: "gsd_task_reopen", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error reopening task: ${msg}` }],
        details: { operation: "reopen_task", error: msg } as any,
      };
    }
  };

  const reopenTaskTool = {
    name: "gsd_task_reopen",
    label: "Reopen Task",
    description:
      "Reset a completed task back to 'pending' so it can be re-done. Cleans up SUMMARY.md so the DB-filesystem reconciler does not auto-correct the task back to complete. " +
      "Both the parent slice and milestone must still be open — use gsd_slice_reopen first if the slice has been closed.",
    promptSnippet: "Reopen a completed GSD task (resets status to pending, removes SUMMARY.md)",
    promptGuidelines: [
      "Use gsd_task_reopen when a completed task needs to be re-done (e.g. verification missed a regression, requirements changed).",
      "Will fail if the parent slice or milestone is already closed — reopen those first.",
      "Will fail if the task is not currently 'complete' — there is nothing to reopen.",
      "Use the canonical name gsd_task_reopen; gsd_reopen_task is only an alias.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      taskId: Type.String({ description: "Task ID (e.g. T01)" }),
      reason: Type.Optional(Type.String({ description: "Why the task is being reopened (recorded in the audit trail)" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'regression discovered post-completion')" })),
    }),
    execute: reopenTaskExecute,
  };

  pi.registerTool(reopenTaskTool);
  registerAlias(pi, reopenTaskTool, "gsd_reopen_task", "gsd_task_reopen");

  // ─── gsd_slice_reopen (gsd_reopen_slice alias) ─────────────────────────

  const reopenSliceExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot reopen slice." }],
        details: { operation: "reopen_slice", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handleReopenSlice } = await import("../tools/reopen-slice.js");
      const result = await handleReopenSlice(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error reopening slice: ${result.error}` }],
          details: { operation: "reopen_slice", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Reopened slice ${result.sliceId} (${result.milestoneId}); reset ${result.tasksReset} task(s) to pending.` }],
        details: {
          operation: "reopen_slice",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          tasksReset: result.tasksReset,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `reopen_slice tool failed: ${msg}`, { tool: "gsd_slice_reopen", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error reopening slice: ${msg}` }],
        details: { operation: "reopen_slice", error: msg } as any,
      };
    }
  };

  const reopenSliceTool = {
    name: "gsd_slice_reopen",
    label: "Reopen Slice",
    description:
      "Reset a completed slice back to 'in_progress' and reset ALL of its tasks back to 'pending'. Cleans up SUMMARY.md / UAT.md and per-task summaries. " +
      "Reopening a slice means re-doing the work — partial resets create ambiguous state, so all tasks are reset.",
    promptSnippet: "Reopen a completed GSD slice (resets all tasks to pending, removes summaries)",
    promptGuidelines: [
      "Use gsd_slice_reopen when a completed slice needs to be re-done (e.g. integration issue surfaced, requirements changed).",
      "All tasks within the slice are reset to 'pending' — there is no partial-reopen.",
      "Will fail if the parent milestone is already closed — reopen the milestone first.",
      "Will fail if the slice is not currently 'complete' — there is nothing to reopen.",
      "Use the canonical name gsd_slice_reopen; gsd_reopen_slice is only an alias.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      reason: Type.Optional(Type.String({ description: "Why the slice is being reopened (recorded in the audit trail)" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'cross-slice regression discovered')" })),
    }),
    execute: reopenSliceExecute,
  };

  pi.registerTool(reopenSliceTool);
  registerAlias(pi, reopenSliceTool, "gsd_reopen_slice", "gsd_slice_reopen");

  // ─── gsd_milestone_reopen (gsd_reopen_milestone alias) ─────────────────

  const reopenMilestoneExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const dbAvailable = await ensureDbOpen();
    if (!dbAvailable) {
      return {
        content: [{ type: "text" as const, text: "Error: GSD database is not available. Cannot reopen milestone." }],
        details: { operation: "reopen_milestone", error: "db_unavailable" } as any,
      };
    }
    try {
      const { handleReopenMilestone } = await import("../tools/reopen-milestone.js");
      const result = await handleReopenMilestone(params, process.cwd());
      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `Error reopening milestone: ${result.error}` }],
          details: { operation: "reopen_milestone", error: result.error } as any,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Reopened milestone ${result.milestoneId}; reset ${result.slicesReset} slice(s) and ${result.tasksReset} task(s).` }],
        details: {
          operation: "reopen_milestone",
          milestoneId: result.milestoneId,
          slicesReset: result.slicesReset,
          tasksReset: result.tasksReset,
        } as any,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `reopen_milestone tool failed: ${msg}`, { tool: "gsd_milestone_reopen", error: String(err) });
      return {
        content: [{ type: "text" as const, text: `Error reopening milestone: ${msg}` }],
        details: { operation: "reopen_milestone", error: msg } as any,
      };
    }
  };

  const reopenMilestoneTool = {
    name: "gsd_milestone_reopen",
    label: "Reopen Milestone",
    description:
      "Reset a closed milestone back to 'active', all of its slices to 'in_progress', and all tasks to 'pending'. " +
      "Cleans up MILESTONE-SUMMARY.md, slice summaries, and task summaries so the DB-filesystem reconciler does not auto-correct status back to complete.",
    promptSnippet: "Reopen a closed GSD milestone (resets slices and tasks, removes summaries)",
    promptGuidelines: [
      "Use gsd_milestone_reopen when a closed milestone needs to be re-done (e.g. validation failure surfaced after closure).",
      "All slices reset to 'in_progress' and all tasks reset to 'pending' — no partial reopen.",
      "Will fail if the milestone is not currently closed — there is nothing to reopen.",
      "Use the canonical name gsd_milestone_reopen; gsd_reopen_milestone is only an alias.",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      reason: Type.Optional(Type.String({ description: "Why the milestone is being reopened (recorded in the audit trail)" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'post-closure validation failure')" })),
    }),
    execute: reopenMilestoneExecute,
  };

  pi.registerTool(reopenMilestoneTool);
  registerAlias(pi, reopenMilestoneTool, "gsd_reopen_milestone", "gsd_milestone_reopen");

  // ─── gsd_save_gate_result ──────────────────────────────────────────────

  const saveGateResultExecute = async (_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: unknown) => {
    const { executeSaveGateResult } = await loadWorkflowExecutors();
    return executeSaveGateResult(params, process.cwd());
  };

  const saveGateResultTool = {
    name: "gsd_save_gate_result",
    label: "Save Gate Result",
    description:
      "Save the result of a quality gate evaluation (Q3-Q8 or MV01-MV04) to the GSD database. " +
      "Called by gate evaluation sub-agents after analyzing a specific quality question.",
    promptSnippet: "Save quality gate evaluation result (verdict, rationale, findings)",
    promptGuidelines: [
      "Use gsd_save_gate_result after evaluating a quality gate question.",
      "gateId must be one of: Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, MV04.",
      "verdict must be: pass (no concerns), flag (concerns found), or omitted (not applicable).",
      "rationale should be a one-sentence justification for the verdict.",
      "findings should contain detailed markdown analysis (or empty string if omitted).",
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      gateId: Type.String({ description: "Gate ID: Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, or MV04" }),
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
    /**
     * Render the save_gate_result tool output for the TUI.
     *
     * Prefers structured fields, but falls back to `content[0].text` when the
     * structured payload is empty. Defensive: the structural fix on this
     * branch plumbs `details` through MCP via `structuredContent`, but older
     * hosts, a future handler that forgets `structuredContent`, or any drop
     * of non-standard return fields would otherwise render as
     * "undefined: undefined". Same fallback applies to error rendering, and
     * we strip a leading `Error:` from the fallback text to avoid producing
     * `Error: Error: ...`.
     */
    renderResult(result: any, _options: any, theme: any) {
      const d = readDetails(result);
      if (result.isError || d?.error) {
        const rawMsg = d?.error ?? result.content?.[0]?.text ?? "unknown";
        const msg = rawMsg.replace(/^\s*Error:\s*/i, "");
        return new Text(theme.fg("error", `Error: ${msg}`), 0, 0);
      }
      if (!d?.gateId || !d?.verdict) {
        const text = result.content?.[0]?.text ?? "Gate result saved";
        return new Text(theme.fg("success", text), 0, 0);
      }
      const color = d.verdict === "flag" ? "warning" : "success";
      return new Text(theme.fg(color, `${d.gateId}: ${d.verdict}`), 0, 0);
    },
  };

  pi.registerTool(saveGateResultTool);
}
