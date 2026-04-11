/**
 * GSD Guided Flow — Smart Entry Wizard
 *
 * One function: showSmartEntry(). Reads state from disk, shows a contextual
 * wizard via showNextAction(), and dispatches through GSD-WORKFLOW.md.
 * No execution state, no hooks, no tools — the LLM does the rest.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { showNextAction } from "../shared/tui.js";
import { loadFile, saveFile } from "./files.js";
import { isDbAvailable, getMilestoneSlices } from "./gsd-db.js";
import { parseRoadmapSlices } from "./roadmap-slices.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import { buildSkillActivationBlock } from "./auto-prompts.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { startAuto } from "./auto.js";
import { clearLock } from "./crash-recovery.js";
import {
  assessInterruptedSession,
  formatInterruptedSessionRunningMessage,
  formatInterruptedSessionSummary,
} from "./interrupted-session.js";
import { listUnitRuntimeRecords, clearUnitRuntimeRecord } from "./unit-runtime.js";
import { resolveExpectedArtifactPath } from "./auto.js";
import {
  gsdRoot, milestonesDir, resolveMilestoneFile, resolveMilestonePath,
  resolveSliceFile, resolveSlicePath, resolveGsdRootFile, relGsdRootFile,
  relMilestoneFile, relSliceFile,
} from "./paths.js";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { readSessionLockData, isSessionLockProcessAlive } from "./session-lock.js";
import { nativeIsRepo, nativeInit } from "./native-git-bridge.js";
import { isInheritedRepo } from "./repo-identity.js";
import { ensureGitignore, ensurePreferences, untrackRuntimeFiles } from "./gitignore.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { detectProjectState } from "./detection.js";
import { showProjectInit, offerMigration } from "./init-wizard.js";
import { validateDirectory } from "./validate-directory.js";
import { showConfirm } from "../shared/tui.js";
import { debugLog } from "./debug-logger.js";
import { findMilestoneIds, nextMilestoneId, reserveMilestoneId, getReservedMilestoneIds, clearReservedMilestoneIds } from "./milestone-ids.js";
import { parkMilestone, discardMilestone } from "./milestone-actions.js";
import { selectAndApplyModel } from "./auto-model-selection.js";
import { DISCUSS_TOOLS_ALLOWLIST } from "./constants.js";
import {
  getWorkflowTransportSupportError,
  getRequiredWorkflowToolsForGuidedUnit,
  supportsStructuredQuestions,
} from "./workflow-mcp.js";
import {
  runPreparation,
  formatCodebaseBrief,
  formatPriorContextBrief,
} from "./preparation.js";

// ─── Re-exports (preserve public API for existing importers) ────────────────
export {
  MILESTONE_ID_RE, generateMilestoneSuffix, nextMilestoneId,
  extractMilestoneSeq, parseMilestoneId, milestoneIdSort,
  maxMilestoneNum, findMilestoneIds,
  reserveMilestoneId, claimReservedId, getReservedMilestoneIds, clearReservedMilestoneIds,
} from "./milestone-ids.js";
export {
  showQueue, handleQueueReorder, showQueueAdd,
  buildExistingMilestonesContext,
} from "./guided-flow-queue.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning } from "./workflow-logger.js";

// ─── ID Generation with Reservation ─────────────────────────────────────────

/**
 * Generate the next milestone ID, accounting for reserved IDs, and reserve it.
 * Ensures any preview ID shown in the UI matches what `gsd_milestone_generate_id`
 * will later return.
 */
function nextMilestoneIdReserved(existingIds: string[], uniqueEnabled: boolean): string {
  const allIds = [...new Set([...existingIds, ...getReservedMilestoneIds()])];
  const id = nextMilestoneId(allIds, uniqueEnabled);
  reserveMilestoneId(id);
  return id;
}

// ─── Commit Instruction Helpers ──────────────────────────────────────────────

/** Build commit instruction for planning prompts. .gsd/ is managed externally and always gitignored. */
function buildDocsCommitInstruction(_message: string): string {
  return "Do not commit planning artifacts — .gsd/ is managed externally.";
}

// ─── Auto-start after discuss ─────────────────────────────────────────────────

/** Pending auto-start context, keyed by basePath for session isolation (#2985). */
interface PendingAutoStartEntry {
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
  basePath: string;
  milestoneId: string; // the milestone being discussed
  step?: boolean; // preserve step mode through discuss → auto transition
  createdAt: number; // timestamp for staleness detection (#3274)
}

const pendingAutoStartMap = new Map<string, PendingAutoStartEntry>();

/**
 * Backward-compat bridge: returns a mutable reference to the entry matching
 * basePath, or the sole entry when only one session exists.
 * Internal use only — external code should use the Map directly.
 */
function _getPendingAutoStart(basePath?: string): PendingAutoStartEntry | null {
  if (basePath) return pendingAutoStartMap.get(basePath) ?? null;
  if (pendingAutoStartMap.size === 1) return pendingAutoStartMap.values().next().value!;
  return null;
}

/**
 * Store pending auto-start state for a project.
 * Exported for testing (#2985).
 */
export function setPendingAutoStart(basePath: string, entry: { basePath: string; milestoneId: string; ctx?: ExtensionCommandContext; pi?: ExtensionAPI; step?: boolean; createdAt?: number }): void {
  pendingAutoStartMap.set(basePath, { createdAt: Date.now(), ...entry } as PendingAutoStartEntry);
}

/**
 * Clear pending auto-start state.
 * If basePath is given, clears only that project.  Otherwise clears all.
 * Exported for testing (#2985).
 */
export function clearPendingAutoStart(basePath?: string): void {
  if (basePath) {
    pendingAutoStartMap.delete(basePath);
  } else {
    pendingAutoStartMap.clear();
  }
}

/**
 * Returns the milestoneId being discussed for the given project.
 * When basePath is omitted and only one session is active, returns that
 * session's milestoneId for backward compatibility.  Returns null when
 * multiple sessions exist and basePath is not specified (#2985 Bug 4).
 */
export function getDiscussionMilestoneId(basePath?: string): string | null {
  if (basePath) {
    return pendingAutoStartMap.get(basePath)?.milestoneId ?? null;
  }
  // Backward compat: return the sole entry's milestoneId, or null if ambiguous
  if (pendingAutoStartMap.size === 1) {
    return pendingAutoStartMap.values().next().value!.milestoneId;
  }
  return null;
}

