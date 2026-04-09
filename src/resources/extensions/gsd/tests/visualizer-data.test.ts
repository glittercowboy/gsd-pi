// Tests for GSD visualizer data loader.
// Verifies the VisualizerData interface shape and source-file contracts.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dataPath = join(__dirname, "..", "visualizer-data.ts");
const dataSrc = readFileSync(dataPath, "utf-8");

console.log("\n=== visualizer-data.ts source contracts ===");

// Interface exports
assert.ok(
  dataSrc.includes("export interface VisualizerData"),
  "exports VisualizerData interface",
);

assert.ok(
  dataSrc.includes("export interface VisualizerMilestone"),
  "exports VisualizerMilestone interface",
);

assert.ok(
  dataSrc.includes("export interface VisualizerSlice"),
  "exports VisualizerSlice interface",
);

assert.ok(
  dataSrc.includes("export interface VisualizerTask"),
  "exports VisualizerTask interface",
);

// New interfaces
assert.ok(
  dataSrc.includes("export interface CriticalPathInfo"),
  "exports CriticalPathInfo interface",
);

assert.ok(
  dataSrc.includes("export interface AgentActivityInfo"),
  "exports AgentActivityInfo interface",
);

assert.ok(
  dataSrc.includes("export interface ChangelogEntry"),
  "exports ChangelogEntry interface",
);

assert.ok(
  dataSrc.includes("export interface ChangelogInfo"),
  "exports ChangelogInfo interface",
);

assert.ok(
  dataSrc.includes("export interface SliceVerification"),
  "exports SliceVerification interface",
);

assert.ok(
  dataSrc.includes("export interface KnowledgeInfo"),
  "exports KnowledgeInfo interface",
);

assert.ok(
  dataSrc.includes("export interface CapturesInfo"),
  "exports CapturesInfo interface",
);

assert.ok(
  dataSrc.includes("export interface HealthInfo"),
  "exports HealthInfo interface",
);

assert.ok(
  dataSrc.includes("export interface VisualizerDiscussionState"),
  "exports VisualizerDiscussionState interface",
);

assert.ok(
  dataSrc.includes("export type DiscussionState"),
  "exports DiscussionState type",
);

assert.ok(
  dataSrc.includes("export interface VisualizerSliceRef"),
  "exports VisualizerSliceRef interface",
);

assert.ok(
  dataSrc.includes("export interface VisualizerSliceActivity"),
  "exports VisualizerSliceActivity interface",
);

assert.ok(
  dataSrc.includes("export interface VisualizerStats"),
  "exports VisualizerStats interface",
);

// Function export
assert.ok(
  dataSrc.includes("export async function loadVisualizerData"),
  "exports loadVisualizerData function",
);

assert.ok(
  dataSrc.includes("export function computeCriticalPath"),
  "exports computeCriticalPath function",
);

// Data source usage
assert.ok(
  dataSrc.includes("deriveState"),
  "uses deriveState for state derivation",
);

assert.ok(
  dataSrc.includes("findMilestoneIds"),
  "uses findMilestoneIds to enumerate milestones",
);

assert.ok(
  dataSrc.includes("parseRoadmap"),
  "uses parseRoadmap for roadmap parsing",
);

assert.ok(
  dataSrc.includes("parsePlan"),
  "uses parsePlan for plan parsing",
);

assert.ok(
  dataSrc.includes("parseSummary"),
  "uses parseSummary for changelog parsing",
);

assert.ok(
  dataSrc.includes("getLedger"),
  "uses getLedger for in-memory metrics",
);

assert.ok(
  dataSrc.includes("loadLedgerFromDisk"),
  "uses loadLedgerFromDisk as fallback",
);

assert.ok(
  dataSrc.includes("getProjectTotals"),
  "uses getProjectTotals for aggregation",
);

assert.ok(
  dataSrc.includes("aggregateByPhase"),
  "uses aggregateByPhase",
);

assert.ok(
  dataSrc.includes("aggregateBySlice"),
  "uses aggregateBySlice",
);

assert.ok(
  dataSrc.includes("aggregateByModel"),
  "uses aggregateByModel",
);

assert.ok(
  dataSrc.includes("aggregateByTier"),
  "uses aggregateByTier",
);

assert.ok(
  dataSrc.includes("formatTierSavings"),
  "uses formatTierSavings",
);

assert.ok(
  dataSrc.includes("loadAllCaptures"),
  "uses loadAllCaptures",
);

assert.ok(
  dataSrc.includes("countPendingCaptures"),
  "uses countPendingCaptures",
);

assert.ok(
  dataSrc.includes("loadEffectiveGSDPreferences"),
  "uses loadEffectiveGSDPreferences",
);

assert.ok(
  dataSrc.includes("resolveGsdRootFile"),
  "uses resolveGsdRootFile for KNOWLEDGE path",
);

// Interface fields
assert.ok(
  dataSrc.includes("dependsOn: string[]"),
  "VisualizerMilestone has dependsOn field",
);

assert.ok(
  dataSrc.includes("depends: string[]"),
  "VisualizerSlice has depends field",
);

assert.ok(
  dataSrc.includes("totals: ProjectTotals | null"),
  "VisualizerData has nullable totals",
);

assert.ok(
  dataSrc.includes("units: UnitMetrics[]"),
  "VisualizerData has units array",
);

assert.ok(
  dataSrc.includes("estimate?: string"),
  "VisualizerTask has optional estimate field",
);

// New data model fields
assert.ok(
  dataSrc.includes("criticalPath: CriticalPathInfo"),
  "VisualizerData has criticalPath field",
);

