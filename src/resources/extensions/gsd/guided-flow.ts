/**
 * GSD Guided Flow — Smart Entry Wizard
 *
 * One function: showSmartEntry(). Reads state from disk, shows a contextual
 * wizard via showNextAction(), and dispatches through GSD-WORKFLOW.md.
 * No execution state, no hooks, no tools — the LLM does the rest.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { showNextAction } from "../shared/next-action-ui.js";
import { loadFile, parseRoadmap } from "./files.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import { deriveState } from "./state.js";
import { startAuto } from "./auto.js";
import { readCrashLock, clearLock, formatCrashInfo } from "./crash-recovery.js";
import { listUnitRuntimeRecords, clearUnitRuntimeRecord } from "./unit-runtime.js";
import { resolveExpectedArtifactPath } from "./auto.js";
import {
  gsdRoot, milestonesDir, resolveMilestoneFile, resolveMilestonePath,
  resolveSliceFile, resolveSlicePath, resolveGsdRootFile, relGsdRootFile,
  relMilestoneFile, relSliceFile, relSlicePath,
} from "./paths.js";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { ensureGitignore, ensurePreferences, untrackRuntimeFiles } from "./gitignore.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { showConfirm } from "../shared/confirm-ui.js";

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

  // Gate 1: Primary milestone must have CONTEXT.md
  const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
  if (!contextFile) return false; // no context yet — keep waiting

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
          const hasDir = existsSync(join(basePath, ".gsd", "milestones", id));
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
  const manifestPath = join(basePath, ".gsd", "DISCUSSION-MANIFEST.json");
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
  startAuto(ctx, pi, basePath, false, { step }).catch(() => {});
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
  });
}

export function findMilestoneIds(basePath: string): string[] {
  const dir = milestonesDir(basePath);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const match = d.name.match(/^(M\d+(?:-[a-z0-9]{6})?)/);
        return match ? match[1] : d.name;
      })
      .sort(milestoneIdSort);
  } catch {
    return [];
  }
}

// ─── Milestone ID primitives ────────────────────────────────────────────────

/** Matches both classic `M001` and unique `M001-abc123` formats (anchored). */
export const MILESTONE_ID_RE = /^M\d{3}(?:-[a-z0-9]{6})?$/;

/** Extract the trailing sequential number from a milestone ID. Returns 0 for non-matches. */
export function extractMilestoneSeq(id: string): number {
  const m = id.match(/^M(\d{3})(?:-[a-z0-9]{6})?$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Structured parse of a milestone ID into optional suffix and sequence number. */
export function parseMilestoneId(id: string): { suffix?: string; num: number } {
  const m = id.match(/^M(\d{3})(?:-([a-z0-9]{6}))?$/);
  if (!m) return { num: 0 };
  return {
    ...(m[2] ? { suffix: m[2] } : {}),
    num: parseInt(m[1], 10),
  };
}

/** Comparator for sorting milestone IDs by sequential number. */
export function milestoneIdSort(a: string, b: string): number {
  return extractMilestoneSeq(a) - extractMilestoneSeq(b);
}

/** Generate a 6-char lowercase `[a-z0-9]` suffix using crypto.randomInt(). */
export function generateMilestoneSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += chars[randomInt(36)];
  }
  return result;
}

/** Return the highest numeric suffix among milestone IDs (0 when the list is empty or has no numeric IDs). */
export function maxMilestoneNum(milestoneIds: string[]): number {
  return milestoneIds.reduce((max, id) => {
    const num = extractMilestoneSeq(id);
    return num > max ? num : max;
  }, 0);
}

/** Derive the next milestone ID from existing IDs using max-based approach to avoid collisions after deletions. */
export function nextMilestoneId(milestoneIds: string[], uniqueEnabled?: boolean): string {
  const seq = String(maxMilestoneNum(milestoneIds) + 1).padStart(3, "0");
  if (uniqueEnabled) {
    return `M${seq}-${generateMilestoneSuffix()}`;
  }
  return `M${seq}`;
}

// ─── Queue ─────────────────────────────────────────────────────────────────────