/** Called from agent_end to check if auto-mode should start after discuss */
export function checkAutoStartAfterDiscuss(): boolean {
  const entry = _getPendingAutoStart();
  if (!entry) return false;

  const { ctx, pi, basePath, milestoneId, step } = entry;

  // Gate 1: Primary milestone must have CONTEXT.md or ROADMAP.md
  // The "discuss" path creates CONTEXT.md; the "plan" path creates ROADMAP.md.
  const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
  const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (!contextFile && !roadmapFile) return false; // neither artifact yet — keep waiting

  // Gate 2: STATE.md must exist — written as the last step in the discuss
  // output phase. This prevents auto-start from firing during Phase 3
  // (sequential readiness gates for remaining milestones) in multi-milestone
  // discussions, where M001-CONTEXT.md exists but M002/M003 haven't been
  // processed yet.
  const stateFile = resolveGsdRootFile(basePath, "STATE");
  if (!stateFile) return false; // discussion not finalized yet

  // Gate 3: Multi-milestone completeness warning
  // Parse PROJECT.md for milestone sequence, warn if any are missing context.
  // Don't block — milestones can be intentionally queued without context.
  const projectFile = resolveGsdRootFile(basePath, "PROJECT");
  let projectIds: string[] = [];
  if (projectFile) {
    try {
      const projectContent = readFileSync(projectFile, "utf-8");
      projectIds = parseMilestoneSequenceFromProject(projectContent);
      if (projectIds.length > 1) {
        const missing = projectIds.filter(id => {
          const hasContext = !!resolveMilestoneFile(basePath, id, "CONTEXT");
          const hasDraft = !!resolveMilestoneFile(basePath, id, "CONTEXT-DRAFT");
          const hasDir = existsSync(join(gsdRoot(basePath), "milestones", id));
          return !hasContext && !hasDraft && !hasDir;
        });
        if (missing.length > 0) {
          ctx.ui.notify(
            `Multi-milestone validation: ${missing.join(", ")} not found in filesystem. ` +
            `Discussion may not have completed all readiness gates.`,
            "warning",
          );
        }
      }
    } catch (e) { logWarning("guided", `PROJECT.md parsing failed: ${(e as Error).message}`); }
  }

  // Gate 4: Discussion manifest process verification (multi-milestone only)
  // The LLM writes DISCUSSION-MANIFEST.json after each Phase 3 gate decision.
  // When it exists, validate it before auto-starting. Project history alone is
  // not a reliable signal for the current discussion mode.
  const manifestPath = join(gsdRoot(basePath), "DISCUSSION-MANIFEST.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const total = typeof manifest.total === "number" ? manifest.total : 0;
      const completed = typeof manifest.gates_completed === "number" ? manifest.gates_completed : 0;

      if (total > 1 && completed < total) {
        // Discussion not complete — block auto-start until all gates are done
        return false;
      }

      // Cross-check manifest milestones against PROJECT.md if available
      if (projectIds.length > 0) {
        const manifestIds = Object.keys(manifest.milestones ?? {});
        const untracked = projectIds.filter(id => !manifestIds.includes(id));
        if (untracked.length > 0) {
          ctx.ui.notify(
            `Discussion manifest missing gates for: ${untracked.join(", ")}`,
            "warning",
          );
        }
      }
    } catch (e) { logWarning("guided", `discussion manifest verification failed: ${(e as Error).message}`); }
  }

  // Draft promotion cleanup: if a CONTEXT-DRAFT.md exists alongside the new
  // CONTEXT.md, delete the draft — it's been consumed by the discussion.
  try {
    const draftFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT-DRAFT");
    if (draftFile) unlinkSync(draftFile);
  } catch (e) { logWarning("guided", `CONTEXT-DRAFT.md unlink failed: ${(e as Error).message}`); }

  // Cleanup: remove discussion manifest after auto-start (only needed during discussion)
  try { unlinkSync(manifestPath); } catch (e) { logWarning("guided", `manifest unlink failed: ${(e as Error).message}`); }

  pendingAutoStartMap.delete(basePath);
  ctx.ui.notify(`Milestone ${milestoneId} ready.`, "info");
  startAuto(ctx, pi, basePath, false, { step }).catch((err) => {
    ctx.ui.notify(`Auto-start failed: ${getErrorMessage(err)}`, "error");
    logWarning("guided", `auto start error: ${getErrorMessage(err)}`);
    debugLog("auto-start-failed", { error: getErrorMessage(err) });
  });
  return true;
}

/**
 * Extract milestone IDs from PROJECT.md milestone sequence table.
 * Looks for rows like "| M001 | Name | Status |" and extracts the ID column.
 */
function parseMilestoneSequenceFromProject(content: string): string[] {
  const ids: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\|\s*(M\d{3}[A-Z0-9-]*)\s*\|/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type UIContext = ExtensionContext;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read GSD-WORKFLOW.md and dispatch it to the LLM with a contextual note.
 * This is the only way the wizard triggers work — everything else is the LLM's job.
 *
 * When a unitType is provided, resolves the user's model preference for that
 * phase (e.g., models.planning → "plan-milestone", models.discuss → "discuss-milestone") and applies it before
 * dispatching. This ensures guided-flow dispatches respect the same
 * per-phase model preferences that auto-mode uses.
 */
async function dispatchWorkflow(
  pi: ExtensionAPI,
  note: string,
  customType = "gsd-run",
  ctx?: ExtensionContext,
  unitType?: string,
): Promise<void> {
  // Route through the dynamic routing pipeline (complexity classification,
  // tier downgrade, fallback chains) — same path as auto-mode dispatches (#2958).
  if (ctx && unitType) {
    const prefs = loadEffectiveGSDPreferences()?.preferences;
    const result = await selectAndApplyModel(
      ctx, pi, unitType, /* unitId */ "", /* basePath */ process.cwd(),
      prefs, /* verbose */ false, /* autoModeStartModel */ null,
      /* retryContext */ undefined, /* isAutoMode */ false,
    );
    if (result.appliedModel) {
      debugLog("guided-flow-model-applied", {
        unitType,
        model: `${result.appliedModel.provider}/${result.appliedModel.id}`,
        routing: result.routing,
      });
    }

    const compatibilityError = getWorkflowTransportSupportError(
      result.appliedModel?.provider ?? ctx.model?.provider,
      getRequiredWorkflowToolsForGuidedUnit(unitType),
      {
        projectRoot: process.cwd(),
        surface: "guided flow",
        unitType,
        authMode: result.appliedModel?.provider
          ? ctx.modelRegistry.getProviderAuthMode(result.appliedModel.provider)
          : ctx.model?.provider
            ? ctx.modelRegistry.getProviderAuthMode(ctx.model.provider)
            : undefined,
        baseUrl: result.appliedModel?.baseUrl ?? ctx.model?.baseUrl,
      },
    );
    if (compatibilityError) {
      ctx.ui.notify(compatibilityError, "error");
      return;
    }
  }

  // Scope tools for discuss flows (#2949).
  // Providers with grammar-based constrained decoding (xAI/Grok) return
  // "Grammar is too complex" when the combined tool schema is too large.
  // Discuss flows only need a small subset of GSD tools — strip the heavy
  // planning/execution/completion tools to keep the grammar within limits.
  let savedTools: string[] | null = null;
  if (unitType?.startsWith("discuss-")) {
    const currentTools = pi.getActiveTools();
    savedTools = currentTools;
    // Keep all non-GSD tools (builtins, other extensions) and only the
    // GSD tools on the discuss allowlist.
    const scopedTools = currentTools.filter(
      (t) => !t.startsWith("gsd_") || DISCUSS_TOOLS_ALLOWLIST.includes(t),
    );
    pi.setActiveTools(scopedTools);
    debugLog("discuss-tool-scoping", {
      unitType,
      before: currentTools.length,
      after: scopedTools.length,
      removed: currentTools.length - scopedTools.length,
    });
  }

  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(process.env.HOME ?? "~", ".gsd", "agent", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");

  pi.sendMessage(
    {
      customType,
      content: `Read the following GSD workflow protocol and execute exactly.\n\n${workflow}\n\n## Your Task\n\n${note}`,
      display: false,
    },
    { triggerTurn: true },
  );

  // Restore full tool set after the message is queued. The LLM turn has
  // already captured the scoped set — restoring prevents the narrowed
  // tools from leaking into subsequent dispatches (#3628).
  if (savedTools) {
    pi.setActiveTools(savedTools);
  }
}

function getStructuredQuestionsAvailability(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
): "true" | "false" {
  if (!ctx) return "false";

  const provider = ctx.model?.provider;
  const authMode = provider ? ctx.modelRegistry.getProviderAuthMode(provider) : undefined;
  return supportsStructuredQuestions(pi.getActiveTools(), {
    authMode,
    baseUrl: ctx.model?.baseUrl,
  }) ? "true" : "false";
}

/**
 * Resolve a model ID string to a model object from available models.
 * Handles "provider/model" and bare ID formats.
 */
function resolveAvailableModel<T extends { id: string; provider: string }>(
  modelId: string,
  availableModels: T[],
  currentProvider: string | undefined,
): T | undefined {
  const slashIdx = modelId.indexOf("/");

  if (slashIdx !== -1) {
    const maybeProvider = modelId.substring(0, slashIdx);
    const id = modelId.substring(slashIdx + 1);

    const knownProviders = new Set(availableModels.map(m => m.provider.toLowerCase()));
    if (knownProviders.has(maybeProvider.toLowerCase())) {
      const match = availableModels.find(
        m => m.provider.toLowerCase() === maybeProvider.toLowerCase()
          && m.id.toLowerCase() === id.toLowerCase(),
      );
      if (match) return match;
    }

    // Try matching the full string as a model ID (OpenRouter-style)
    const lower = modelId.toLowerCase();
    return availableModels.find(
      m => m.id.toLowerCase() === lower
        || `${m.provider}/${m.id}`.toLowerCase() === lower,
    );
  }

  // Bare ID — prefer current provider, then first available
  const exactProviderMatch = availableModels.find(
    m => m.id === modelId && m.provider === currentProvider,
  );
  return exactProviderMatch ?? availableModels.find(m => m.id === modelId);
}

/**
 * Build the discuss-and-plan prompt for a new milestone.
 * Used by all three "new milestone" paths (first ever, no active, all complete).
 */
function buildDiscussPrompt(nextId: string, preamble: string, _basePath: string, pi: ExtensionAPI, ctx: ExtensionCommandContext, preparationContext?: string): string {
  const milestoneRel = `.gsd/milestones/${nextId}`;
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  const inlinedTemplates = [
    inlineTemplate("project", "Project"),
    inlineTemplate("requirements", "Requirements"),
    inlineTemplate("context", "Context"),
    inlineTemplate("roadmap", "Roadmap"),
    inlineTemplate("decisions", "Decisions"),
  ].join("\n\n---\n\n");
  return loadPrompt("discuss", {
    milestoneId: nextId,
    preamble,
    preparationContext: preparationContext ?? "",
    structuredQuestionsAvailable,
    contextPath: `${milestoneRel}/${nextId}-CONTEXT.md`,
    roadmapPath: `${milestoneRel}/${nextId}-ROADMAP.md`,
    inlinedTemplates,
    commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): context, requirements, and roadmap`),
    multiMilestoneCommitInstruction: buildDocsCommitInstruction("docs: project plan — N milestones"),
  });
}

/**
 * Build the discuss prompt for headless milestone creation.
 * Uses the discuss-headless prompt template with seed context injected.
 */
function buildHeadlessDiscussPrompt(nextId: string, seedContext: string, _basePath: string): string {
  const milestoneRel = `.gsd/milestones/${nextId}`;
  const inlinedTemplates = [
    inlineTemplate("project", "Project"),
    inlineTemplate("requirements", "Requirements"),
    inlineTemplate("context", "Context"),
    inlineTemplate("roadmap", "Roadmap"),
    inlineTemplate("decisions", "Decisions"),
  ].join("\n\n---\n\n");
  return loadPrompt("discuss-headless", {
    milestoneId: nextId,
    seedContext,
    contextPath: `${milestoneRel}/${nextId}-CONTEXT.md`,
    roadmapPath: `${milestoneRel}/${nextId}-ROADMAP.md`,
    inlinedTemplates,
    commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): context, requirements, and roadmap`),
    multiMilestoneCommitInstruction: buildDocsCommitInstruction("docs: project plan — N milestones"),
  });
}

