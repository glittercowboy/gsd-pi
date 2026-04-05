/**
 * gsd_doctor — lightweight structural health check (filesystem only).
 */

import { join } from 'node:path';
import { gsdDir, readFileSafe, listDirs, fileExists } from './shared.js';

interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

interface DoctorResult {
  healthy: boolean;
  checks: HealthCheck[];
}

export async function readDoctor(projectDir: string): Promise<DoctorResult> {
  const base = gsdDir(projectDir);
  const checks: HealthCheck[] = [];

  // 1. .gsd/ directory exists
  if (await fileExists(base)) {
    checks.push({ name: 'gsd-dir', status: 'pass', message: '.gsd/ directory exists' });
  } else {
    checks.push({ name: 'gsd-dir', status: 'fail', message: '.gsd/ directory not found' });
    return { healthy: false, checks };
  }

  // 2. STATE.md exists
  if (await readFileSafe(join(base, 'STATE.md'))) {
    checks.push({ name: 'state-md', status: 'pass', message: 'STATE.md present' });
  } else {
    checks.push({ name: 'state-md', status: 'warn', message: 'STATE.md missing — state may be stale' });
  }

  // 3. Database file exists
  if (await fileExists(join(base, 'gsd.db'))) {
    checks.push({ name: 'database', status: 'pass', message: 'gsd.db present' });
  } else {
    checks.push({ name: 'database', status: 'warn', message: 'gsd.db missing — using markdown-only mode' });
  }

  // 4. Milestones directory
  const milestones = await listDirs(join(base, 'milestones'));
  if (milestones.length > 0) {
    checks.push({ name: 'milestones', status: 'pass', message: `${milestones.length} milestone(s) found` });

    // 5. Each milestone has a roadmap
    for (const mid of milestones) {
      const hasRoadmap = await fileExists(
        join(base, 'milestones', mid, `${mid}-ROADMAP.md`),
      );
      if (!hasRoadmap) {
        checks.push({
          name: `milestone-${mid}-roadmap`,
          status: 'warn',
          message: `${mid} has no ROADMAP.md`,
        });
      }

      // 6. Check for empty slice dirs (missing tasks/)
      const sliceDir = join(base, 'milestones', mid, 'slices');
      const sliceIds = await listDirs(sliceDir);
      for (const sid of sliceIds) {
        const tasksDir = join(sliceDir, sid, 'tasks');
        const hasTasks = await fileExists(tasksDir);
        const hasPlan = await fileExists(join(sliceDir, sid, `${sid}-PLAN.md`));
        if (!hasPlan && !hasTasks) {
          checks.push({
            name: `slice-${mid}-${sid}-empty`,
            status: 'warn',
            message: `${mid}/${sid} has no PLAN.md and no tasks/ directory`,
          });
        }
      }
    }
  } else {
    checks.push({ name: 'milestones', status: 'warn', message: 'No milestones found' });
  }

  // 7. REQUIREMENTS.md
  if (await readFileSafe(join(base, 'REQUIREMENTS.md'))) {
    checks.push({ name: 'requirements', status: 'pass', message: 'REQUIREMENTS.md present' });
  } else {
    checks.push({ name: 'requirements', status: 'warn', message: 'REQUIREMENTS.md missing' });
  }

  // 8. DECISIONS.md
  if (await readFileSafe(join(base, 'DECISIONS.md'))) {
    checks.push({ name: 'decisions', status: 'pass', message: 'DECISIONS.md present' });
  } else {
    checks.push({ name: 'decisions', status: 'warn', message: 'DECISIONS.md missing' });
  }

  const healthy = checks.every(c => c.status !== 'fail');
  return { healthy, checks };
}
