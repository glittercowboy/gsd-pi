// Tests for GSD visualizer data loader.
// Verifies the VisualizerData interface shape and source-file contracts.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestContext } from "./test-helpers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { assertTrue, report } = createTestContext();

const dataPath = join(__dirname, "..", "visualizer-data.ts");
const dataSrc = readFileSync(dataPath, "utf-8");

console.log("\n=== visualizer-data.ts source contracts ===");

// Interface exports
assertTrue(
  dataSrc.includes("export interface VisualizerData"),
  "exports VisualizerData interface",
);

assertTrue(
  dataSrc.includes("export interface VisualizerMilestone"),
  "exports VisualizerMilestone interface",
);

assertTrue(
  dataSrc.includes("export interface VisualizerSlice"),
  "exports VisualizerSlice interface",
);

assertTrue(
  dataSrc.includes("export interface VisualizerTask"),
  "exports VisualizerTask interface",
);

// New interfaces
assertTrue(
  dataSrc.includes("export interface CriticalPathInfo"),
  "exports CriticalPathInfo interface",
);

assertTrue(
  dataSrc.includes("export interface AgentActivityInfo"),
  "exports AgentActivityInfo interface",
);

assertTrue(
  dataSrc.includes("export interface ChangelogEntry"),
  "exports ChangelogEntry interface",
);

assertTrue(
  dataSrc.includes("export interface ChangelogInfo"),
  "exports ChangelogInfo interface",
);

assertTrue(
  dataSrc.includes("export interface SliceVerification"),
  "exports SliceVerification interface",
);

assertTrue(
  dataSrc.includes("export interface KnowledgeInfo"),
  "exports KnowledgeInfo interface",
);

assertTrue(
  dataSrc.includes("export interface CapturesInfo"),
  "exports CapturesInfo interface",
);

assertTrue(
  dataSrc.includes("export interface HealthInfo"),
  "exports HealthInfo interface",
);

assertTrue(
  dataSrc.includes("export interface VisualizerDiscussionState"),
  "exports VisualizerDiscussionState interface",
);

assertTrue(
  dataSrc.includes("export type DiscussionState"),
  "exports DiscussionState type",
);

assertTrue(
  dataSrc.includes("export interface VisualizerSliceRef"),
  "exports VisualizerSliceRef interface",
);

assertTrue(
  dataSrc.includes("export interface VisualizerSliceActivity"),
  "exports VisualizerSliceActivity interface",
);

assertTrue(
  dataSrc.includes("export interface VisualizerStats"),
  "exports VisualizerStats interface",
);

// Function export
assertTrue(
  dataSrc.includes("export async function loadVisualizerData"),
  "exports loadVisualizerData function",
);

assertTrue(
  dataSrc.includes("export function computeCriticalPath"),
  "exports computeCriticalPath function",
);

// Data source usage
assertTrue(
  dataSrc.includes("deriveState"),
  "uses deriveState for state derivation",
);

assertTrue(
  dataSrc.includes("findMilestoneIds"),
  "uses findMilestoneIds to enumerate milestones",
);

assertTrue(
  dataSrc.includes("parseRoadmap"),
  "uses parseRoadmap for roadmap parsing",
);

assertTrue(
  dataSrc.includes("parsePlan"),
  "uses parsePlan for plan parsing",
);

assertTrue(
  dataSrc.includes("parseSummary"),
  "uses parseSummary for changelog parsing",
);

assertTrue(
  dataSrc.includes("getLedger"),
  "uses getLedger for in-memory metrics",
);

assertTrue(
  dataSrc.includes("loadLedgerFromDisk"),
  "uses loadLedgerFromDisk as fallback",
);

assertTrue(
  dataSrc.includes("getProjectTotals"),
  "uses getProjectTotals for aggregation",
);

assertTrue(
  dataSrc.includes("aggregateByPhase"),
  "uses aggregateByPhase",
);

assertTrue(
  dataSrc.includes("aggregateBySlice"),
  "uses aggregateBySlice",
);

assertTrue(
  dataSrc.includes("aggregateByModel"),
  "uses aggregateByModel",
);

assertTrue(
  dataSrc.includes("aggregateByTier"),
  "uses aggregateByTier",
);

assertTrue(
  dataSrc.includes("formatTierSavings"),
  "uses formatTierSavings",
);

assertTrue(
  dataSrc.includes("loadAllCaptures"),
  "uses loadAllCaptures",
);

assertTrue(
  dataSrc.includes("countPendingCaptures"),
  "uses countPendingCaptures",
);

assertTrue(
  dataSrc.includes("loadEffectiveGSDPreferences"),
  "uses loadEffectiveGSDPreferences",
);

assertTrue(
  dataSrc.includes("resolveGsdRootFile"),
  "uses resolveGsdRootFile for KNOWLEDGE path",
);

// Interface fields
assertTrue(
  dataSrc.includes("dependsOn: string[]"),
  "VisualizerMilestone has dependsOn field",
);

assertTrue(
  dataSrc.includes("depends: string[]"),
  "VisualizerSlice has depends field",
);

assertTrue(
  dataSrc.includes("totals: ProjectTotals | null"),
  "VisualizerData has nullable totals",
);

assertTrue(
  dataSrc.includes("units: UnitMetrics[]"),
  "VisualizerData has units array",
);

assertTrue(
  dataSrc.includes("estimate?: string"),
  "VisualizerTask has optional estimate field",
);