/**
 * Run preparation phase if enabled, then build the discuss prompt.
 * Preparation analyzes the codebase and prior context, injecting the results
 * as supplementary context into the standard discuss template. The discuss
 * template drives the conversation (asks "What's the vision?" first), while
 * the preparation briefs give the agent grounding in the existing codebase.
 *
 * @param ctx - Extension command context with UI for progress notifications
 * @param nextId - The milestone ID being discussed
 * @param preamble - Preamble text for the discuss prompt
 * @param basePath - Root directory of the project
 * @returns The discuss prompt string
 */
async function prepareAndBuildDiscussPrompt(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  nextId: string,
  preamble: string,
  basePath: string,
): Promise<string> {
  const prefs = loadEffectiveGSDPreferences()?.preferences ?? {};

  // Run preparation if enabled (default: true) — results are injected as
  // supplementary context into the standard discuss prompt, NOT as a
  // replacement template. The discuss prompt always leads with "What's the
  // vision?" so the user defines the scope, not the codebase analysis.
  let preparationContext = "";
  if (prefs.discuss_preparation !== false) {
    try {
      const prepResult = await runPreparation(basePath, ctx.ui, {
        discuss_preparation: prefs.discuss_preparation,
        discuss_web_research: prefs.discuss_web_research,
        discuss_depth: prefs.discuss_depth,
      });

      if (prepResult.enabled) {
        const codebaseBrief = prepResult.codebaseBrief || formatCodebaseBrief(prepResult.codebase);
        const priorContextBrief = prepResult.priorContextBrief || formatPriorContextBrief(prepResult.priorContext);
        const parts: string[] = [];
        if (codebaseBrief) parts.push(`### Codebase Brief\n\n${codebaseBrief}`);
        if (priorContextBrief) parts.push(`### Prior Context Brief\n\n${priorContextBrief}`);
        if (parts.length > 0) {
          preparationContext = `\n\n## Preparation Context\n\nThe system analyzed the codebase before this discussion. Use these findings as background context — they describe what already exists, NOT what the user wants to build. Always ask the user what they want to build first.\n\n${parts.join("\n\n")}`;
        }
      }
    } catch (err) {
      logWarning("guided", `preparation failed, proceeding without context: ${(err as Error).message}`);
    }
  }

  return buildDiscussPrompt(nextId, preamble, basePath, pi, ctx, preparationContext);
}

/**
 * Bootstrap a .gsd/ project from scratch for headless use.
 * Ensures git repo, .gsd/ structure, gitignore, and preferences all exist.
 */
function bootstrapGsdProject(basePath: string): void {
  if (!nativeIsRepo(basePath) || isInheritedRepo(basePath)) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(basePath, mainBranch);
  }

  const root = gsdRoot(basePath);
  mkdirSync(join(root, "milestones"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });

  ensureGitignore(basePath);
  ensurePreferences(basePath);
  untrackRuntimeFiles(basePath);
}

/**
 * Headless milestone creation from a seed specification document.
 * Bootstraps the project if needed, generates the next milestone ID,
 * and dispatches the headless discuss prompt (no Q&A rounds).
 */
export async function showHeadlessMilestoneCreation(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  seedContext: string,
): Promise<void> {
  // Clear stale reservations from previous cancelled sessions (#2488)
  clearReservedMilestoneIds();

  // Ensure .gsd/ is bootstrapped
  bootstrapGsdProject(basePath);

  // Generate next milestone ID
  const existingIds = findMilestoneIds(basePath);
  const prefs = loadEffectiveGSDPreferences();
  const nextId = nextMilestoneIdReserved(existingIds, prefs?.preferences?.unique_milestone_ids ?? false);

  // Create milestone directory
  const milestoneDir = join(gsdRoot(basePath), "milestones", nextId, "slices");
  mkdirSync(milestoneDir, { recursive: true });

  // Build and dispatch the headless discuss prompt
  const prompt = buildHeadlessDiscussPrompt(nextId, seedContext, basePath);

  // Set pending auto start (auto-mode triggers on "Milestone X ready." via checkAutoStartAfterDiscuss)
  pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, createdAt: Date.now() });

  // Dispatch — headless milestone creation is a planning activity
  await dispatchWorkflow(pi, prompt, "gsd-run", ctx, "plan-milestone");
}


// ─── Discuss Flow ─────────────────────────────────────────────────────────────

/**
 * Build a rich inlined-context prompt for discussing a specific slice.
 * Preloads roadmap, milestone context, research, decisions, and completed
 * slice summaries so the agent can ask grounded UX/behaviour questions
 * without wasting a turn reading files.
 */
