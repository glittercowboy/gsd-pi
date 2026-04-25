// Browser-safe TypeScript interfaces for the workflow visualizer.
// Mirrors upstream types from src/resources/extensions/gsd/visualizer-data.ts
// and src/resources/extensions/gsd/metrics.ts — do NOT import from those
// modules directly, as they use Node.js APIs unavailable in the browser.

// ─── Core Structures ──────────────────────────────────────────────────────────

export interface VisualizerTask {
  id: string
  title: string
  done: boolean
  active: boolean
}

export interface VisualizerSlice {
  id: string
  title: string
  done: boolean
  active: boolean
  risk: string
  depends: string[]
  tasks: VisualizerTask[]
}

export interface VisualizerMilestone {
  id: string
  title: string
  status: "complete" | "active" | "pending" | "parked"
  dependsOn: string[]
  slices: VisualizerSlice[]
}

// ─── Critical Path ────────────────────────────────────────────────────────────

/** Browser-safe variant: slack fields are plain Records, not Maps. */
export interface CriticalPathInfo {
  milestonePath: string[]
  slicePath: string[]
  milestoneSlack: Record<string, number>
  sliceSlack: Record<string, number>
}

// ─── Agent Activity ───────────────────────────────────────────────────────────

export interface AgentActivityInfo {
  currentUnit: { type: string; id: string; startedAt: number } | null
  elapsed: number
  completedUnits: number
  totalSlices: number
  completionRate: number
  active: boolean
  sessionCost: number
  sessionTokens: number
}

// ─── Changelog ────────────────────────────────────────────────────────────────

export interface ChangelogEntry {
  milestoneId: string
  sliceId: string
  title: string
  oneLiner: string
  filesModified: { path: string; description: string }[]
  completedAt: string
}

export interface ChangelogInfo {
  entries: ChangelogEntry[]
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface UnitMetrics {
  type: string
  id: string
  model: string
  startedAt: number
  finishedAt: number
  tokens: TokenCounts
  cost: number
  toolCalls: number
  assistantMessages: number
  userMessages: number
  contextWindowTokens?: number
  truncationSections?: number
  continueHereFired?: boolean
  promptCharCount?: number
}

export interface PhaseAggregate {
  phase: string
  units: number
  tokens: TokenCounts
  cost: number
  duration: number
}

export interface SliceAggregate {
  sliceId: string
  units: number
  tokens: TokenCounts
  cost: number
  duration: number
}

export interface ModelAggregate {
  model: string
  units: number
  tokens: TokenCounts
  cost: number
  contextWindowTokens?: number
}

export interface ProjectTotals {
  units: number
  tokens: TokenCounts
  cost: number
  duration: number
  toolCalls: number
  assistantMessages: number
  userMessages: number
  totalTruncationSections: number
  continueHereFiredCount: number
}

// ─── Top-level Payload ────────────────────────────────────────────────────────

export interface VisualizerData {
  milestones: VisualizerMilestone[]
  phase: string
  totals: ProjectTotals | null
  byPhase: PhaseAggregate[]
  bySlice: SliceAggregate[]
  byModel: ModelAggregate[]
  units: UnitMetrics[]
  criticalPath: CriticalPathInfo
  remainingSliceCount: number
  agentActivity: AgentActivityInfo | null
  changelog: ChangelogInfo
}

// ─── Formatting Utilities ─────────────────────────────────────────────────────

/** Format a USD cost value — uses more decimals for small amounts. */
export function formatCost(cost: number): string {
  const n = Number(cost) || 0
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** Format a token count with K/M suffixes for readability. */
export function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}K`
  return `${(count / 1_000_000).toFixed(2)}M`
}

/** Format a duration in milliseconds as human-readable Xs / Xm Xs / Xh Xm. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}
