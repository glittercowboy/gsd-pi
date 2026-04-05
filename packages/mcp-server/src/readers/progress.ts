/**
 * gsd_progress — active milestone/slice/task, phase, completion counts.
 */

import { join } from 'node:path';
import { gsdDir, readFileSafe, listDirs, fileExists } from './shared.js';

interface SliceStatus {
  id: string;
  title: string;
  done: boolean;
  risk?: string;
}

interface ProgressResult {
  activeMilestone: string | null;
  phase: string;
  slices: { total: number; complete: number; items: SliceStatus[] };
  activeSlice: string | null;
  activeTask: string | null;
  blockers: string[];
  nextAction: string;
}

export async function readProgress(projectDir: string): Promise<ProgressResult> {
  const base = gsdDir(projectDir);
  const stateContent = await readFileSafe(join(base, 'STATE.md'));

  // Parse STATE.md for active milestone
  let activeMilestone: string | null = null;
  let phase = 'unknown';
  let activeSlice: string | null = null;
  let activeTask: string | null = null;
  const blockers: string[] = [];

  if (stateContent) {
    const midMatch = stateContent.match(/active.milestone[:\s]+(\S+)/i);
    if (midMatch) activeMilestone = midMatch[1];

    const phaseMatch = stateContent.match(/phase[:\s]+(\S+)/i);
    if (phaseMatch) phase = phaseMatch[1];

    const sliceMatch = stateContent.match(/active.slice[:\s]+(\S+)/i);
    if (sliceMatch) activeSlice = sliceMatch[1];

    const taskMatch = stateContent.match(/active.task[:\s]+(\S+)/i);
    if (taskMatch) activeTask = taskMatch[1];

    const blockerSection = stateContent.match(/## Blockers?\n([\s\S]*?)(?=\n##|$)/i);
    if (blockerSection) {
      const lines = blockerSection[1].split('\n').filter(l => l.trim().startsWith('-'));
      for (const l of lines) blockers.push(l.replace(/^-\s*/, '').trim());
    }
  }

  // If no STATE.md, try to infer from milestone dirs
  if (!activeMilestone) {
    const milestones = await listDirs(join(base, 'milestones'));
    if (milestones.length > 0) {
      // Pick the first non-completed milestone
      for (const mid of milestones.sort()) {
        const hasSummary = await fileExists(join(base, 'milestones', mid, `${mid}-SUMMARY.md`));
        if (!hasSummary) {
          activeMilestone = mid;
          break;
        }
      }
      if (!activeMilestone) activeMilestone = milestones[milestones.length - 1];
    }
  }

  // Parse roadmap for slice status
  const slices: SliceStatus[] = [];
  if (activeMilestone) {
    const roadmap = await readFileSafe(
      join(base, 'milestones', activeMilestone, `${activeMilestone}-ROADMAP.md`),
    );
    if (roadmap) {
      const sliceRegex = /- \[([ x])\] \*\*(\w+): ([^*]+)\*\*\s*(?:`risk:(\w+)`)?/g;
      let match;
      while ((match = sliceRegex.exec(roadmap)) !== null) {
        slices.push({
          id: match[2],
          title: match[3].trim(),
          done: match[1] === 'x',
          risk: match[4] || undefined,
        });
      }
    }
  }

  const complete = slices.filter(s => s.done).length;
  let nextAction = 'No project state found. Run /gsd to initialize.';
  if (activeMilestone && slices.length === 0) {
    nextAction = `Milestone ${activeMilestone} needs planning.`;
  } else if (activeTask) {
    nextAction = `Continue ${activeTask} in ${activeSlice ?? 'current slice'}.`;
  } else if (activeSlice) {
    nextAction = `Continue ${activeSlice} in ${activeMilestone}.`;
  } else if (complete < slices.length) {
    const next = slices.find(s => !s.done);
    nextAction = next ? `Start ${next.id}: ${next.title}` : 'Determine next slice.';
  } else if (slices.length > 0 && complete === slices.length) {
    nextAction = `All slices complete. Validate and close ${activeMilestone}.`;
  }

  return {
    activeMilestone,
    phase,
    slices: { total: slices.length, complete, items: slices },
    activeSlice,
    activeTask,
    blockers,
    nextAction,
  };
}
