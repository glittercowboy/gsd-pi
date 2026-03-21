// GSD Visualizer - Shared formatting utilities

import type { VisualizerData, SliceVerification, VisualizerSliceRef } from "./visualizer-data.js";

export function formatCompletionDate(input: string): string {
  if (!input) return "unknown";
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return input;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function sliceLabel(slice: VisualizerSliceRef): string {
  return `${slice.milestoneId}/${slice.sliceId}`;
}

export function findVerification(data: VisualizerData, milestoneId: string, sliceId: string): SliceVerification | undefined {
  return data.sliceVerifications.find(v => v.milestoneId === milestoneId && v.sliceId === sliceId);
}

export function shortenModel(model: string): string {
  return model.replace(/^claude-/, "").slice(0, 12);
}