// New data model fields
assertTrue(
  dataSrc.includes("criticalPath: CriticalPathInfo"),
  "VisualizerData has criticalPath field",
);

assertTrue(
  dataSrc.includes("remainingSliceCount: number"),
  "VisualizerData has remainingSliceCount field",
);

assertTrue(
  dataSrc.includes("agentActivity: AgentActivityInfo | null"),
  "VisualizerData has agentActivity field",
);

assertTrue(
  dataSrc.includes("changelog: ChangelogInfo"),
  "VisualizerData has changelog field",
);

assertTrue(
  dataSrc.includes("sliceVerifications: SliceVerification[]"),
  "VisualizerData has sliceVerifications field",
);

assertTrue(
  dataSrc.includes("knowledge: KnowledgeInfo"),
  "VisualizerData has knowledge field",
);

assertTrue(
  dataSrc.includes("captures: CapturesInfo"),
  "VisualizerData has captures field",
);

assertTrue(
  dataSrc.includes("health: HealthInfo"),
  "VisualizerData has health field",
);

assertTrue(
  dataSrc.includes("stats: VisualizerStats"),
  "VisualizerData has stats field",
);

assertTrue(
  dataSrc.includes("discussion: VisualizerDiscussionState[]"),
  "VisualizerData has discussion field",
);

assertTrue(
  dataSrc.includes("loadDiscussionState"),
  "uses loadDiscussionState helper",
);

assertTrue(
  dataSrc.includes("buildVisualizerStats"),
  "uses buildVisualizerStats helper",
);

assertTrue(
  dataSrc.includes("byTier: TierAggregate[]"),
  "VisualizerData has byTier field",
);

assertTrue(
  dataSrc.includes("tierSavingsLine: string"),
  "VisualizerData has tierSavingsLine field",
);

// completedAt must be coerced to String() to handle YAML Date objects (issue #644)
assertTrue(
  dataSrc.includes("String(summary.frontmatter.completed_at"),
  "completedAt assignment coerces to String() for YAML Date safety",
);

assertTrue(
  dataSrc.includes("String(b.completedAt") && dataSrc.includes("String(a.completedAt"),
  "changelog sort coerces completedAt to String() for YAML Date safety",
);

// Verify overlay source exists and imports data module
const overlayPath = join(__dirname, "..", "visualizer-overlay.ts");
const overlaySrc = readFileSync(overlayPath, "utf-8");

console.log("\n=== visualizer-overlay.ts source contracts ===");

assertTrue(
  overlaySrc.includes("export class GSDVisualizerOverlay"),
  "exports GSDVisualizerOverlay class",
);

assertTrue(
  overlaySrc.includes("loadVisualizerData"),
  "overlay uses loadVisualizerData",
);

assertTrue(
  overlaySrc.includes("renderProgressView"),
  "overlay delegates to renderProgressView",
);

assertTrue(
  overlaySrc.includes("renderDepsView"),
  "overlay delegates to renderDepsView",
);

assertTrue(
  overlaySrc.includes("renderMetricsView"),
  "overlay delegates to renderMetricsView",
);

assertTrue(
  overlaySrc.includes("renderTimelineView"),
  "overlay delegates to renderTimelineView",
);

assertTrue(
  overlaySrc.includes("renderAgentView"),
  "overlay delegates to renderAgentView",
);

assertTrue(
  overlaySrc.includes("renderChangelogView"),
  "overlay delegates to renderChangelogView",
);

assertTrue(
  overlaySrc.includes("renderExportView"),
  "overlay delegates to renderExportView",
);

assertTrue(
  overlaySrc.includes("renderKnowledgeView"),
  "overlay delegates to renderKnowledgeView",
);

assertTrue(
  overlaySrc.includes("renderCapturesView"),
  "overlay delegates to renderCapturesView",
);

assertTrue(
  overlaySrc.includes("renderHealthView"),
  "overlay delegates to renderHealthView",
);

assertTrue(
  overlaySrc.includes("handleInput"),
  "overlay has handleInput method",
);

assertTrue(
  overlaySrc.includes("dispose"),
  "overlay has dispose method",
);

assertTrue(
  overlaySrc.includes("wrapInBox"),
  "overlay has wrapInBox helper",
);

assertTrue(
  overlaySrc.includes("activeTab"),
  "overlay tracks active tab",
);

assertTrue(
  overlaySrc.includes("scrollOffsets"),
  "overlay tracks per-tab scroll offsets",
);

assertTrue(
  overlaySrc.includes("filterMode"),
  "overlay has filterMode state",
);

assertTrue(
  overlaySrc.includes("filterText"),
  "overlay has filterText state",
);

assertTrue(
  overlaySrc.includes("filterField"),
  "overlay has filterField state",
);

assertTrue(
  overlaySrc.includes("TAB_COUNT"),
  "overlay defines TAB_COUNT",
);

assertTrue(
  overlaySrc.includes("0 Health"),
  "overlay has 10 tab labels",
);

// Verify commands.ts integration
const commandsPath = join(__dirname, "..", "commands.ts");
const commandsSrc = readFileSync(commandsPath, "utf-8");

console.log("\n=== commands.ts integration ===");

assertTrue(
  commandsSrc.includes('"visualize"'),
  "commands.ts has visualize in subcommands array",
);

assertTrue(
  commandsSrc.includes("GSDVisualizerOverlay"),
  "commands.ts imports GSDVisualizerOverlay",
);

assertTrue(
  commandsSrc.includes("handleVisualize"),
  "commands.ts has handleVisualize handler",
);

report();