async function buildDiscussSlicePrompt(
  mid: string,
  sid: string,
  sTitle: string,
  base: string,
  options?: { rediscuss?: boolean; structuredQuestionsAvailable?: string },
): Promise<string> {
  const inlined: string[] = [];

  // Roadmap — always included so the agent sees surrounding slices
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (roadmapContent) {
    inlined.push(`### Milestone Roadmap\nSource: \`${roadmapRel}\`\n\n${roadmapContent.trim()}`);
  }

  // Milestone context — understanding the full milestone intent
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextContent = contextPath ? await loadFile(contextPath) : null;
  if (contextContent) {
    inlined.push(`### Milestone Context\nSource: \`${contextRel}\`\n\n${contextContent.trim()}`);
  }

  // Milestone research — technical grounding
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");
  const researchContent = researchPath ? await loadFile(researchPath) : null;
  if (researchContent) {
    inlined.push(`### Milestone Research\nSource: \`${researchRel}\`\n\n${researchContent.trim()}`);
  }

  // Decisions — architectural context that constrains this slice
  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) {
    const decisionsContent = await loadFile(decisionsPath);
    if (decisionsContent) {
      inlined.push(`### Decisions Register\nSource: \`${relGsdRootFile("DECISIONS")}\`\n\n${decisionsContent.trim()}`);
    }
  }

  // Completed slice summaries — what was already built that this slice builds on
  // Ensure DB is open so getMilestoneSlices returns real data (#2560).
  {
    const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
    await ensureDbOpen();
    type NormSlice = { id: string; done: boolean };
    let normSlices: NormSlice[] = [];
    if (isDbAvailable()) {
      normSlices = getMilestoneSlices(mid).map(s => ({ id: s.id, done: s.status === "complete" }));
    }
    for (const s of normSlices) {
      if (!s.done || s.id === sid) continue;
      const summaryPath = resolveSliceFile(base, mid, s.id, "SUMMARY");
      const summaryRel = relSliceFile(base, mid, s.id, "SUMMARY");
      const summaryContent = summaryPath ? await loadFile(summaryPath) : null;
      if (summaryContent) {
        inlined.push(`### ${s.id} Summary (completed)\nSource: \`${summaryRel}\`\n\n${summaryContent.trim()}`);
      }
    }
  }

  const inlinedContext = inlined.length > 0
    ? `## Inlined Context (preloaded — do not re-read these files)\n\n${inlined.join("\n\n---\n\n")}`
    : `## Inlined Context\n\n_(no context files found yet — go in blind and ask broad questions)_`;

  const sliceDirPath = `.gsd/milestones/${mid}/slices/${sid}`;
  const sliceContextPath = `${sliceDirPath}/${sid}-CONTEXT.md`;

  // When re-discussing, inject a preamble so the agent treats this as an update interview
  const rediscussPreamble = options?.rediscuss
    ? `\n\n## Re-discuss Mode\n\nThis slice already has an existing context file (\`${sliceContextPath}\`) from a prior discussion. The user has chosen to re-discuss it. Read the existing context file, interview for any updates, changes, or new decisions, and rewrite the file with merged findings. Do NOT skip the interview — the user explicitly asked to revisit this slice.\n`
    : "";

  const inlinedTemplates = inlineTemplate("slice-context", "Slice Context");
  return loadPrompt("guided-discuss-slice", {
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    inlinedContext: inlinedContext + rediscussPreamble,
    sliceDirPath,
    contextPath: sliceContextPath,
    projectRoot: base,
    inlinedTemplates,
    structuredQuestionsAvailable: options?.structuredQuestionsAvailable ?? "false",
    commitInstruction: buildDocsCommitInstruction(`docs(${mid}/${sid}): slice context from discuss`),
  });
}

/**
 * /gsd discuss — show a picker of non-done slices and run a slice interview.
 * Loops back to the picker after each discussion so the user can chain
 * multiple slice interviews in one session.
 */
export async function showDiscuss(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  // Guard: no .gsd/ project
  if (!existsSync(gsdRoot(basePath))) {
    ctx.ui.notify("No GSD project found. Run /gsd to start one first.", "warning");
    return;
  }

  // Invalidate caches to pick up artifacts written by a just-completed discuss/plan
  invalidateAllCaches();

  const state = await deriveState(basePath);

  // Rebuild STATE.md from derived state before any dispatch (#3475).
  // Without this, guided prompts read a stale STATE.md cache and the
  // agent bootstraps from the wrong milestone.
  try {
    const { buildStateMarkdown } = await import("./doctor.js");
    await saveFile(resolveGsdRootFile(basePath, "STATE"), buildStateMarkdown(state));
  } catch (err) {
    logWarning("guided", `STATE.md rebuild failed: ${(err as Error).message}`);
  }

  // No active milestone (or corrupted milestone with undefined id) —
  // check for pending milestones to discuss instead
  if (!state.activeMilestone?.id) {
    const pendingMilestones = state.registry.filter(m => m.status === "pending");
    if (pendingMilestones.length === 0) {
      ctx.ui.notify("No active milestone. Run /gsd to create one first.", "warning");
      return;
    }
    await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones);
    return;
  }

  const mid = state.activeMilestone.id;
  const milestoneTitle = state.activeMilestone.title;

  // Special case: milestone is in needs-discussion phase (has CONTEXT-DRAFT.md but no roadmap yet).
  // Route to the draft discussion flow instead of erroring — the discussion IS how the roadmap gets created.
  if (state.phase === "needs-discussion") {
    const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
    const draftContent = draftFile ? await loadFile(draftFile) : null;

    const choice = await showNextAction(ctx, {
      title: `GSD — ${mid}: ${milestoneTitle}`,
      summary: ["This milestone has a draft context from a prior discussion.", "It needs a dedicated discussion before auto-planning can begin."],
      actions: [
        {
          id: "discuss_draft",
          label: "Discuss from draft",
          description: "Continue where the prior discussion left off — seed material is loaded automatically.",
          recommended: true,
        },
        {
          id: "discuss_fresh",
          label: "Start fresh discussion",
          description: "Discard the draft and start a new discussion from scratch.",
        },
        {
          id: "skip_milestone",
          label: "Skip — create new milestone",
          description: "Leave this milestone as-is and start something new.",
        },
      ],
      notYetMessage: "Run /gsd discuss when ready to discuss this milestone.",
    });

    if (choice === "discuss_draft") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        milestoneId: mid, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
        fastPathInstruction: "",
      });
      const seed = draftContent
        ? `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\n${draftContent}`
        : basePrompt;
      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: mid, step: false, createdAt: Date.now() });
      await dispatchWorkflow(pi, seed, "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: mid, step: false, createdAt: Date.now() });
      await dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        milestoneId: mid, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
        fastPathInstruction: "",
      }), "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "skip_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds);
      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, step: false, createdAt: Date.now() });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId, `New milestone ${nextId}.`, basePath), "gsd-run", ctx, "discuss-milestone");
    }
    return;
  }

  // Ensure DB is open before querying slices (#2560).
  // showDiscuss() is a command handler — unlike tool handlers, it has no
  // automatic ensureDbOpen() call. Without this, isDbAvailable() returns
  // false on cold-start sessions and normSlices falls to [] → false
  // "All slices complete" exit.
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen();

  // Guard: no roadmap yet (unless DB has slices)
  const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent && !isDbAvailable()) {
    ctx.ui.notify("No roadmap yet for this milestone. Run /gsd to plan first.", "warning");
    return;
  }

  // Normalize slices: prefer DB, fall back to parser
  type NormSlice = { id: string; done: boolean; title: string };
  let normSlices: NormSlice[];
  if (isDbAvailable()) {
    normSlices = getMilestoneSlices(mid).map(s => ({ id: s.id, done: s.status === "complete", title: s.title }));
  } else {
    normSlices = [];
  }
  // DB is open but returned zero slices despite a roadmap existing —
  // the DB may be empty due to WAL loss or truncation (see #2815, #2892).
  // Fall back to roadmap parsing to prevent false "all complete" exit.
  if (normSlices.length === 0 && roadmapContent) {
    normSlices = parseRoadmapSlices(roadmapContent).map(s => ({ id: s.id, done: s.done, title: s.title }));
  }
  const pendingSlices = normSlices.filter(s => !s.done);

  if (pendingSlices.length === 0) {
    // All slices complete — but queued milestones may still need discussion (#3150)
    const pendingMilestones = state.registry.filter(m => m.status === "pending");
    if (pendingMilestones.length > 0) {
      await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones);
      return;
    }
    ctx.ui.notify("All slices are complete — nothing to discuss.", "info");
    return;
  }

  // Loop: show picker, dispatch discuss, repeat until "not_yet"
  while (true) {
    // Invalidate caches so we pick up CONTEXT files written by the just-completed discussion
    invalidateAllCaches();

    // Build discussion-state map: which slices have CONTEXT files already?
    const discussedMap = new Map<string, boolean>();
    for (const s of pendingSlices) {
      const contextFile = resolveSliceFile(basePath, mid, s.id, "CONTEXT");
      discussedMap.set(s.id, !!contextFile);
    }

    // If all pending slices are discussed, check for queued milestones before exiting (#3150)
    const allDiscussed = pendingSlices.every(s => discussedMap.get(s.id));
    if (allDiscussed) {
      const pendingMilestones = state.registry.filter(m => m.status === "pending");
      if (pendingMilestones.length > 0) {
        await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones);
        return;
      }
      const lockData = readSessionLockData(basePath);
      const remoteAutoRunning = lockData && lockData.pid !== process.pid && isSessionLockProcessAlive(lockData);
      const nextStep = remoteAutoRunning
        ? "Auto-mode is already running — use /gsd status to check progress."
        : "Run /gsd to start planning.";
      ctx.ui.notify(
        `All ${pendingSlices.length} slices discussed. ${nextStep}`,
        "info",
      );
      return;
    }

    // Find the first undiscussed slice to recommend
    const firstUndiscussedId = pendingSlices.find(s => !discussedMap.get(s.id))?.id;

    const actions = pendingSlices.map((s) => {
      const discussed = discussedMap.get(s.id) ?? false;
      const statusParts: string[] = [];
      if (state.activeSlice?.id === s.id) statusParts.push("active");
      else statusParts.push("upcoming");
      statusParts.push(discussed ? "discussed ✓" : "not discussed");

      return {
        id: s.id,
        label: `${s.id}: ${s.title}`,
        description: statusParts.join(" · "),
        recommended: s.id === firstUndiscussedId,
      };
    });

    // Offer access to queued milestones when any exist
    const pendingMilestones = state.registry.filter(m => m.status === "pending");
    if (pendingMilestones.length > 0) {
      actions.push({
        id: "discuss_queued_milestone",
        label: "Discuss a queued milestone",
        description: `Refine context for ${pendingMilestones.length} queued milestone(s). Does not affect current execution.`,
        recommended: false,
      });
    }

    const choice = await showNextAction(ctx, {
      title: "GSD — Discuss a slice",
      summary: [
        `${mid}: ${milestoneTitle}`,
        "Pick a slice to interview. Context file will be written when done.",
      ],
      actions,
      notYetMessage: "Run /gsd discuss when ready.",
    });

    if (choice === "not_yet") return;

    if (choice === "discuss_queued_milestone") {
      await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones);
      return;
    }

    const chosen = pendingSlices.find(s => s.id === choice);
    if (!chosen) return;

    // If the slice already has a CONTEXT file, confirm re-discuss intent
    const isRediscuss = discussedMap.get(chosen.id) ?? false;
    if (isRediscuss) {
      const confirm = await showNextAction(ctx, {
        title: `Re-discuss ${chosen.id}?`,
        summary: [
          `${chosen.id} already has a context file from a prior discussion.`,
          "Re-discussing will interview for updates and rewrite the context file.",
        ],
        actions: [
          { id: "rediscuss", label: "Re-discuss to update context", description: "Interview for changes and rewrite", recommended: true },
          { id: "cancel", label: "Cancel", description: "Go back to slice picker" },
        ],
      });
      if (confirm !== "rediscuss") continue;
    }

    const sqAvail = getStructuredQuestionsAvailability(pi, ctx);
    const prompt = await buildDiscussSlicePrompt(mid, chosen.id, chosen.title, basePath, { rediscuss: isRediscuss, structuredQuestionsAvailable: sqAvail });
    await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-slice");

    // Wait for the discuss session to finish, then loop back to the picker
    await ctx.waitForIdle();
    invalidateAllCaches();
  }
}

