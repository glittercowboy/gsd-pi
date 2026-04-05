/**
 * gsd_roadmap — full project structure with status, risk, and dependencies.
 */

import { join } from 'node:path';
import { gsdDir, readFileSafe, listDirs, fileExists } from './shared.js';

interface TaskEntry {
  id: string;
  title: string;
  done: boolean;
  estimate?: string;
}

interface SliceEntry {
  id: string;
  title: string;
  done: boolean;
  risk?: string;
  depends?: string[];
  tasks: TaskEntry[];
}

interface MilestoneEntry {
  id: string;
  title: string;
  complete: boolean;
  slices: SliceEntry[];
}

interface RoadmapResult {
  milestones: MilestoneEntry[];
}

export async function readRoadmap(projectDir: string): Promise<RoadmapResult> {
  const base = gsdDir(projectDir);
  const milestoneIds = await listDirs(join(base, 'milestones'));
  const milestones: MilestoneEntry[] = [];

  for (const mid of milestoneIds.sort()) {
    const mDir = join(base, 'milestones', mid);
    const complete = await fileExists(join(mDir, `${mid}-SUMMARY.md`));

    // Parse title from roadmap
    const roadmap = await readFileSafe(join(mDir, `${mid}-ROADMAP.md`));
    let title = mid;
    if (roadmap) {
      const titleMatch = roadmap.match(/^#\s+(.+)/m);
      if (titleMatch) title = titleMatch[1].trim();
    }

    // Parse slices from roadmap
    const slices: SliceEntry[] = [];
    if (roadmap) {
      const sliceRegex = /- \[([ x])\] \*\*(\w+): ([^*]+)\*\*\s*(?:`risk:(\w+)`)?(?:\s*`depends:\[([^\]]*)\]`)?/g;
      let match;
      while ((match = sliceRegex.exec(roadmap)) !== null) {
        const sid = match[2];
        const depends = match[5] ? match[5].split(',').map(s => s.trim()).filter(Boolean) : undefined;

        // Parse tasks from plan
        const tasks: TaskEntry[] = [];
        const planContent = await readFileSafe(
          join(mDir, 'slices', sid, `${sid}-PLAN.md`),
        );
        if (planContent) {
          const taskRegex = /- \[([ x])\] \*\*(\w+): ([^*]+)\*\*\s*(?:`est:([^`]+)`)?/g;
          let tm;
          while ((tm = taskRegex.exec(planContent)) !== null) {
            tasks.push({
              id: tm[2],
              title: tm[3].trim(),
              done: tm[1] === 'x',
              estimate: tm[4] || undefined,
            });
          }
        }

        slices.push({
          id: sid,
          title: match[3].trim(),
          done: match[1] === 'x',
          risk: match[4] || undefined,
          depends,
          tasks,
        });
      }
    }

    milestones.push({ id: mid, title, complete, slices });
  }

  return { milestones };
}