/**
 * Queue future milestones via conversational intake.
 *
 * Safe to run while auto-mode is executing — only writes to future milestone
 * directories (which auto-mode won't touch until it reaches them) and appends
 * to project.md / queue.md.
 *
 * The flow:
 * 1. Build context about all existing milestones (complete, active, pending)
 * 2. Dispatch the queue prompt — LLM discusses with the user, assesses scope
 * 3. LLM writes CONTEXT.md files for new milestones (no roadmaps — JIT)
 * 4. Auto-mode picks them up naturally when it advances past current work
 *
 * Root durable artifacts use uppercase names like PROJECT.md and QUEUE.md.
 */
export async function showQueue(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
): Promise<void> {
  // ── Ensure .gsd/ exists ─────────────────────────────────────────────
  const gsd = gsdRoot(basePath);
  if (!existsSync(gsd)) {
    ctx.ui.notify("No GSD project found. Run /gsd to start one first.", "warning");
    return;
  }

  const state = await deriveState(basePath);
  const milestoneIds = findMilestoneIds(basePath);

  if (milestoneIds.length === 0) {
    ctx.ui.notify("No milestones exist yet. Run /gsd to create the first one.", "warning");
    return;
  }

  // ── Build existing milestones context for the prompt ────────────────
  const existingContext = await buildExistingMilestonesContext(basePath, milestoneIds, state);

  // ── Determine next milestone ID ─────────────────────────────────────
  const uniqueEnabled = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
  const nextId = nextMilestoneId(milestoneIds, uniqueEnabled);
  const nextIdPlus1 = nextMilestoneId([...milestoneIds, nextId], uniqueEnabled);

  // ── Build preamble ──────────────────────────────────────────────────
  const activePart = state.activeMilestone
    ? `Currently executing: ${state.activeMilestone.id} — ${state.activeMilestone.title} (phase: ${state.phase}).`
    : "No milestone currently active.";

  const pendingCount = state.registry.filter(m => m.status === "pending").length;
  const completeCount = state.registry.filter(m => m.status === "complete").length;

  const preamble = [
    `Queuing new work onto an existing GSD project.`,
    activePart,
    `${completeCount} milestone(s) complete, ${pendingCount} pending.`,
    `Next available milestone ID: ${nextId}.`,
  ].join(" ");

  // ── Dispatch the queue prompt ───────────────────────────────────────
  const queueInlinedTemplates = inlineTemplate("context", "Context");
  const prompt = loadPrompt("queue", {
    preamble,
    nextId,
    nextIdPlus1,
    existingMilestonesContext: existingContext,
    inlinedTemplates: queueInlinedTemplates,
  });

  pi.sendMessage(
    {
      customType: "gsd-queue",
      content: prompt,
      display: false,
    },
    { triggerTurn: true },
  );
}

/**
 * Build a context block describing all existing milestones for the queue prompt.
 * Gives the LLM enough information to dedup, sequence, and dependency-check.
 */
