/**
 * @gsd-build/mcp-server — MCP server for GSD orchestration and project state.
 */

export { SessionManager } from './session-manager.js';
export { createMcpServer } from './server.js';
export type {
  SessionStatus,
  ManagedSession,
  ExecuteOptions,
  PendingBlocker,
  CostAccumulator,
} from './types.js';
export { MAX_EVENTS, INIT_TIMEOUT_MS } from './types.js';

// Read-only state readers (usable without a running session)
export { readProgress } from './readers/state.js';
export type { ProgressResult } from './readers/state.js';
export { readRoadmap } from './readers/roadmap.js';
export type { RoadmapResult, MilestoneInfo, SliceInfo, TaskInfo } from './readers/roadmap.js';
export { readHistory } from './readers/metrics.js';
export type { HistoryResult, MetricsUnit } from './readers/metrics.js';
export { readCaptures } from './readers/captures.js';
export type { CapturesResult, CaptureEntry } from './readers/captures.js';
export { readKnowledge } from './readers/knowledge.js';
export type { KnowledgeResult, KnowledgeEntry } from './readers/knowledge.js';
export { runDoctorLite } from './readers/doctor-lite.js';
export type { DoctorResult, DoctorIssue } from './readers/doctor-lite.js';