// ─── Queued Milestone Discussion ─────────────────────────────────────────────

/**
 * Show a picker of queued (pending) milestones and dispatch a discuss flow for
 * the chosen one. Discussing a queued milestone does NOT activate it — it only
 * refines the CONTEXT.md artifact so it is better prepared when auto-mode
 * eventually reaches it.
 */
async function showDiscussQueuedMilestone(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  pendingMilestones: Array<{ id: string; title: string; status: string }>,
): Promise<void> {
  const actions = pendingMilestones.map((m, i) => {
    const hasContext = !!resolveMilestoneFile(basePath, m.id, "CONTEXT");
    const hasDraft = !hasContext && !!resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
    const contextStatus = hasContext ? "context ✓" : hasDraft ? "draft context" : "no context yet";
    return {
      id: m.id,
      label: `${m.id}: ${m.title}`,
      description: `[queued] · ${contextStatus}`,
      recommended: i === 0,
    };
  });

  const choice = await showNextAction(ctx, {
    title: "GSD — Discuss a queued milestone",
    summary: [
      "Select a queued milestone to discuss.",
      "Discussing will update its context file. It will not be activated.",
    ],
    actions,
    notYetMessage: "Run /gsd discuss when ready.",
  });

  if (choice === "not_yet") return;

  const chosen = pendingMilestones.find(m => m.id === choice);
  if (!chosen) return;

  const hasDraft = !!resolveMilestoneFile(basePath, chosen.id, "CONTEXT-DRAFT");
  let fastPath = hasDraft;

  if (!hasDraft) {
    const mode = await showNextAction(ctx, {
      title: `Discuss ${chosen.id}`,
      summary: [
        "Choose how to start the discussion.",
        "Fast path skips generic scouting — use it when you already know the scope.",
      ],
      actions: [
        {
          id: "full",
          label: "Full discussion",
          description: "Scout the codebase, ask open-ended questions, explore deeply",
          recommended: true,
        },
        {
          id: "fast",
          label: "I have the scope — fast path",
          description: "Treat your first message as authoritative seed context; skip scouting",
        },
      ],
      notYetMessage: "Run /gsd discuss when ready.",
    });
    if (mode === "not_yet") return;
    fastPath = mode === "fast";
  }

  await dispatchDiscussForMilestone(ctx, pi, basePath, chosen.id, chosen.title, { fastPath });
}

/**
 * Dispatch the guided-discuss-milestone prompt for a milestone without
 * setting pendingAutoStart — so discussing a queued milestone does not
 * implicitly activate it when the session ends.
 */
async function dispatchDiscussForMilestone(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  mid: string,
  milestoneTitle: string,
  opts: { fastPath?: boolean } = {},
): Promise<void> {
  const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const draftContent = draftFile ? await loadFile(draftFile) : null;
  const hasSeed = !!(draftContent || opts.fastPath);
  const fastPathInstruction = hasSeed
    ? [
        "> **Fast path active — scope provided.**",
        "> Do NOT perform a generic codebase scouting pass.",
        "> Do at most 2 targeted reads to check for obvious conflicts with existing work.",
        "> Treat the seed context or the operator's first message as authoritative.",
        "> Move directly to the depth summary and write step.",
        "> Ask only questions where the answer would materially change scope.",
      ].join("\n")
    : "";
  const discussMilestoneTemplates = inlineTemplate("context", "Context");
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  const basePrompt = loadPrompt("guided-discuss-milestone", {
    milestoneId: mid,
    milestoneTitle,
    inlinedTemplates: discussMilestoneTemplates,
    structuredQuestionsAvailable,
    commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
    fastPathInstruction,
  });
  const prompt = draftContent
    ? `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\n${draftContent}`
    : basePrompt;
  await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-milestone");
}

// ─── Smart Entry Point ────────────────────────────────────────────────────────

/**
 * The one wizard. Reads state, shows contextual options, dispatches into the workflow doc.
 */
/**
 * Self-heal: scan runtime records and clear stale ones left behind when
 * auto-mode crashed mid-unit. auto.ts has its own selfHealRuntimeRecords()
 * but guided-flow (manual /gsd mode) never called it — meaning stale records
 * persisted until the next /gsd auto run.  This ensures the wizard always
 * starts from a clean state regardless of how the previous session ended.
 */
function selfHealRuntimeRecords(basePath: string, ctx: ExtensionContext): { cleared: number } {
  try {
    const records = listUnitRuntimeRecords(basePath);
    let cleared = 0;
    for (const record of records) {
      const { unitType, unitId, phase } = record;
      // Clear records whose expected artifact already exists (completed but not cleaned up)
      const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
      if (artifactPath && existsSync(artifactPath)) {
        clearUnitRuntimeRecord(basePath, unitType, unitId);
        cleared++;
        continue;
      }
      // Clear records stuck in dispatched or timeout phase (process died mid-unit)
      if (phase === "dispatched" || phase === "timeout") {
        clearUnitRuntimeRecord(basePath, unitType, unitId);
        cleared++;
      }
    }
    if (cleared > 0) {
      ctx.ui.notify(`Self-heal: cleared ${cleared} stale runtime record(s) from a previous session.`, "info");
    }
    return { cleared };
  } catch (e) {
    logWarning("guided", `self-heal stale runtime records failed: ${(e as Error).message}`);
    return { cleared: 0 };
  }
}

