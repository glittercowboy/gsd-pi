import type {
  WorkspaceMilestoneTarget,
  WorkspaceSliceTarget,
  WorkspaceTaskTarget,
} from "./gsd-workspace-store"

export type ItemStatus = "done" | "in-progress" | "pending"

export function getMilestoneStatus(
  milestone: WorkspaceMilestoneTarget,
  active: { milestoneId?: string },
): ItemStatus {
  if (milestone.status === "complete") return "done"
  if (milestone.status === "active") return "in-progress"
  if (milestone.status === "pending" || milestone.status === "parked") return "pending"

  if (milestone.slices.length > 0 && milestone.slices.every((slice) => slice.done)) {
    return "done"
  }
  if (active.milestoneId === milestone.id) {
    return "in-progress"
  }
  return milestone.slices.some((slice) => slice.done) ? "in-progress" : "pending"
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
