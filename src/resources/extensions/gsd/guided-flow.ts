/**
 * GSD Guided Flow — Smart Entry Wizard
 *
 * One function: showSmartEntry(). Reads state from disk, shows a contextual
 * wizard via showNextAction(), and dispatches through GSD-WORKFLOW.md.
 * No execution state, no hooks, no tools — the LLM does the rest.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { showNextAction } from "../shared/mod.js";
import { loadFile, parseRoadmap } from "./files.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { startAuto } from "./auto.js";
import { readCrashLock, clearLock, formatCrashInfo } from "./crash-recovery.js";
import { listUnitRuntimeRecords, clearUnitRuntimeRecord } from "./unit-runtime.js";
import { resolveExpectedArtifactPath } from "./auto.js";
import {
  gsdRoot, milestonesDir, resolveMilestoneFile, resolveMilestonePath,
  resolveSliceFile, resolveSlicePath, resolveGsdRootFile, relGsdRootFile,
  relMilestoneFile, relSliceFile,
} from "./paths.js";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { nativeIsRepo, nativeInit } from "./native-git-bridge.js";
import { ensureGitignore, ensurePreferences, untrackRuntimeFiles } from "./gitignore.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { detectProjectState } from "./detection.js";
import { showProjectInit, offerMigration } from "./init-wizard.js";
import { validateDirectory } from "./validate-directory.js";
import { showConfirm } from "../shared/mod.js";
import { debugLog } from "./debug-logger.js";
import { findMilestoneIds, nextMilestoneId } from "./milestone-ids.js";
import { parkMilestone, discardMilestone } from "./milestone-actions.js";

// ─── Re-exports (preserve public API for existing importers) ────────────────
export {
  MILESTONE_ID_RE, generateMilestoneSuffix, nextMilestoneId,
  extractMilestoneSeq, parseMilestoneId, milestoneIdSort,
  maxMilestoneNum, findMilestoneIds,
} from "./milestone-ids.js";
export {
  showQueue, handleQueueReorder, showQueueAdd,
  buildExistingMilestonesContext,
} from "./guided-flow-queue.js";
import { getErrorMessage } from "./error-utils.js";

// ─── Commit Instruction Helpers ──────────────────────────────────────────────

/** Build commit instruction for planning prompts. .gsd/ is managed externally and always gitignored. */
function buildDocsCommitInstruction(_message: string): string {
  return "Do not commit planning artifacts — .gsd/ is managed externally.";
}

// ─── Auto-start after discuss ─────────────────────────────────────────────────

/** Stashed context + flag for auto-starting after discuss phase completes */
let pendingAutoStart: {
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
  basePath: string;
  milestoneId: string; // the milestone being discussed
  step?: boolean; // preserve step mode through discuss → auto transition
} | null = null;

/** Returns the milestoneId being discussed, or null if no discussion is active */
export function getDiscussionMilestoneId(): string | null {
  return pendingAutoStart?.milestoneId ?? null;
}