// ─── Milestone Actions Submenu ──────────────────────────────────────────────

/**
 * Shows a submenu with Park / Discard / Skip / Back options for the active milestone.
 * Returns true if an action was taken (caller should re-enter showSmartEntry or
 * dispatch a new workflow). Returns false if the user chose "Back".
 */
async function handleMilestoneActions(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  milestoneId: string,
  milestoneTitle: string,
  options?: { step?: boolean },
): Promise<boolean> {
  const stepMode = options?.step;
  const choice = await showNextAction(ctx, {
    title: `Milestone Actions — ${milestoneId}`,
    summary: [`${milestoneId}: ${milestoneTitle}`],
    actions: [
      {
        id: "park",
        label: "Park milestone",
        description: "Pause this milestone — it stays on disk but is skipped.",
      },
      {
        id: "discard",
        label: "Discard milestone",
        description: "Permanently delete this milestone and all its contents.",
      },
      {
        id: "skip",
        label: "Skip — create new milestone",
        description: "Leave this milestone and start a fresh one.",
      },
      {
        id: "back",
        label: "Back",
        description: "Return to the previous menu.",
      },
    ],
    notYetMessage: "Run /gsd when ready.",
  });

  if (choice === "park") {
    const reason = await showNextAction(ctx, {
      title: `Park ${milestoneId}`,
      summary: ["Why is this milestone being parked?"],
      actions: [
        { id: "priority_shift", label: "Priority shift", description: "Other work is more important right now." },
        { id: "blocked_external", label: "Blocked externally", description: "Waiting on an external dependency or decision." },
        { id: "needs_rethink", label: "Needs rethinking", description: "The approach needs to be reconsidered." },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    // User pressed "Not yet" / Escape — cancel the park operation
    if (!reason || reason === "not_yet") return false;

    const reasonText = reason === "priority_shift" ? "Priority shift — other work is more important"
      : reason === "blocked_external" ? "Blocked externally — waiting on external dependency"
      : reason === "needs_rethink" ? "Needs rethinking — approach needs reconsideration"
      : "Parked by user";

    const success = parkMilestone(basePath, milestoneId, reasonText);
    if (success) {
      ctx.ui.notify(`Parked ${milestoneId}. Run /gsd unpark ${milestoneId} to reactivate.`, "info");
    } else {
      ctx.ui.notify(`Could not park ${milestoneId} — milestone not found or already parked.`, "warning");
    }
    return true;
  }

  if (choice === "discard") {
    const confirmed = await showConfirm(ctx, {
      title: "Discard milestone?",
      message: `This will permanently delete ${milestoneId} and all its contents (roadmap, plans, task summaries).`,
      confirmLabel: "Discard",
      declineLabel: "Cancel",
    });
    if (confirmed) {
      discardMilestone(basePath, milestoneId);
      ctx.ui.notify(`Discarded ${milestoneId}.`, "info");
      return true;
    }
    return false;
  }

  if (choice === "skip") {
    const milestoneIds = findMilestoneIds(basePath);
    const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
    const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds);
    pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode, createdAt: Date.now() });
    await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId,
      `New milestone ${nextId}.`,
      basePath
    ), "gsd-run", ctx, "discuss-milestone");
    return true;
  }

  // "back" or null
  return false;
}

