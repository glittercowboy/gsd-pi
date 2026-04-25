/**
 * GSD Queue Management — showQueue, reorder, add, and context builder.
 *
 * Self-contained queue UI extracted from guided-flow.ts.
 * Safe to run while auto-mode is executing — only writes to future milestone
 * directories (which auto-mode won't touch until it reaches them).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { showNextAction } from "../shared/tui.js";
import { setQueuePhaseActive } from "./index.js";
import { loadFile } from "./files.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import {
  gsdRoot, resolveMilestoneFile, resolveSliceFile,
  resolveGsdRootFile, relGsdRootFile, relSliceFile,
} from "./paths.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import { nativeAddPaths, nativeCommit } from "./native-git-bridge.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { loadQueueOrder, sortByQueueOrder, saveQueueOrder } from "./queue-order.js";
import { findMilestoneIds, nextMilestoneId } from "./milestone-ids.js";

// ─── Queue Entry Point ──────────────────────────────────────────────────────

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

  // ── Count pending milestones ────────────────────────────────────────
  const pendingMilestones = state.registry.filter(
    m => m.status === "pending" || m.status === "active",
  );
  const completeCount = state.registry.filter(m => m.status === "complete").length;
  const parkedCount = state.registry.filter(m => m.status === "parked").length;

  // ── If multiple pending milestones, show queue management hub ──────
  if (pendingMilestones.length > 1) {
    const summaryParts = [`${completeCount} complete, ${pendingMilestones.length} pending.`];
    if (parkedCount > 0) summaryParts.push(`${parkedCount} parked.`);

    const choice = await showNextAction(ctx, {
      title: "GSD — Queue Management",
      summary: summaryParts,
      actions: [
        {
          id: "reorder",
          label: "Reorder queue",
          description: `Change execution order of ${pendingMilestones.length} pending milestones.`,
          recommended: true,
        },
        {
          id: "add",
          label: "Add new work",
          description: "Queue new milestones via discussion.",
        },
      ],
      notYetMessage: "Run /gsd queue when ready.",
    });

    if (choice === "reorder") {
      await handleQueueReorder(ctx, basePath, state);
      return;
    }
    if (choice === "not_yet") return;
    // "add" falls through to existing queue-add logic below
  }

  // ── Existing queue-add flow ─────────────────────────────────────────
  await showQueueAdd(ctx, pi, basePath, state);
}

// ─── Reorder ────────────────────────────────────────────────────────────────

export async function handleQueueReorder(
  ctx: ExtensionCommandContext,
  basePath: string,
  state: Awaited<ReturnType<typeof deriveState>>,
): Promise<void> {
  const { showQueueReorder: showReorderUI } = await import("./queue-reorder-ui.js");

  const completed = state.registry
    .filter(m => m.status === "complete")
    .map(m => ({ id: m.id, title: m.title, dependsOn: m.dependsOn }));

  const pending = state.registry
    .filter(m => m.status !== "complete" && m.status !== "parked")
    .map(m => ({ id: m.id, title: m.title, dependsOn: m.dependsOn }));

  const result = await showReorderUI(ctx, completed, pending);
  if (!result) {
    ctx.ui.notify("Queue reorder cancelled.", "info");
    return;
  }

  // Save the new order
  saveQueueOrder(basePath, result.order);
  invalidateAllCaches();

  // Remove conflicting depends_on entries from CONTEXT.md files
  if (result.depsToRemove.length > 0) {
    removeDependsOnFromContextFiles(basePath, result.depsToRemove);
  }

  // Sync PROJECT.md milestone sequence table
  syncProjectMdSequence(basePath, state.registry, result.order);

  // Commit the change
  const filesToAdd = [".gsd/QUEUE-ORDER.json", ".gsd/PROJECT.md"];
  for (const r of result.depsToRemove) {
    filesToAdd.push(`.gsd/milestones/${r.milestone}/${r.milestone}-CONTEXT.md`);
  }
  try {
    nativeAddPaths(basePath, filesToAdd);
    nativeCommit(basePath, "docs: reorder queue");
  } catch {
    // Commit may fail if nothing changed or git hooks block — non-fatal
  }

  const depInfo = result.depsToRemove.length > 0
    ? ` (removed ${result.depsToRemove.length} depends_on)`
    : "";
  ctx.ui.notify(`Queue reordered: ${result.order.join(" → ")}${depInfo}`, "info");
}

// ─── Queue Add ──────────────────────────────────────────────────────────────

export async function showQueueAdd(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  basePath: string,
  state: Awaited<ReturnType<typeof deriveState>>,
): Promise<void> {
  const milestoneIds = findMilestoneIds(basePath);

  // ── Build existing milestones context for the prompt ────────────────
  const existingContext = await buildExistingMilestonesContext(basePath, milestoneIds, state);

  // ── Determine next milestone ID ─────────────────────────────────────
  // Note: the LLM will use the gsd_milestone_generate_id tool to get IDs
  // at creation time, but we still mention the next ID in the preamble
  // for context about where the sequence is.
  const uniqueEnabled = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
  const nextId = nextMilestoneId(milestoneIds, uniqueEnabled);

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
  // Activate the queue phase so the write-gate applies to CONTEXT.md writes
  setQueuePhaseActive(true);

  const queueInlinedTemplates = inlineTemplate("context", "Context");
  const prompt = loadPrompt("queue", {
    preamble,
    existingMilestonesContext: existingContext,
    inlinedTemplates: queueInlinedTemplates,
    commitInstruction: "Do not commit planning artifacts — .gsd/ is managed externally.",
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

// ─── Existing Milestones Context Builder ────────────────────────────────────

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

  // For each milestone, include context and status.
  // Completed milestones get a compact summary line only — loading their full
  // CONTEXT.md + SUMMARY.md files is expensive and triggers 429 rate limits on
  // projects with many completed milestones (#2379).
  for (const mid of milestoneIds) {
    const registryEntry = state.registry.find(m => m.id === mid);
    const status = registryEntry?.status ?? "unknown";
    const title = registryEntry?.title ?? mid;

    // Completed milestones: emit a one-liner — the LLM only needs to know
    // they exist for dedup/dependency purposes, not their full content.
    if (status === "complete") {
      sections.push(`### ${mid}: ${title}\n**Status:** complete`);
      continue;
    }

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

    // For active/pending/parked milestones, include the roadmap if it exists
    // (shows what's planned but not yet built)
    if (status === "active" || status === "pending" || status === "parked") {
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

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Remove specific depends_on entries from milestone CONTEXT.md frontmatter.
 */