/** Called from agent_end to check if auto-mode should start after discuss */
export function checkAutoStartAfterDiscuss(): boolean {
  if (!pendingAutoStart) return false;

  const { ctx, pi, basePath, milestoneId, step } = pendingAutoStart;

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
  if (projectFile) {
    try {
      const projectContent = readFileSync(projectFile, "utf-8");
      const milestoneIds = parseMilestoneSequenceFromProject(projectContent);
      if (milestoneIds.length > 1) {
        const missing = milestoneIds.filter(id => {
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
    } catch { /* non-fatal — PROJECT.md parsing failure shouldn't block auto-start */ }
  }

  // Gate 4: Discussion manifest process verification (multi-milestone only)
  // The LLM writes DISCUSSION-MANIFEST.json after each Phase 3 gate decision.
  // If the manifest exists but gates_completed < total, the LLM hasn't finished
  // presenting all readiness gates to the user — block auto-start.
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
      if (projectFile) {
        const projectContent = readFileSync(projectFile, "utf-8");
        const projectIds = parseMilestoneSequenceFromProject(projectContent);
        const manifestIds = Object.keys(manifest.milestones ?? {});
        const untracked = projectIds.filter(id => !manifestIds.includes(id));
        if (untracked.length > 0) {
          ctx.ui.notify(
            `Discussion manifest missing gates for: ${untracked.join(", ")}`,
            "warning",
          );
        }
      }
    } catch { /* malformed manifest — warn but don't block */ }
  }

  // Draft promotion cleanup: if a CONTEXT-DRAFT.md exists alongside the new
  // CONTEXT.md, delete the draft — it's been consumed by the discussion.
  try {
    const draftFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT-DRAFT");
    if (draftFile) unlinkSync(draftFile);
  } catch { /* non-fatal — stale draft doesn't break anything, CONTEXT.md wins */ }

  // Cleanup: remove discussion manifest after auto-start (only needed during discussion)
  try { unlinkSync(manifestPath); } catch { /* may not exist for single-milestone */ }

  pendingAutoStart = null;
  startAuto(ctx, pi, basePath, false, { step }).catch((err) => {
    ctx.ui.notify(`Auto-start failed: ${getErrorMessage(err)}`, "error");
    if (process.env.GSD_DEBUG) console.error('[gsd] auto start error:', err);
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
 */
function dispatchWorkflow(pi: ExtensionAPI, note: string, customType = "gsd-run"): void {
  const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(process.env.HOME ?? "~", ".pi", "GSD-WORKFLOW.md");
  const workflow = readFileSync(workflowPath, "utf-8");

  pi.sendMessage(
    {
      customType,
      content: `Read the following GSD workflow protocol and execute exactly.\n\n${workflow}\n\n## Your Task\n\n${note}`,
      display: false,
    },
    { triggerTurn: true },
  );
}

/**
 * Build the discuss-and-plan prompt for a new milestone.
 * Used by all three "new milestone" paths (first ever, no active, all complete).
 */
function buildDiscussPrompt(nextId: string, preamble: string, _basePath: string): string {
  const milestoneRel = `.gsd/milestones/${nextId}`;
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
 * Bootstrap a .gsd/ project from scratch for headless use.
 * Ensures git repo, .gsd/ structure, gitignore, and preferences all exist.
 */
function bootstrapGsdProject(basePath: string): void {
  if (!nativeIsRepo(basePath)) {
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
  // Ensure .gsd/ is bootstrapped
  bootstrapGsdProject(basePath);

  // Generate next milestone ID
  const existingIds = findMilestoneIds(basePath);
  const prefs = loadEffectiveGSDPreferences();
  const nextId = nextMilestoneId(existingIds, prefs?.preferences?.unique_milestone_ids ?? false);

  // Create milestone directory
  const milestoneDir = join(gsdRoot(basePath), "milestones", nextId, "slices");
  mkdirSync(milestoneDir, { recursive: true });

  // Build and dispatch the headless discuss prompt
  const prompt = buildHeadlessDiscussPrompt(nextId, seedContext, basePath);

  // Set pending auto start (auto-mode triggers on "Milestone X ready." via checkAutoStartAfterDiscuss)
  pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId };

  // Dispatch
  dispatchWorkflow(pi, prompt);
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
  options?: { rediscuss?: boolean },
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
  if (roadmapContent) {
    const roadmap = parseRoadmap(roadmapContent);
    for (const s of roadmap.slices) {
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

  // Guard: no active milestone
  if (!state.activeMilestone) {
    ctx.ui.notify("No active milestone. Run /gsd to create one first.", "warning");
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
      const structuredQuestionsAvailable = pi.getActiveTools().includes("ask_user_questions") ? "true" : "false";
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        milestoneId: mid, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
      });
      const seed = draftContent
        ? `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\n${draftContent}`
        : basePrompt;
      pendingAutoStart = { ctx, pi, basePath, milestoneId: mid, step: false };
      dispatchWorkflow(pi, seed, "gsd-discuss");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = pi.getActiveTools().includes("ask_user_questions") ? "true" : "false";
      pendingAutoStart = { ctx, pi, basePath, milestoneId: mid, step: false };
      dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        milestoneId: mid, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
      }), "gsd-discuss");
    } else if (choice === "skip_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneId(milestoneIds, uniqueMilestoneIds);
      pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId, step: false };
      dispatchWorkflow(pi, buildDiscussPrompt(nextId, `New milestone ${nextId}.`, basePath));
    }
    return;
  }

  // Guard: no roadmap yet
  const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent) {
    ctx.ui.notify("No roadmap yet for this milestone. Run /gsd to plan first.", "warning");
    return;
  }

  const roadmap = parseRoadmap(roadmapContent);
  const pendingSlices = roadmap.slices.filter(s => !s.done);

  if (pendingSlices.length === 0) {
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

    // If all pending slices are discussed, notify and exit instead of looping
    const allDiscussed = pendingSlices.every(s => discussedMap.get(s.id));
    if (allDiscussed) {
      ctx.ui.notify(
        `All ${pendingSlices.length} slices discussed. Run /gsd to start planning.`,
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

    const prompt = await buildDiscussSlicePrompt(mid, chosen.id, chosen.title, basePath, { rediscuss: isRediscuss });
    dispatchWorkflow(pi, prompt, "gsd-discuss");

    // Wait for the discuss session to finish, then loop back to the picker
    await ctx.waitForIdle();
    invalidateAllCaches();
  }
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
  } catch {
    // Non-fatal — self-heal should never block the wizard
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
    const nextId = nextMilestoneId(milestoneIds, uniqueMilestoneIds);
    pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId, step: stepMode };
    dispatchWorkflow(pi, buildDiscussPrompt(nextId,
      `New milestone ${nextId}.`,
      basePath
    ));
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
  if (!existsSync(gsdRoot(basePath))) {
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

    // No .gsd/ — run the project init wizard
    const result = await showProjectInit(ctx, pi, basePath, detection);
    if (!result.completed) return; // User cancelled

    // Init wizard bootstrapped .gsd/ — fall through to the normal flow below
    // which will detect "no milestones" and start the discuss prompt
  }

  // ── Ensure git repo exists — GSD needs it for worktree isolation ──────
  if (!nativeIsRepo(basePath)) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(basePath, mainBranch);
  }

  // ── Ensure .gitignore has baseline patterns ──────────────────────────
  ensureGitignore(basePath);
  untrackRuntimeFiles(basePath);

  // ── Self-heal stale runtime records from crashed auto-mode sessions ──
  selfHealRuntimeRecords(basePath, ctx);

  // Check for crash from previous auto-mode session
  const crashLock = readCrashLock(basePath);
  if (crashLock) {
    clearLock(basePath);

    // Bootstrap crash with zero completed units = no work was lost.
    // Auto-discard instead of prompting the user — this commonly happens
    // when the user exits during init wizard or discuss phase before any
    // real auto-mode work begins.
    const isBootstrapCrash = crashLock.unitType === "starting"
      && crashLock.unitId === "bootstrap"
      && crashLock.completedUnits === 0;

    if (!isBootstrapCrash) {
      const resume = await showNextAction(ctx, {
        title: "GSD — Interrupted Session Detected",
        summary: [formatCrashInfo(crashLock)],
        actions: [
          { id: "resume", label: "Resume with /gsd auto", description: "Pick up where it left off", recommended: true },
          { id: "continue", label: "Continue manually", description: "Open the wizard as normal" },
        ],
      });
      if (resume === "resume") {
        await startAuto(ctx, pi, basePath, false);
        return;
      }
    }
  }

  const state = await deriveState(basePath);

  if (!state.activeMilestone) {
    // Guard: if a discuss session is already in flight, don't re-inject the prompt.
    // Both /gsd and /gsd auto reach this branch when no milestone exists yet.
    // Without this guard, every subsequent /gsd call overwrites pendingAutoStart
    // and fires another dispatchWorkflow, resetting the conversation mid-interview.
    if (pendingAutoStart) {
      ctx.ui.notify("Discussion already in progress — answer the question above to continue.", "info");
      return;
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
        } catch { /* directory exists but unreadable — fall through to normal flow */ }
      }
    }

    const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
    const nextId = nextMilestoneId(milestoneIds, uniqueMilestoneIds);
    const isFirst = milestoneIds.length === 0;

    if (isFirst) {
      // First ever — skip wizard, just ask directly
      pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId, step: stepMode };
      dispatchWorkflow(pi, buildDiscussPrompt(nextId,
        `New project, milestone ${nextId}. Do NOT read or explore .gsd/ — it's empty scaffolding.`,
        basePath
      ));
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
        pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId, step: stepMode };
        dispatchWorkflow(pi, buildDiscussPrompt(nextId,
          `New milestone ${nextId}.`,
          basePath
        ));
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
      const nextId = nextMilestoneId(milestoneIds, uniqueMilestoneIds);

      pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId, step: stepMode };
      dispatchWorkflow(pi, buildDiscussPrompt(nextId,
        `New milestone ${nextId}.`,
        basePath
      ));
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
      const structuredQuestionsAvailable = pi.getActiveTools().includes("ask_user_questions") ? "true" : "false";
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
      });
      const seed = draftContent
        ? `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\n${draftContent}`
        : basePrompt;
      pendingAutoStart = { ctx, pi, basePath, milestoneId, step: stepMode };
      dispatchWorkflow(pi, seed, "gsd-discuss");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = pi.getActiveTools().includes("ask_user_questions") ? "true" : "false";
      pendingAutoStart = { ctx, pi, basePath, milestoneId, step: stepMode };
      dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
      }), "gsd-discuss");
    } else if (choice === "skip_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneId(milestoneIds, uniqueMilestoneIds);
      pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId, step: stepMode };
      dispatchWorkflow(pi, buildDiscussPrompt(nextId,
        `New milestone ${nextId}.`,
        basePath
      ));
    }
    return;
  }

  // ── No active slice ──────────────────────────────────────────────────
  if (!state.activeSlice) {
    const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const hasRoadmap = !!(roadmapFile && await loadFile(roadmapFile));

    if (!hasRoadmap) {
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
        pendingAutoStart = { ctx, pi, basePath, milestoneId, step: stepMode };
        const planMilestoneTemplates = [
          inlineTemplate("roadmap", "Roadmap"),
          inlineTemplate("plan", "Slice Plan"),
          inlineTemplate("task-plan", "Task Plan"),
          inlineTemplate("secrets-manifest", "Secrets Manifest"),
        ].join("\n\n---\n\n");
        const secretsOutputPath = relMilestoneFile(basePath, milestoneId, "SECRETS");
        dispatchWorkflow(pi, loadPrompt("guided-plan-milestone", {
          milestoneId, milestoneTitle, secretsOutputPath, inlinedTemplates: planMilestoneTemplates,
        }));
      } else if (choice === "discuss") {
        const discussMilestoneTemplates = inlineTemplate("context", "Context");
        const structuredQuestionsAvailable = pi.getActiveTools().includes("ask_user_questions") ? "true" : "false";
        dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
          milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates, structuredQuestionsAvailable,
          commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
        }));
      } else if (choice === "skip_milestone") {
        const milestoneIds = findMilestoneIds(basePath);
        const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
        const nextId = nextMilestoneId(milestoneIds, uniqueMilestoneIds);
        pendingAutoStart = { ctx, pi, basePath, milestoneId: nextId, step: stepMode };
        dispatchWorkflow(pi, buildDiscussPrompt(nextId,
          `New milestone ${nextId}.`,
          basePath
        ));
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
      dispatchWorkflow(pi, loadPrompt("guided-plan-slice", {
        milestoneId, sliceId, sliceTitle, inlinedTemplates: planSliceTemplates,
      }));
    } else if (choice === "discuss") {
      dispatchWorkflow(pi, await buildDiscussSlicePrompt(milestoneId, sliceId, sliceTitle, basePath, { rediscuss: hasContext }));
    } else if (choice === "research") {
      const researchTemplates = inlineTemplate("research", "Research");
      dispatchWorkflow(pi, loadPrompt("guided-research-slice", {
        milestoneId, sliceId, sliceTitle, inlinedTemplates: researchTemplates,
      }));
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
      dispatchWorkflow(pi, loadPrompt("guided-complete-slice", {
        workingDirectory: basePath, milestoneId, sliceId, sliceTitle, inlinedTemplates: completeSliceTemplates,
      }));
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
        dispatchWorkflow(pi, loadPrompt("guided-resume-task", {
          milestoneId, sliceId,
        }));
      } else {
        const executeTaskTemplates = inlineTemplate("task-summary", "Task Summary");
        dispatchWorkflow(pi, loadPrompt("guided-execute-task", {
          milestoneId, sliceId, taskId, taskTitle, inlinedTemplates: executeTaskTemplates,
        }));
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