assert.ok(
  dataSrc.includes("remainingSliceCount: number"),
  "VisualizerData has remainingSliceCount field",
);

assert.ok(
  dataSrc.includes("agentActivity: AgentActivityInfo | null"),
  "VisualizerData has agentActivity field",
);

assert.ok(
  dataSrc.includes("changelog: ChangelogInfo"),
  "VisualizerData has changelog field",
);

assert.ok(
  dataSrc.includes("sliceVerifications: SliceVerification[]"),
  "VisualizerData has sliceVerifications field",
);

assert.ok(
  dataSrc.includes("knowledge: KnowledgeInfo"),
  "VisualizerData has knowledge field",
);

assert.ok(
  dataSrc.includes("captures: CapturesInfo"),
  "VisualizerData has captures field",
);

assert.ok(
  dataSrc.includes("health: HealthInfo"),
  "VisualizerData has health field",
);

assert.ok(
  dataSrc.includes("stats: VisualizerStats"),
  "VisualizerData has stats field",
);

assert.ok(
  dataSrc.includes("discussion: VisualizerDiscussionState[]"),
  "VisualizerData has discussion field",
);

assert.ok(
  dataSrc.includes("loadDiscussionState"),
  "uses loadDiscussionState helper",
);

assert.ok(
  dataSrc.includes("buildVisualizerStats"),
  "uses buildVisualizerStats helper",
);

assert.ok(
  dataSrc.includes("byTier: TierAggregate[]"),
  "VisualizerData has byTier field",
);

assert.ok(
  dataSrc.includes("tierSavingsLine: string"),
  "VisualizerData has tierSavingsLine field",
);

// completedAt must be coerced to String() to handle YAML Date objects (issue #644)
assert.ok(
  dataSrc.includes("String(summary.frontmatter.completed_at"),
  "completedAt assignment coerces to String() for YAML Date safety",
);

assert.ok(
  dataSrc.includes("String(b.completedAt") && dataSrc.includes("String(a.completedAt"),
  "changelog sort coerces completedAt to String() for YAML Date safety",
);

// Verify overlay source exists and imports data module
const overlayPath = join(__dirname, "..", "visualizer-overlay.ts");
const overlaySrc = readFileSync(overlayPath, "utf-8");

console.log("\n=== visualizer-overlay.ts source contracts ===");

assert.ok(
  overlaySrc.includes("export class GSDVisualizerOverlay"),
  "exports GSDVisualizerOverlay class",
);

assert.ok(
  overlaySrc.includes("loadVisualizerData"),
  "overlay uses loadVisualizerData",
);

assert.ok(
  overlaySrc.includes("renderProgressView"),
  "overlay delegates to renderProgressView",
);

assert.ok(
  overlaySrc.includes("renderDepsView"),
  "overlay delegates to renderDepsView",
);

assert.ok(
  overlaySrc.includes("renderMetricsView"),
  "overlay delegates to renderMetricsView",
);

assert.ok(
  overlaySrc.includes("renderTimelineView"),
  "overlay delegates to renderTimelineView",
);

assert.ok(
  overlaySrc.includes("renderAgentView"),
  "overlay delegates to renderAgentView",
);

assert.ok(
  overlaySrc.includes("renderChangelogView"),
  "overlay delegates to renderChangelogView",
);

assert.ok(
  overlaySrc.includes("renderExportView"),
  "overlay delegates to renderExportView",
);

assert.ok(
  overlaySrc.includes("renderKnowledgeView"),
  "overlay delegates to renderKnowledgeView",
);

assert.ok(
  overlaySrc.includes("renderCapturesView"),
  "overlay delegates to renderCapturesView",
);

assert.ok(
  overlaySrc.includes("renderHealthView"),
  "overlay delegates to renderHealthView",
);

assert.ok(
  overlaySrc.includes("handleInput"),
  "overlay has handleInput method",
);

assert.ok(
  overlaySrc.includes("dispose"),
  "overlay has dispose method",
);

assert.ok(
  overlaySrc.includes("wrapInBox"),
  "overlay has wrapInBox helper",
);

assert.ok(
  overlaySrc.includes("activeTab"),
  "overlay tracks active tab",
);

assert.ok(
  overlaySrc.includes("scrollOffsets"),
  "overlay tracks per-tab scroll offsets",
);

assert.ok(
  overlaySrc.includes("filterMode"),
  "overlay has filterMode state",
);

assert.ok(
  overlaySrc.includes("filterText"),
  "overlay has filterText state",
);

assert.ok(
  overlaySrc.includes("filterField"),
  "overlay has filterField state",
);

assert.ok(
  overlaySrc.includes("TAB_COUNT"),
  "overlay defines TAB_COUNT",
);

assert.ok(
  overlaySrc.includes("0 Export"),
  "overlay has 10 tab labels",
);

// Verify commands/handlers/core.ts integration
const coreHandlerPath = join(__dirname, "..", "commands", "handlers", "core.ts");
const coreHandlerSrc = readFileSync(coreHandlerPath, "utf-8");

console.log("\n=== commands/handlers/core.ts integration ===");

assert.ok(
  coreHandlerSrc.includes('"visualize"'),
  "core.ts has visualize in subcommands array",
);

assert.ok(
  coreHandlerSrc.includes("GSDVisualizerOverlay"),
  "core.ts imports GSDVisualizerOverlay",
);

assert.ok(
  coreHandlerSrc.includes("handleVisualize"),
  "core.ts has handleVisualize handler",
);
