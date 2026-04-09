// Browser-safe TypeScript interfaces for diagnostics panels.
// Mirrors upstream types from src/resources/extensions/gsd/forensics.ts,
// doctor.ts, and skill-health.ts — do NOT import from those modules directly,
// as they use Node.js APIs unavailable in the browser.

// ─── Forensics ────────────────────────────────────────────────────────────────

export type ForensicAnomalyType =
  | "stuck-loop"
  | "cost-spike"
  | "timeout"
  | "missing-artifact"
  | "crash"
  | "doctor-issue"
  | "error-trace"
  | "journal-stuck"
  | "journal-guard-block"
  | "journal-rapid-iterations"
  | "journal-worktree-failure"

export interface ForensicAnomaly {
  type: ForensicAnomalyType
  severity: "info" | "warning" | "error"
  unitType?: string
  unitId?: string
  summary: string
  details: string
}

export interface ForensicUnitTrace {
  file: string
  unitType: string
  unitId: string
  seq: number
  mtime: number
}

export interface ForensicCrashLock {
  pid: number
  startedAt: string
  unitType: string
  unitId: string
  unitStartedAt: string
  completedUnits: number
  sessionFile?: string
}

export interface ForensicMetricsSummary {
  totalUnits: number
  totalCost: number
  totalDuration: number
}

export interface ForensicRecentUnit {
  type: string
  id: string
  cost: number
  duration: number
  model: string
  finishedAt: number
}

export interface ForensicActivityLogMeta {
  fileCount: number
  totalSizeBytes: number
  oldestFile: string | null
  newestFile: string | null
}

export interface ForensicJournalSummary {
  totalEntries: number
  flowCount: number
  eventCounts: Record<string, number>
  recentEvents: { ts: string; flowId: string; eventType: string; rule?: string; unitId?: string }[]
  oldestEntry: string | null
  newestEntry: string | null
  fileCount: number
}

export interface ForensicReport {
  gsdVersion: string
  timestamp: string
  basePath: string
  activeMilestone: string | null
  activeSlice: string | null
  anomalies: ForensicAnomaly[]
  recentUnits: ForensicRecentUnit[]
  crashLock: ForensicCrashLock | null
  doctorIssueCount: number
  unitTraceCount: number
  unitTraces: ForensicUnitTrace[]
  completedKeyCount: number
  metrics: ForensicMetricsSummary | null
  journalSummary: ForensicJournalSummary | null
  activityLogMeta: ForensicActivityLogMeta | null
}

// ─── Doctor ───────────────────────────────────────────────────────────────────

export type DoctorSeverity = "info" | "warning" | "error"

export interface DoctorIssue {
  severity: DoctorSeverity
  code: string
  scope: string
  unitId: string
  message: string
  file?: string
  fixable: boolean
}

export interface DoctorSummary {
  total: number
  errors: number
  warnings: number
  infos: number
  fixable: number
  byCode: Array<{ code: string; count: number }>
}

export interface DoctorReport {
  ok: boolean
  issues: DoctorIssue[]
  fixesApplied: string[]
  summary: DoctorSummary
}

export interface DoctorFixResult {
  ok: boolean
  fixesApplied: string[]
}

// ─── Skill Health ─────────────────────────────────────────────────────────────

export interface SkillHealthEntry {
  name: string
  totalUses: number
  successRate: number
  avgTokens: number
  tokenTrend: "stable" | "rising" | "declining"
  lastUsed: number
  staleDays: number
  avgCost: number
  flagged: boolean
  flagReason?: string
}

export interface SkillHealSuggestion {
  skillName: string
  trigger: "declining_success" | "rising_tokens" | "high_retry_rate" | "stale"
  message: string
  severity: "info" | "warning" | "critical"
}

export interface SkillHealthReport {
  generatedAt: string
  totalUnitsWithSkills: number
  skills: SkillHealthEntry[]
  staleSkills: string[]
  decliningSkills: string[]
  suggestions: SkillHealSuggestion[]
}