export async function buildExistingMilestonesContext(
  basePath: string,
  milestoneIds: string[],
  state: import("./types.js").GSDState,
): Promise<string> {
  const sections: string[] = [];

  // Include PROJECT.md if it exists — it has the milestone sequence and project description
  const projectPath = resolveGsdRootFile(basePath, "PROJECT");
  if (existsSync(projectPath)) {
    const projectContent = await loadFile(projectPath);
    if (projectContent) {
      sections.push(`### Project Overview\nSource: \`${relGsdRootFile("PROJECT")}\`\n\n${projectContent.trim()}`);
    }
  }

  // Include DECISIONS.md if it exists — architectural decisions inform new milestone scoping
  const decisionsPath = resolveGsdRootFile(basePath, "DECISIONS");
  if (existsSync(decisionsPath)) {
    const decisionsContent = await loadFile(decisionsPath);
    if (decisionsContent) {
      sections.push(`### Decisions Register\nSource: \`${relGsdRootFile("DECISIONS")}\`\n\n${decisionsContent.trim()}`);
    }
  }

  // For each milestone, include context and status
  for (const mid of milestoneIds) {
    const registryEntry = state.registry.find(m => m.id === mid);
    const status = registryEntry?.status ?? "unknown";
    const title = registryEntry?.title ?? mid;

    const parts: string[] = [];
    parts.push(`### ${mid}: ${title}\n**Status:** ${status}`);

    // Include context file — this is the primary content for understanding scope
    const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
    if (contextFile) {
      const content = await loadFile(contextFile);
      if (content) {
        parts.push(`\n**Context:**\n${content.trim()}`);
      }
    } else {
      // No full CONTEXT.md — check for CONTEXT-DRAFT.md (draft seed from prior discussion)
      const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
      if (draftFile) {
        const draftContent = await loadFile(draftFile);
        if (draftContent) {
          parts.push(`\n**Draft context available:**\n${draftContent.trim()}`);
        }
      }
    }

    // For completed milestones, include the summary if it exists
    if (status === "complete") {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile) {
        const content = await loadFile(summaryFile);
        if (content) {
          parts.push(`\n**Summary:**\n${content.trim()}`);
        }
      }
    }

    // For active/pending milestones, include the roadmap if it exists
    // (shows what's planned but not yet built)
    if (status === "active" || status === "pending") {
      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
      if (roadmapFile) {
        const content = await loadFile(roadmapFile);
        if (content) {
          parts.push(`\n**Roadmap:**\n${content.trim()}`);
        }
      }
    }

    sections.push(parts.join("\n"));
  }

  // Include queue log if it exists — shows what's been queued before
  const queuePath = resolveGsdRootFile(basePath, "QUEUE");
  if (existsSync(queuePath)) {
    const queueContent = await loadFile(queuePath);
    if (queueContent) {
      sections.push(`### Previous Queue Entries\nSource: \`${relGsdRootFile("QUEUE")}\`\n\n${queueContent.trim()}`);
    }
  }

  return sections.join("\n\n---\n\n");
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

  const inlinedTemplates = inlineTemplate("slice-context", "Slice Context");
  return loadPrompt("guided-discuss-slice", {
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    inlinedContext,
    sliceDirPath,
    contextPath: sliceContextPath,
    projectRoot: base,
    inlinedTemplates,
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
  if (!existsSync(join(basePath, ".gsd"))) {
    ctx.ui.notify("No GSD project found. Run /gsd to start one first.", "warning");
    return;
  }

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

    const choice = await showNextAction(ctx as any, {
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
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        milestoneId: mid, milestoneTitle, inlinedTemplates: discussMilestoneTemplates,
      });
      const seed = draftContent
        ? `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\n${draftContent}`
        : basePrompt;
      pendingAutoStart = { ctx, pi, basePath, milestoneId: mid, step: false };
      dispatchWorkflow(pi, seed, "gsd-discuss");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      pendingAutoStart = { ctx, pi, basePath, milestoneId: mid, step: false };
      dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        milestoneId: mid, milestoneTitle, inlinedTemplates: discussMilestoneTemplates,
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
    const actions = pendingSlices.map((s, i) => ({
      id: s.id,
      label: `${s.id}: ${s.title}`,
      description: state.activeSlice?.id === s.id ? "active slice" : "upcoming",
      recommended: i === 0,
    }));

    const choice = await showNextAction(ctx as any, {
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

    const prompt = await buildDiscussSlicePrompt(mid, chosen.id, chosen.title, basePath);
    dispatchWorkflow(pi, prompt, "gsd-discuss");

    // Wait for the discuss session to finish, then loop back to the picker
    await ctx.waitForIdle();
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

export async function showSmartEntry(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  options?: { step?: boolean },
): Promise<void> {
  const stepMode = options?.step;

  // ── Ensure git repo exists — GSD needs it for worktree isolation ──────
  try {
    execSync("git rev-parse --git-dir", { cwd: basePath, stdio: "pipe" });
  } catch {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    execFileSync("git", ["init", "-b", mainBranch], { cwd: basePath, stdio: "pipe" });
  }

  // ── Ensure .gitignore has baseline patterns ──────────────────────────
  ensureGitignore(basePath);
  untrackRuntimeFiles(basePath);

  // ── No GSD project OR no milestone → Create first/next milestone ────
  if (!existsSync(join(basePath, ".gsd"))) {
    // Bootstrap .gsd/ silently — the user wants a milestone, not to "init"
    const gsd = gsdRoot(basePath);
    mkdirSync(join(gsd, "milestones"), { recursive: true });

    // ── Create PREFERENCES.md template ────────────────────────────────
    ensurePreferences(basePath);
    try {
      execSync("git add -A .gsd .gitignore && git commit -m 'chore: init gsd'", {
        cwd: basePath,
        stdio: "pipe",
      });
    } catch {
      // nothing to commit — that's fine
    }
  }

  // ── Self-heal stale runtime records from crashed auto-mode sessions ──
  selfHealRuntimeRecords(basePath, ctx);

  // Check for crash from previous auto-mode session
  const crashLock = readCrashLock(basePath);
  if (crashLock) {
    clearLock(basePath);
    const resume = await showNextAction(ctx as any, {
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
      const choice = await showNextAction(ctx as any, {
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
    const choice = await showNextAction(ctx as any, {
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

    const choice = await showNextAction(ctx as any, {
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
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates,
      });
      const seed = draftContent
        ? `${basePrompt}\n\n## Prior Discussion (Draft Seed)\n\n${draftContent}`
        : basePrompt;
      pendingAutoStart = { ctx, pi, basePath, milestoneId, step: stepMode };
      dispatchWorkflow(pi, seed, "gsd-discuss");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      pendingAutoStart = { ctx, pi, basePath, milestoneId, step: stepMode };
      dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates,
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

      const choice = await showNextAction(ctx as any, {
        title: `GSD — ${milestoneId}: ${milestoneTitle}`,
        summary: [hasContext ? "Context captured. Ready to create roadmap." : "New milestone — no roadmap yet."],
        actions,
        notYetMessage: "Run /gsd when ready.",
      });

      if (choice === "plan") {
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
        dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
          milestoneId, milestoneTitle, inlinedTemplates: discussMilestoneTemplates,
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
        const mDir = resolveMilestonePath(basePath, milestoneId);
        if (!mDir) return;
        const confirmed = await showConfirm(ctx as any, {
          title: "Discard milestone?",
          message: `This will permanently delete ${milestoneId} and all its contents.`,
          confirmLabel: "Discard",
          declineLabel: "Cancel",
        });
        if (confirmed) {
          rmSync(mDir, { recursive: true, force: true });
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
      ];

      const choice = await showNextAction(ctx as any, {
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
    ];

    const summaryParts = [];
    if (hasContext) summaryParts.push("context ✓");
    if (hasResearch) summaryParts.push("research ✓");
    const summaryLine = summaryParts.length > 0
      ? `${sliceId}: ${sliceTitle} (${summaryParts.join(", ")})`
      : `${sliceId}: ${sliceTitle} — ready for planning.`;

    const choice = await showNextAction(ctx as any, {
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
      dispatchWorkflow(pi, await buildDiscussSlicePrompt(milestoneId, sliceId, sliceTitle, basePath));
    } else if (choice === "research") {
      const researchTemplates = inlineTemplate("research", "Research");
      dispatchWorkflow(pi, loadPrompt("guided-research-slice", {
        milestoneId, sliceId, sliceTitle, inlinedTemplates: researchTemplates,
      }));
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
    }
    return;
  }

  // ── All tasks done → Complete slice ──────────────────────────────────
  if (state.phase === "summarizing") {
    const choice = await showNextAction(ctx as any, {
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
      ],
      notYetMessage: "Run /gsd when ready.",
    });

    if (choice === "complete") {
      const completeSliceTemplates = [
        inlineTemplate("slice-summary", "Slice Summary"),
        inlineTemplate("uat", "UAT"),
      ].join("\n\n---\n\n");
      dispatchWorkflow(pi, loadPrompt("guided-complete-slice", {
        milestoneId, sliceId, sliceTitle, inlinedTemplates: completeSliceTemplates,
      }));
    } else if (choice === "status") {
      const { fireStatusViaCommand } = await import("./commands.js");
      await fireStatusViaCommand(ctx);
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

    const choice = await showNextAction(ctx as any, {
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
    }
    return;
  }

  // ── Fallback: show status ────────────────────────────────────────────
  const { fireStatusViaCommand } = await import("./commands.js");
  await fireStatusViaCommand(ctx);
}
