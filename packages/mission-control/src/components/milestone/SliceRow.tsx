import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { SlicePlanned } from "@/components/milestone/SlicePlanned";
import { SliceInProgress } from "@/components/milestone/SliceInProgress";
import { SliceNeedsReview } from "@/components/milestone/SliceNeedsReview";
import { SliceComplete } from "@/components/milestone/SliceComplete";
import type { GSD2SliceInfo, GSD2UatItem, SliceAction, SliceStatus } from "@/server/types";

// ---------------------------------------------------------------------------
// StatusBadge inline helper
// ---------------------------------------------------------------------------
function StatusBadge({ status, builderMode }: { status: SliceStatus; builderMode?: boolean }) {
  switch (status) {
    case "planned":
      return (
        <span className="text-xs font-mono text-slate-400 uppercase tracking-wider">
          {builderMode ? 'Ready to build' : 'PLANNED'}
        </span>
      );
    case "in_progress":
      return (
        <span className="text-xs font-mono text-[#F59E0B] uppercase tracking-wider">
          {builderMode ? 'Building now' : '● EXECUTING'}
        </span>
      );
    case "needs_review":
      return (
        <span className="text-xs font-mono text-[#F59E0B] uppercase tracking-wider">
          {builderMode ? 'Ready for your review' : '⚠ NEEDS YOUR REVIEW'}
        </span>
      );
    case "complete":
      return (
        <span className="text-xs font-mono text-[#22C55E] uppercase tracking-wider">
          {builderMode ? 'Done' : '✓ COMPLETE'}
        </span>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// SliceRowProps
// ---------------------------------------------------------------------------
interface SliceRowProps {
  slice: GSD2SliceInfo;
  isOpen: boolean;
  onToggle: () => void;
  // Runtime data needed by in_progress card
  completedTaskCount?: number;
  totalTaskCount?: number;
  currentTaskName?: string;
  runningCost?: number;
  commitCount?: number;
  // UAT data needed by needs_review card
  uatItems?: GSD2UatItem[];
  onUatItemToggle?: (itemId: string, checked: boolean) => void;
  // Complete card data
  lastCommitMessage?: string;
  // Action dispatcher
  onAction: (action: SliceAction) => void;
  // Builder mode flag
  builderMode?: boolean;
}

// ---------------------------------------------------------------------------
// SliceRow
// ---------------------------------------------------------------------------
export function SliceRow({
  slice,
  isOpen,
  onToggle,
  completedTaskCount = 0,
  totalTaskCount,
  currentTaskName = "",
  runningCost = 0,
  commitCount = 0,
  uatItems,
  onUatItemToggle,
  lastCommitMessage = "",
  onAction,
  builderMode,
}: SliceRowProps) {
  return (
    <div data-testid={`slice-row-${slice.id}`}>
      {/* Row header — always visible, click to toggle */}
      <div
        onClick={onToggle}
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-[#1A2332] border-b border-[#1E2D3D]"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-[#5BC8F0] font-bold">{slice.id}</span>
          <span className="font-mono text-sm text-slate-300">{slice.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={slice.status} builderMode={builderMode} />
          <ChevronDown
            className={cn("h-4 w-4 text-slate-500 transition-transform", isOpen && "rotate-180")}
          />
        </div>
      </div>

      {/* Expanded card — routed by slice.status */}
      {isOpen && (
        <div className="px-4 py-3">
          {slice.status === "planned" && (
            <SlicePlanned slice={slice} onAction={onAction} builderMode={builderMode} />
          )}
          {slice.status === "in_progress" && (
            <SliceInProgress
              slice={slice}
              completedTaskCount={completedTaskCount}
              totalTaskCount={totalTaskCount ?? slice.taskCount}
              currentTaskName={currentTaskName}
              runningCost={runningCost}
              commitCount={commitCount}
              onAction={onAction}
              builderMode={builderMode}
            />
          )}
          {slice.status === "needs_review" && (
            <SliceNeedsReview
              slice={slice}
              uatItems={uatItems ?? []}
              onItemToggle={onUatItemToggle ?? (() => {})}
              onAction={onAction}
              builderMode={builderMode}
            />
          )}
          {slice.status === "complete" && (
            <SliceComplete
              slice={slice}
              totalCost={slice.costEstimate ?? 0}
              commitCount={commitCount}
              lastCommitMessage={lastCommitMessage}
              onAction={onAction}
              builderMode={builderMode}
            />
          )}
        </div>
      )}
    </div>
  );
}
