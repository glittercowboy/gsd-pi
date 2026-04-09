/**
 * Direct phase dispatch — handles manual /gsd dispatch commands.
 * Resolves phase name → unit type + prompt, creates a session, and sends the message.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@gsd/pi-coding-agent";

import { deriveState } from "./state.js";
import { loadFile } from "./files.js";
import { isDbAvailable, getMilestoneSlices } from "./gsd-db.js";
import { parseRoadmap } from "./parsers-legacy.js";
import {
  resolveMilestoneFile, resolveSliceFile, relSliceFile,
} from "./paths.js";
import {
  buildResearchSlicePrompt,
  buildResearchMilestonePrompt,
  buildPlanSlicePrompt,
  buildPlanMilestonePrompt,
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildCompleteMilestonePrompt,
  buildReassessRoadmapPrompt,
  buildRunUatPrompt,
  buildReplanSlicePrompt,
} from "./auto-prompts.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { pauseAuto } from "./auto.js";

export async function dispatchDirectPhase(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  phase: string,
  base: string,
): Promise<void> {
  const state = await deriveState(base);
  const mid = state.activeMilestone?.id;
  const midTitle = state.activeMilestone?.title ?? "";

  if (!mid) {
    ctx.ui.notify("Cannot dispatch: no active milestone.", "warning");
    return;
  }

  const normalized = phase.toLowerCase();
  let unitType: string;
  let unitId: string;
  let prompt: string;

  switch (normalized) {
    case "research":
    case "research-milestone":
    case "research-slice": {
      const isSlice = normalized === "research-slice" || (normalized === "research" && state.phase !== "pre-planning");
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch research-slice: no active slice.", "warning");
          return;
        }

        // When require_slice_discussion is enabled, pause auto-mode before
        // each new slice so the user can discuss requirements first (#789).
        const sliceContextFile = resolveSliceFile(base, mid, sid, "CONTEXT");
        const requireDiscussion = loadEffectiveGSDPreferences()?.preferences?.phases?.require_slice_discussion;
        if (requireDiscussion && !sliceContextFile) {
          ctx.ui.notify(
            `Slice ${sid} requires discussion before planning. Run /gsd discuss to discuss this slice, then /gsd auto to resume.`,
            "info",
          );
          await pauseAuto(ctx, pi);
          return;
        }

        unitType = "research-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildResearchSlicePrompt(mid, midTitle, sid, sTitle, base);
      } else {
        unitType = "research-milestone";
        unitId = mid;
        prompt = await buildResearchMilestonePrompt(mid, midTitle, base);
      }
      break;
    }

    case "plan":
    case "plan-milestone":
    case "plan-slice": {
      const isSlice = normalized === "plan-slice" || (normalized === "plan" && state.phase !== "pre-planning");
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch plan-slice: no active slice.", "warning");
          return;
        }
        unitType = "plan-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildPlanSlicePrompt(mid, midTitle, sid, sTitle, base);
      } else {
        unitType = "plan-milestone";
        unitId = mid;
        prompt = await buildPlanMilestonePrompt(mid, midTitle, base);
      }
      break;
    }

    case "execute":
    case "execute-task": {
      const sid = state.activeSlice?.id;
      const sTitle = state.activeSlice?.title ?? "";
      const tid = state.activeTask?.id;
      const tTitle = state.activeTask?.title ?? "";
      if (!sid) {
        ctx.ui.notify("Cannot dispatch execute-task: no active slice.", "warning");
        return;
      }
      if (!tid) {
        ctx.ui.notify("Cannot dispatch execute-task: no active task.", "warning");
        return;
      }
      unitType = "execute-task";
      unitId = `${mid}/${sid}/${tid}`;
      prompt = await buildExecuteTaskPrompt(mid, sid, sTitle, tid, tTitle, base);
      break;
    }

    case "complete":
    case "complete-slice":
    case "complete-milestone": {
      const isSlice = normalized === "complete-slice" || (normalized === "complete" && state.phase === "summarizing");
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch complete-slice: no active slice.", "warning");
          return;
        }
        unitType = "complete-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildCompleteSlicePrompt(mid, midTitle, sid, sTitle, base);
      } else {
        unitType = "complete-milestone";
        unitId = mid;
        prompt = await buildCompleteMilestonePrompt(mid, midTitle, base);
      }
      break;
    }

    case "reassess":
    case "reassess-roadmap": {
      // DB primary path — get completed slices, fall back to file parsing when DB has no data
      let completedSliceIds: string[] = [];
      if (isDbAvailable()) {
        completedSliceIds = getMilestoneSlices(mid).filter(s => s.status === "complete").map(s => s.id);
      }
      if (completedSliceIds.length === 0) {
        // File-based fallback: parse roadmap checkboxes
        const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
        if (roadmapPath) {
          const roadmapContent = await loadFile(roadmapPath);
          if (roadmapContent) {
            completedSliceIds = parseRoadmap(roadmapContent).slices.filter(s => s.done).map(s => s.id);
          }
        }
      }
      if (completedSliceIds.length === 0) {
        ctx.ui.notify("Cannot dispatch reassess-roadmap: no completed slices.", "warning");
        return;
      }
      const completedSliceId = completedSliceIds[completedSliceIds.length - 1];
      unitType = "reassess-roadmap";
      unitId = `${mid}/${completedSliceId}`;
      prompt = await buildReassessRoadmapPrompt(mid, midTitle, completedSliceId, base);
      break;
    }

    case "uat":
    case "run-uat": {
      // UAT targets the most recently completed slice, not the active (next
      // incomplete) slice. After slice completion, state.activeSlice advances
      // to the next incomplete slice, so we find the last done slice from the
      // roadmap instead (#1693).
      let uatCompletedSliceIds: string[] = [];
      if (isDbAvailable()) {
        uatCompletedSliceIds = getMilestoneSlices(mid).filter(s => s.status === "complete").map(s => s.id);
      }
      if (uatCompletedSliceIds.length === 0) {
        // File-based fallback: parse roadmap checkboxes
        const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
        if (roadmapPath) {
          const roadmapContent = await loadFile(roadmapPath);
          if (roadmapContent) {
            uatCompletedSliceIds = parseRoadmap(roadmapContent).slices.filter(s => s.done).map(s => s.id);
          }
        }
      }
      if (uatCompletedSliceIds.length === 0) {
        ctx.ui.notify("Cannot dispatch run-uat: no completed slices.", "warning");
        return;
      }
      const sid = uatCompletedSliceIds[uatCompletedSliceIds.length - 1];
      const uatFile = resolveSliceFile(base, mid, sid, "UAT");
      if (!uatFile) {
        ctx.ui.notify("Cannot dispatch run-uat: no UAT file found.", "warning");
        return;
      }
      const uatContent = await loadFile(uatFile);
      if (!uatContent) {
        ctx.ui.notify("Cannot dispatch run-uat: UAT file is empty.", "warning");
        return;
      }
      const uatPath = relSliceFile(base, mid, sid, "UAT");
      unitType = "run-uat";
      unitId = `${mid}/${sid}`;
      prompt = await buildRunUatPrompt(mid, sid, uatPath, uatContent, base);
      break;
    }

    case "replan":
    case "replan-slice": {
      const sid = state.activeSlice?.id;
      const sTitle = state.activeSlice?.title ?? "";
      if (!sid) {
        ctx.ui.notify("Cannot dispatch replan-slice: no active slice.", "warning");
        return;
      }
      unitType = "replan-slice";
      unitId = `${mid}/${sid}`;
      prompt = await buildReplanSlicePrompt(mid, midTitle, sid, sTitle, base);
      break;
    }

    default:
      ctx.ui.notify(
        `Unknown phase "${phase}". Valid phases: research, plan, execute, complete, reassess, uat, replan.`,
        "warning",
      );
      return;
  }

  ctx.ui.notify(`Dispatching ${unitType} for ${unitId}...`, "info");
  const result = await ctx.newSession();
  if (result.cancelled) {
    ctx.ui.notify("Session creation cancelled.", "warning");
    return;
  }
  pi.sendMessage(
    { customType: "gsd-dispatch", content: prompt, display: false },
    { triggerTurn: true },
  );
}