function removeDependsOnFromContextFiles(
  basePath: string,
  depsToRemove: Array<{ milestone: string; dep: string }>,
): void {
  // Group removals by milestone
  const byMilestone = new Map<string, string[]>();
  for (const { milestone, dep } of depsToRemove) {
    const existing = byMilestone.get(milestone) ?? [];
    existing.push(dep);
    byMilestone.set(milestone, existing);
  }

  for (const [mid, depsToRemoveForMid] of byMilestone) {
    const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
    if (!contextFile || !existsSync(contextFile)) continue;

    const content = readFileSync(contextFile, "utf-8");

    // Parse frontmatter
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("---")) continue;
    const afterFirst = trimmed.indexOf("\n");
    if (afterFirst === -1) continue;
    const rest = trimmed.slice(afterFirst + 1);
    const endIdx = rest.indexOf("\n---");
    if (endIdx === -1) continue;

    const fmText = rest.slice(0, endIdx);
    const body = rest.slice(endIdx + 4);

    // Parse depends_on line(s)
    const fmLines = fmText.split("\n");
    const removeSet = new Set(depsToRemoveForMid.map(d => d.toUpperCase()));

    // Handle inline format: depends_on: [M009, M010]
    const inlineMatch = fmLines.findIndex(l => /^depends_on:\s*\[/.test(l));
    if (inlineMatch >= 0) {
      const line = fmLines[inlineMatch];
      const inner = line.match(/\[([^\]]*)\]/);
      if (inner) {
        const remaining = inner[1]
          .split(",")
          .map(s => s.trim())
          .filter(s => s && !removeSet.has(s.toUpperCase()));
        if (remaining.length === 0) {
          fmLines.splice(inlineMatch, 1);
        } else {
          fmLines[inlineMatch] = `depends_on: [${remaining.join(", ")}]`;
        }
      }
    } else {
      // Handle multi-line format
      const keyIdx = fmLines.findIndex(l => /^depends_on:\s*$/.test(l));
      if (keyIdx >= 0) {
        let end = keyIdx + 1;
        while (end < fmLines.length && /^\s+-\s/.test(fmLines[end])) {
          const val = fmLines[end].replace(/^\s+-\s*/, "").trim().toUpperCase();
          if (removeSet.has(val)) {
            fmLines.splice(end, 1);
          } else {
            end++;
          }
        }
        if (end === keyIdx + 1 || (end <= fmLines.length && !/^\s+-\s/.test(fmLines[keyIdx + 1] ?? ""))) {
          fmLines.splice(keyIdx, 1);
        }
      }
    }

    // Rebuild file
    const newFm = fmLines.filter(l => l !== undefined).join("\n");
    const newContent = newFm.trim()
      ? `---\n${newFm}\n---${body}`
      : body.replace(/^\n+/, "");
    writeFileSync(contextFile, newContent, "utf-8");
  }
}

function syncProjectMdSequence(
  basePath: string,
  registry: Array<{ id: string; title: string; status: string }>,
  newOrder: string[],
): void {
  const projectPath = resolveGsdRootFile(basePath, "PROJECT");
  if (!projectPath || !existsSync(projectPath)) return;

  const content = readFileSync(projectPath, "utf-8");
  const lines = content.split("\n");

  const headerIdx = lines.findIndex(l => /^##\s+Milestone Sequence/.test(l));
  if (headerIdx < 0) return;

  let tableStart = headerIdx + 1;
  while (tableStart < lines.length && !lines[tableStart].startsWith("|")) tableStart++;
  if (tableStart >= lines.length) return;

  let tableEnd = tableStart + 1;
  while (tableEnd < lines.length && lines[tableEnd].startsWith("|")) tableEnd++;

  const registryMap = new Map(registry.map(m => [m.id, m]));
  const completedSet = new Set(registry.filter(m => m.status === "complete").map(m => m.id));

  const newRows: string[] = [];
  for (const m of registry) {
    if (m.status === "complete") {
      newRows.push(`| ${m.id} | ${m.title} | ✅ Complete |`);
    }
  }
  let isFirst = true;
  for (const id of newOrder) {
    if (completedSet.has(id)) continue;
    const m = registryMap.get(id);
    if (!m) continue;
    const status = isFirst ? "📋 Next" : "📋 Queued";
    newRows.push(`| ${m.id} | ${m.title} | ${status} |`);
    isFirst = false;
  }

  const headerLine = lines[tableStart];
  const separatorLine = lines[tableStart + 1];
  const newTable = [headerLine, separatorLine, ...newRows];
  lines.splice(tableStart, tableEnd - tableStart, ...newTable);
  // Atomic write: tmp+rename avoids a torn PROJECT.md appearing dirty in
  // another worktree's working tree during a concurrent /gsd auto merge.
  atomicWriteSync(projectPath, lines.join("\n"), "utf-8");
}
