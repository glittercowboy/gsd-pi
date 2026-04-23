import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DoctorIssue } from "./doctor-types.js";
import { isDbAvailable, _getAdapter } from "./gsd-db.js";
import { resolveMilestoneFile } from "./paths.js";
import { deriveState } from "./state.js";
import { readEvents } from "./workflow-events.js";
import { renderAllProjections } from "./workflow-projections.js";

export async function checkEngineHealth(
  basePath: string,
  issues: DoctorIssue[],
  fixesApplied: string[],
): Promise<void> {
  const dbPath = join(basePath, ".gsd", "gsd.db");

  if (!isDbAvailable() && existsSync(dbPath)) {
    issues.push({
      severity: "warning",
      code: "db_unavailable",
      scope: "project",
      unitId: "project",
      message: "Database unavailable — using filesystem state derivation (degraded mode). State queries may be slower and less reliable.",
      file: ".gsd/gsd.db",
      fixable: false,
    });
  }

  // ── DB constraint violation detection (full doctor only, not pre-dispatch per D-10) ──
  try {
    if (isDbAvailable()) {
      const adapter = _getAdapter()!;

      // a. Orphaned tasks (task.slice_id points to non-existent slice)
      try {
        const orphanedTasks = adapter
          .prepare(
            `SELECT t.id, t.slice_id, t.milestone_id
             FROM tasks t
             LEFT JOIN slices s ON t.milestone_id = s.milestone_id AND t.slice_id = s.id
             WHERE s.id IS NULL`,
          )
          .all() as Array<{ id: string; slice_id: string; milestone_id: string }>;

        for (const row of orphanedTasks) {
          issues.push({
            severity: "error",
            code: "db_orphaned_task",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Task ${row.id} references slice ${row.slice_id} in milestone ${row.milestone_id} but no such slice exists in the database`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — orphaned task check failed
      }

      // b. Orphaned slices (slice.milestone_id points to non-existent milestone)
      try {
        const orphanedSlices = adapter
          .prepare(
            `SELECT s.id, s.milestone_id
             FROM slices s
             LEFT JOIN milestones m ON s.milestone_id = m.id
             WHERE m.id IS NULL`,
          )
          .all() as Array<{ id: string; milestone_id: string }>;

        for (const row of orphanedSlices) {
          issues.push({
            severity: "error",
            code: "db_orphaned_slice",
            scope: "slice",
            unitId: `${row.milestone_id}/${row.id}`,
            message: `Slice ${row.id} references milestone ${row.milestone_id} but no such milestone exists in the database`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — orphaned slice check failed
      }

      // c. Tasks marked complete without summaries
      try {
        const doneTasks = adapter
          .prepare(
            `SELECT id, slice_id, milestone_id FROM tasks
             WHERE status = 'done' AND (summary IS NULL OR summary = '')`,
          )
          .all() as Array<{ id: string; slice_id: string; milestone_id: string }>;

        for (const row of doneTasks) {
          issues.push({
            severity: "warning",
            code: "db_done_task_no_summary",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Task ${row.id} is marked done but has no summary in the database`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — done-task-no-summary check failed
      }

      // d. Stale external_waits — rows stuck in 'waiting' past their timeout or with mismatched task status
      try {
        const staleWaits = adapter
          .prepare(
            `SELECT ew.milestone_id, ew.slice_id, ew.task_id, ew.registered_at, ew.timeout_ms,
                    t.status AS task_status
             FROM external_waits ew
             LEFT JOIN tasks t ON ew.milestone_id = t.milestone_id
                              AND ew.slice_id = t.slice_id
                              AND ew.task_id = t.id
             WHERE ew.status = 'waiting'`,
          )
          .all() as Array<{
            milestone_id: string; slice_id: string; task_id: string;
            registered_at: string; timeout_ms: number; task_status: string | null;
          }>;

        const now = Date.now();
        for (const row of staleWaits) {
          const unitId = `${row.milestone_id}/${row.slice_id}/${row.task_id}`;
          const registeredAt = new Date(row.registered_at).getTime();
          const expired = Number.isFinite(registeredAt) && (now - registeredAt > row.timeout_ms);

          if (expired) {
            issues.push({
              severity: "warning",
              code: "stale_external_wait",
              scope: "task",
              unitId,
              message: `External wait for ${row.task_id} registered at ${row.registered_at} has exceeded its ${Math.round(row.timeout_ms / 3600000)}h timeout — may need manual resolution`,
              fixable: false,
            });
          } else if (row.task_status && row.task_status !== "awaiting-external") {
            issues.push({
              severity: "warning",
              code: "stale_external_wait",
              scope: "task",
              unitId,
              message: `External wait for ${row.task_id} is 'waiting' but task status is '${row.task_status}' — DB state mismatch`,
              fixable: false,
            });
          }
        }
      } catch {
        // Non-fatal — stale external wait check failed
      }

      // e. Duplicate entity IDs (safety check)
      try {
        const dupMilestones = adapter
          .prepare("SELECT id, COUNT(*) as cnt FROM milestones GROUP BY id HAVING cnt > 1")
          .all() as Array<{ id: string; cnt: number }>;
        for (const row of dupMilestones) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "milestone",
            unitId: row.id,
            message: `Duplicate milestone ID "${row.id}" appears ${row.cnt} times in the database`,
            fixable: false,
          });
        }

        const dupSlices = adapter
          .prepare("SELECT id, milestone_id, COUNT(*) as cnt FROM slices GROUP BY id, milestone_id HAVING cnt > 1")
          .all() as Array<{ id: string; milestone_id: string; cnt: number }>;
        for (const row of dupSlices) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "slice",
            unitId: `${row.milestone_id}/${row.id}`,
            message: `Duplicate slice ID "${row.id}" in milestone ${row.milestone_id} appears ${row.cnt} times`,
            fixable: false,
          });
        }

        const dupTasks = adapter
          .prepare("SELECT id, slice_id, milestone_id, COUNT(*) as cnt FROM tasks GROUP BY id, slice_id, milestone_id HAVING cnt > 1")
          .all() as Array<{ id: string; slice_id: string; milestone_id: string; cnt: number }>;
        for (const row of dupTasks) {
          issues.push({
            severity: "error",
            code: "db_duplicate_id",
            scope: "task",
            unitId: `${row.milestone_id}/${row.slice_id}/${row.id}`,
            message: `Duplicate task ID "${row.id}" in slice ${row.slice_id} appears ${row.cnt} times`,
            fixable: false,
          });
        }
      } catch {
        // Non-fatal — duplicate ID check failed
      }
    }
  } catch {
    // Non-fatal — DB constraint checks failed entirely
  }

  // ── Projection drift detection ──────────────────────────────────────────
  // If the DB is available, check whether markdown projections are stale
  // relative to the event log and re-render them.
  try {
    if (isDbAvailable()) {
      const eventLogPath = join(basePath, ".gsd", "event-log.jsonl");
      const events = readEvents(eventLogPath);
      if (events.length > 0) {
        const lastEventTs = new Date(events[events.length - 1]!.ts).getTime();
        const state = await deriveState(basePath);
        for (const milestone of state.registry) {
          if (milestone.status === "complete") continue;
          const roadmapPath = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
          if (!roadmapPath || !existsSync(roadmapPath)) {
            try {
              await renderAllProjections(basePath, milestone.id);
              fixesApplied.push(`re-rendered missing projections for ${milestone.id}`);
            } catch {
              // Non-fatal — projection re-render failed
            }
            continue;
          }
          const projectionMtime = statSync(roadmapPath).mtimeMs;
          if (lastEventTs > projectionMtime) {
            try {
              await renderAllProjections(basePath, milestone.id);
              fixesApplied.push(`re-rendered stale projections for ${milestone.id}`);
            } catch {
              // Non-fatal — projection re-render failed
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — projection drift check must never block doctor
  }
}