export async function showSmartEntry(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  options?: { step?: boolean },
): Promise<void> {
  const stepMode = options?.step;

  // ── Clear stale milestone ID reservations from previous cancelled sessions ──
  // Reservations only need to survive within a single /gsd interaction.
  // Without this, each cancelled session permanently bumps the next ID. (#2488)
  clearReservedMilestoneIds();

  // ── Directory safety check — refuse to operate in system/home dirs ───
  const dirCheck = validateDirectory(basePath);
  if (dirCheck.severity === "blocked") {
    ctx.ui.notify(dirCheck.reason!, "error");
    return;
  }
  if (dirCheck.severity === "warning") {
    const proceed = await showConfirm(ctx, {
      title: "GSD — Unusual Directory",
      message: dirCheck.reason!,
      confirmLabel: "Continue anyway",
      declineLabel: "Cancel",
    });
    if (!proceed) return;
  }

  // ── Detection preamble — run before any bootstrap ────────────────────
  // Check bootstrap completeness, not just .gsd/ directory existence.
  // A zombie .gsd/ state (symlink exists but missing PREFERENCES.md and
  // milestones/) must trigger the init wizard, not skip it (#2942).
  const gsdPath = gsdRoot(basePath);
  const hasBootstrapArtifacts = existsSync(gsdPath)
    && (existsSync(join(gsdPath, "PREFERENCES.md"))
        || existsSync(join(gsdPath, "milestones")));

  if (!hasBootstrapArtifacts) {
    const detection = detectProjectState(basePath);

    // v1 .planning/ detected — offer migration before anything else
    if (detection.state === "v1-planning" && detection.v1) {
      const migrationChoice = await offerMigration(ctx, detection.v1);
      if (migrationChoice === "cancel") return;
      if (migrationChoice === "migrate") {
        const { handleMigrate } = await import("./migrate/command.js");
        await handleMigrate("", ctx, pi);
        return;
      }
      // "fresh" — fall through to init wizard
    }

    // No .gsd/ or zombie .gsd/ — run the project init wizard
    const result = await showProjectInit(ctx, pi, basePath, detection);
    if (!result.completed) return; // User cancelled

    // Init wizard bootstrapped .gsd/ — fall through to the normal flow below
    // which will detect "no milestones" and start the discuss prompt
  }

  // ── Ensure git repo exists — GSD needs it for worktree isolation ──────
  // Also handle inherited repos: if basePath is a subdirectory of another
  // git repo that has no .gsd, create a fresh repo to prevent cross-project
  // state leaks (#1639).
  if (!nativeIsRepo(basePath) || isInheritedRepo(basePath)) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(basePath, mainBranch);
  }

  // ── Ensure .gitignore has baseline patterns ──────────────────────────
  ensureGitignore(basePath);
  untrackRuntimeFiles(basePath);

  // ── Self-heal stale runtime records from crashed auto-mode sessions ──
  selfHealRuntimeRecords(basePath, ctx);

  const interrupted = await assessInterruptedSession(basePath);
  if (interrupted.classification === "running") {
    ctx.ui.notify(formatInterruptedSessionRunningMessage(interrupted), "error");
    return;
  }

  if (interrupted.classification === "stale") {
    clearLock(basePath);
    if (interrupted.pausedSession) {
      try {
        unlinkSync(join(gsdRoot(basePath), "runtime", "paused-session.json"));
      } catch (e) {
        logWarning("guided", `stale pause file cleanup failed: ${(e as Error).message}`, { file: "guided-flow.ts" });
      }
    }
  } else if (interrupted.classification === "recoverable") {
    if (interrupted.lock) clearLock(basePath);
    const resumeLabel = interrupted.pausedSession?.stepMode
      ? "Resume with /gsd next"
      : "Resume with /gsd auto";
    const resume = await showNextAction(ctx, {
      title: "GSD — Interrupted Session Detected",
      summary: formatInterruptedSessionSummary(interrupted),
      actions: [
        { id: "resume", label: resumeLabel, description: "Pick up where it left off", recommended: true },
        { id: "continue", label: "Continue manually", description: "Open the wizard as normal" },
      ],
    });
    if (resume === "resume") {
      await startAuto(ctx, pi, basePath, false, {
        interrupted,
        step: interrupted.pausedSession?.stepMode ?? false,
      });
      return;
    }
  }

  // Always derive from the project root — the assessment may have derived
  // state from a worktree path that was cleaned up in the stale branch above.
  const state = await deriveState(basePath);

  // Rebuild STATE.md from derived state before any dispatch (#3475).
  try {
    const { buildStateMarkdown } = await import("./doctor.js");
    await saveFile(resolveGsdRootFile(basePath, "STATE"), buildStateMarkdown(state));
  } catch (err) {
    logWarning("guided", `STATE.md rebuild failed: ${(err as Error).message}`);
  }

  if (!state.activeMilestone?.id) {
    // Guard: if a discuss session is already in flight, don't re-inject the prompt.
    // Both /gsd and /gsd auto reach this branch when no milestone exists yet.
    // Without this guard, every subsequent /gsd call overwrites the pending auto-start
    // and fires another dispatchWorkflow, resetting the conversation mid-interview.
    if (pendingAutoStartMap.has(basePath)) {
      // #3274: If /clear interrupted the discussion, the pending entry is stale.
      // Detect staleness: no manifest, no CONTEXT.md, AND entry is older than
      // 30s (avoids race between .set() and LLM writing first artifact).
      const entry = pendingAutoStartMap.get(basePath)!;
      const ageMs = Date.now() - (entry.createdAt || 0);
      const manifestExists = existsSync(join(gsdRoot(basePath), "DISCUSSION-MANIFEST.json"));
      const milestoneHasContext = existsSync(
        join(gsdRoot(basePath), "milestones", entry.milestoneId, `${entry.milestoneId}-CONTEXT.md`),
      );
      if (!manifestExists && !milestoneHasContext && ageMs > 30_000) {
        // Stale entry from an interrupted discussion — clear and continue
        pendingAutoStartMap.delete(basePath);
      } else {
        ctx.ui.notify("Discussion already in progress — answer the question above to continue.", "info");
        return;
      }
    }

    const milestoneIds = findMilestoneIds(basePath);

    // Sanity check (#456): if findMilestoneIds returns [] but the milestones
    // directory has contents, something went wrong (permissions, stale worktree
    // cwd, etc). Warn instead of silently starting a new-project flow.
    if (milestoneIds.length === 0) {
      const mDir = milestonesDir(basePath);
      if (existsSync(mDir)) {
        try {
          const entries = readdirSync(mDir);
          if (entries.length > 0) {
            ctx.ui.notify(
              `Milestone directory has ${entries.length} entries but none were recognized as milestones. ` +
              `This may indicate a corrupted state or wrong working directory. Run \`/gsd doctor\` to diagnose.`,
              "warning",
            );
            return;
          }
        } catch (e) { logWarning("guided", `directory read failed: ${(e as Error).message}`); }
      }
    }

    const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
    const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds);
    const isFirst = milestoneIds.length === 0;

    if (isFirst) {
      // First ever — skip wizard, just ask directly
      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode, createdAt: Date.now() });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId,
        `New project, milestone ${nextId}. Do NOT read or explore .gsd/ — it's empty scaffolding.`,
        basePath
      ), "gsd-run", ctx, "discuss-milestone");
    } else {
      const choice = await showNextAction(ctx, {
        title: "GSD — Get Shit Done",
        summary: ["No active milestone."],
        actions: [
          {
            id: "new_milestone",
            label: "Create next milestone",
            description: "Define what to build next.",
            recommended: true,
          },
        ],
        notYetMessage: "Run /gsd when ready.",
      });

      if (choice === "new_milestone") {
        pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode, createdAt: Date.now() });
        await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId,
          `New milestone ${nextId}.`,
          basePath
        ), "gsd-run", ctx, "discuss-milestone");
      }
    }
    return;
  }

  const milestoneId = state.activeMilestone.id;
  const milestoneTitle = state.activeMilestone.title;

  // ── All milestones complete → New milestone ──────────────────────────
  if (state.phase === "complete") {
    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId}: ${milestoneTitle}`,
      summary: ["All milestones complete."],
      actions: [
        {
          id: "new_milestone",
          label: "Start new milestone",
          description: "Define and plan the next milestone.",
          recommended: true,
        },
        {
          id: "status",
          label: "View status",
          description: "Review what was built.",
        },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "new_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds);

      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode, createdAt: Date.now() });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId,
        `New milestone ${nextId}.`,
        basePath
      ), "gsd-run", ctx, "discuss-milestone");
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    }
    return;
  }

  // ── Draft milestone — needs discussion before planning ────────────────
  if (state.phase === "needs-discussion") {
    const draftFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT-DRAFT");
    const draftContent = draftFile ? await loadFile(draftFile) : null;

    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId}: ${milestoneTitle}`,
      summary: ["This milestone has a draft context from a prior discussion.", "It needs a dedicated discussion before auto-planning can begin."],
      actions: [
        {
          id: "discuss_draft",
          label: "Discuss from draft",
          description: "Continue where the prior discussion left off — seed material is loaded automatically.",
          recommended: true,
        },
        {
          id: "discuss_fresh",
          label: "Start fresh discussion",
          description: "Discard the draft and start a new discussion from scratch.",
        },
        {
          id: "skip_milestone",
          label: "Skip — create new milestone",
          description: "Leave this milestone as-is and start something new.",
        },
      ],
      notYetMessage: "Run /gsd when ready to discuss this milestone.",
    });

    if (choice === "discuss_draft") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
        fastPathInstruction: "",
      });
      const seed = draftContent
        ? `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\n${draftContent}`
        : basePrompt;
      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId, step: stepMode, createdAt: Date.now() });
      await dispatchWorkflow(pi, seed, "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId, step: stepMode, createdAt: Date.now() });
      await dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
        fastPathInstruction: "",
      }), "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "skip_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds);
      pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode, createdAt: Date.now() });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId,
        `New milestone ${nextId}.`,
        basePath
      ), "gsd-run", ctx, "discuss-milestone");
    }
    return;
  }

  // ── No active slice ──────────────────────────────────────────────────
  if (!state.activeSlice) {
    const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const hasRoadmap = !!(roadmapFile && await loadFile(roadmapFile));

    // A roadmap file with zero parseable slices (placeholder text) should be
    // treated the same as no roadmap — offer "Create roadmap" instead of "Go auto"
    // which would immediately get stuck in blocked state (#3441).
    let roadmapHasSlices = false;
    if (hasRoadmap) {
      const roadmapContent = await loadFile(roadmapFile!);
      if (roadmapContent) {
        const parsed = parseRoadmapSlices(roadmapContent);
        roadmapHasSlices = parsed.length > 0;
      }
    }

    if (!hasRoadmap || !roadmapHasSlices) {
      // No roadmap → discuss or plan
      const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
      const hasContext = !!(contextFile && await loadFile(contextFile));

      const actions = [
        {
          id: "plan",
          label: "Create roadmap",
          description: hasContext
            ? "Context captured. Decompose into slices with a boundary map."
            : "Decompose the milestone into slices with a boundary map.",
          recommended: true,
        },
        ...(!hasContext ? [{
          id: "discuss",
          label: "Discuss first",
          description: "Capture decisions on gray areas before planning.",
        }] : []),
        {
          id: "skip_milestone",
          label: "Skip — create new milestone",
          description: "Leave this milestone on disk and start a fresh one.",
        },
        {
          id: "discard_milestone",
          label: "Discard this milestone",
          description: "Delete the milestone directory and start over.",
        },
      ];

      const choice = await showNextAction(ctx, {
        title: `GSD — ${milestoneId}: ${milestoneTitle}`,
        summary: [hasContext ? "Context captured. Ready to create roadmap." : "New milestone — no roadmap yet."],
        actions,
        notYetMessage: "Run /gsd when ready.",
      });

      if (choice === "plan") {
        pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId, step: stepMode, createdAt: Date.now() });
        const planMilestoneTemplates = [
          inlineTemplate("roadmap", "Roadmap"),
          inlineTemplate("plan", "Slice Plan"),
          inlineTemplate("task-plan", "Task Plan"),
          inlineTemplate("secrets-manifest", "Secrets Manifest"),
        ].join("\n\n---\n\n");
        const secretsOutputPath = relMilestoneFile(basePath, milestoneId, "SECRETS");
        await dispatchWorkflow(pi, loadPrompt("guided-plan-milestone", {
          milestoneId,
          milestoneTitle,
          secretsOutputPath,
          inlinedTemplates: planMilestoneTemplates,
          skillActivation: buildSkillActivationBlock({
            base: basePath,
            milestoneId,
            milestoneTitle,
            extraContext: [planMilestoneTemplates],
          }),
        }), "gsd-run", ctx, "plan-milestone");
      } else if (choice === "discuss") {
        const discussMilestoneTemplates = inlineTemplate("context", "Context");
        const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
        await dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
          milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
          commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
          fastPathInstruction: "",
        }), "gsd-run", ctx, "discuss-milestone");
      } else if (choice === "skip_milestone") {
        const milestoneIds = findMilestoneIds(basePath);
        const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
        const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds);
        pendingAutoStartMap.set(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode, createdAt: Date.now() });
        await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId,
          `New milestone ${nextId}.`,
          basePath
        ), "gsd-run", ctx, "discuss-milestone");
      } else if (choice === "discard_milestone") {
        const confirmed = await showConfirm(ctx, {
          title: "Discard milestone?",
          message: `This will permanently delete ${milestoneId} and all its contents.`,
          confirmLabel: "Discard",
          declineLabel: "Cancel",
        });
        if (confirmed) {
          discardMilestone(basePath, milestoneId);
          return showSmartEntry(ctx, pi, basePath, options);
        }
      }
    } else {
      // Roadmap exists — either blocked or ready for auto
      const actions = [
        {
          id: "auto",
          label: "Go auto",
          description: "Execute everything automatically until milestone complete.",
          recommended: true,
        },
        {
          id: "status",
          label: "View status",
          description: "See milestone progress and blockers.",
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone.",
        },
      ];

      const choice = await showNextAction(ctx, {
        title: `GSD — ${milestoneId}: ${milestoneTitle}`,
        summary: ["Roadmap exists. Ready to execute."],
        actions,
        notYetMessage: "Run /gsd status for details.",
      });

      if (choice === "auto") {
        await startAuto(ctx, pi, basePath, false);
      } else if (choice === "status") {
        const { fireStatusViaCommand } = await import("./commands.js");
        await fireStatusViaCommand(ctx);
      } else if (choice === "milestone_actions") {
        const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
        if (acted) return showSmartEntry(ctx, pi, basePath, options);
      }
    }
    return;
  }

  const sliceId = state.activeSlice.id;
  const sliceTitle = state.activeSlice.title;

  // ── Slice needs planning ─────────────────────────────────────────────
  if (state.phase === "planning") {
    const contextFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTEXT");
    const researchFile = resolveSliceFile(basePath, milestoneId, sliceId, "RESEARCH");
    const hasContext = !!(contextFile && await loadFile(contextFile));
    const hasResearch = !!(researchFile && await loadFile(researchFile));

    const actions = [
      {
        id: "plan",
        label: `Plan ${sliceId}`,
        description: `Decompose "${sliceTitle}" into tasks with must-haves.`,
        recommended: true,
      },
      ...(!hasContext ? [{
        id: "discuss",
        label: `Discuss ${sliceId} first`,
        description: "Capture context and decisions for this slice.",
      }] : []),
      ...(!hasResearch ? [{
        id: "research",
        label: `Research ${sliceId} first`,
        description: "Scout codebase and relevant docs.",
      }] : []),
      {
        id: "status",
        label: "View status",
        description: "See milestone progress.",
      },
      {
        id: "milestone_actions",
        label: "Milestone actions",
        description: "Park, discard, or skip this milestone.",
      },
    ];

    const summaryParts = [];
    if (hasContext) summaryParts.push("context ✓");
    if (hasResearch) summaryParts.push("research ✓");
    const summaryLine = summaryParts.length > 0
      ? `${sliceId}: ${sliceTitle} (${summaryParts.join(", ")})`
      : `${sliceId}: ${sliceTitle} — ready for planning.`;

    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: [summaryLine],
      actions,
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "plan") {
      const planSliceTemplates = [
        inlineTemplate("plan", "Slice Plan"),
        inlineTemplate("task-plan", "Task Plan"),
      ].join("\n\n---\n\n");
      await dispatchWorkflow(pi, loadPrompt("guided-plan-slice", {
        milestoneId,
        sliceId,
        sliceTitle,
        inlinedTemplates: planSliceTemplates,
        skillActivation: buildSkillActivationBlock({
          base: basePath,
          milestoneId,
          sliceId,
          sliceTitle,
          extraContext: [planSliceTemplates],
        }),
      }), "gsd-run", ctx, "plan-slice");
    } else if (choice === "discuss") {
      const sqAvail = getStructuredQuestionsAvailability(pi, ctx);
      await dispatchWorkflow(pi, await buildDiscussSlicePrompt(milestoneId, sliceId, sliceTitle, basePath, { rediscuss: hasContext, structuredQuestionsAvailable: sqAvail }), "gsd-run", ctx, "discuss-slice");
    } else if (choice === "research") {
      const researchTemplates = inlineTemplate("research", "Research");
      await dispatchWorkflow(pi, loadPrompt("guided-research-slice", {
        milestoneId,
        sliceId,
        sliceTitle,
        inlinedTemplates: researchTemplates,
        skillActivation: buildSkillActivationBlock({
          base: basePath,
          milestoneId,
          sliceId,
          sliceTitle,
          extraContext: [researchTemplates],
        }),
      }), "gsd-run", ctx, "research-slice");
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }

  // ── All tasks done → Complete slice ──────────────────────────────────
  if (state.phase === "summarizing") {
    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: ["All tasks complete. Ready for slice summary."],
      actions: [
        {
          id: "complete",
          label: `Complete ${sliceId}`,
          description: "Write slice summary, UAT, mark done, and squash-merge to main.",
          recommended: true,
        },
        {
          id: "status",
          label: "View status",
          description: "Review tasks before completing.",
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone.",
        },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "complete") {
      const completeSliceTemplates = [
        inlineTemplate("slice-summary", "Slice Summary"),
        inlineTemplate("uat", "UAT"),
      ].join("\n\n---\n\n");
      await dispatchWorkflow(pi, loadPrompt("guided-complete-slice", {
        workingDirectory: basePath,
        milestoneId,
        sliceId,
        sliceTitle,
        inlinedTemplates: completeSliceTemplates,
        skillActivation: buildSkillActivationBlock({
          base: basePath,
          milestoneId,
          sliceId,
          sliceTitle,
          extraContext: [completeSliceTemplates],
        }),
      }), "gsd-run", ctx, "complete-slice");
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }

  // ── Active task → Execute ────────────────────────────────────────────
  if (state.activeTask) {
    const taskId = state.activeTask.id;
    const taskTitle = state.activeTask.title;

    const continueFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTINUE");
    const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
    const hasInterrupted = !!(continueFile && await loadFile(continueFile)) ||
      !!(sDir && await loadFile(join(sDir, "continue.md")));

    const choice = await showNextAction(ctx, {
      title: `GSD — ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: [
        hasInterrupted
          ? `Resuming: ${taskId} — ${taskTitle}`
          : `Next: ${taskId} — ${taskTitle}`,
      ],
      actions: [
        {
          id: "execute",
          label: hasInterrupted ? `Resume ${taskId}` : `Execute ${taskId}`,
          description: hasInterrupted
            ? "Continue from where you left off."
            : `Start working on "${taskTitle}".`,
          recommended: true,
        },
        {
          id: "auto",
          label: "Go auto",
          description: "Execute this and all remaining tasks automatically.",
        },
        {
          id: "status",
          label: "View status",
          description: "See slice progress before starting.",
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone.",
        },
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "auto") {
      await startAuto(ctx, pi, basePath, false);
      return;
    }

    if (choice === "execute") {
      if (hasInterrupted) {
        await dispatchWorkflow(pi, loadPrompt("guided-resume-task", {
          milestoneId,
          sliceId,
          skillActivation: buildSkillActivationBlock({
            base: basePath,
            milestoneId,
            sliceId,
            taskId,
            taskTitle,
          }),
        }), "gsd-run", ctx, "execute-task");
      } else {
        const executeTaskTemplates = inlineTemplate("task-summary", "Task Summary");
        await dispatchWorkflow(pi, loadPrompt("guided-execute-task", {
          milestoneId,
          sliceId,
          taskId,
          taskTitle,
          inlinedTemplates: executeTaskTemplates,
          skillActivation: buildSkillActivationBlock({
            base: basePath,
            milestoneId,
            sliceId,
            taskId,
            taskTitle,
            extraContext: [executeTaskTemplates],
          }),
        }), "gsd-run", ctx, "execute-task");
      }
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }

  // ── Fallback: show status ────────────────────────────────────────────
  const { fireStatusViaCommand } = await import("./commands.js");
  await fireStatusViaCommand(ctx);
}
