import type {
  WorkspaceMilestoneTarget,
  WorkspaceSliceTarget,
  WorkspaceTaskTarget,
} from "./workspace-types.js"

export type ItemStatus = "done" | "in-progress" | "pending" | "parked"

export function getMilestoneStatus(
  milestone: WorkspaceMilestoneTarget,
  active: { milestoneId?: string },
): ItemStatus {
  // Prefer authoritative milestone status from GSD state registry (#2807)
  if (milestone.status) {
    switch (milestone.status) {
      case "complete":
        return "done"
      case "active":
        return "in-progress"
      case "pending":
        return "pending"
      case "parked":
        return "parked"
    }
  }

  // Fallback: infer from slice completion (legacy / no status field)
  if (milestone.slices.length > 0 && milestone.slices.every((slice: WorkspaceSliceTarget) => slice.done)) {
    return "done"
  }
  if (active.milestoneId === milestone.id) {
    return "in-progress"
  }
  return milestone.slices.some((slice: WorkspaceSliceTarget) => slice.done) ? "in-progress" : "pending"
}

export function getSliceStatus(
  milestoneId: string,
  slice: WorkspaceSliceTarget,
  active: { milestoneId?: string; sliceId?: string },
): ItemStatus {
  if (slice.done) return "done"
  if (active.milestoneId === milestoneId && active.sliceId === slice.id) return "in-progress"
  return "pending"
}

export function getTaskStatus(
  milestoneId: string,
  sliceId: string,
  task: WorkspaceTaskTarget,
  active: { milestoneId?: string; sliceId?: string; taskId?: string },
): ItemStatus {
  if (task.done) return "done"
  if (active.milestoneId === milestoneId && active.sliceId === sliceId && active.taskId === task.id) return "in-progress"
  return "pending"
}
