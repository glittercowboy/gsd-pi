import type { GSD2SliceInfo, SliceAction } from "@/server/types";

interface SliceCompleteProps {
  slice: GSD2SliceInfo;
  totalCost: number;
  commitCount: number;        // from gitBranchCommits
  lastCommitMessage: string;  // from lastCommitMessage
  onAction: (action: SliceAction) => void;
  builderMode?: boolean;
}

export function SliceComplete({
  slice,
  totalCost,
  commitCount,
  lastCommitMessage,
  onAction,
  builderMode,
}: SliceCompleteProps) {
  const truncatedMessage =
    lastCommitMessage.length > 72
      ? lastCommitMessage.slice(0, 72) + "..."
      : lastCommitMessage;

  return (
    <div data-testid="slice-complete" className="flex flex-col gap-2 py-2">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-[#5BC8F0] font-bold">{slice.id}</span>
          <span className="font-mono text-sm text-slate-300">{slice.name}</span>
        </div>
        <span className="text-xs font-mono text-[#22C55E] uppercase tracking-wider">
          {builderMode ? 'Done' : '✓ COMPLETE'}
        </span>
      </div>

      {/* Meta line */}
      <div className="font-mono text-xs text-slate-400">
        Merged · {commitCount} commit{commitCount !== 1 ? "s" : ""} on main · ${totalCost.toFixed(2)} total
      </div>

      {/* Last commit message */}
      {truncatedMessage && (
        <div className="font-mono text-xs text-slate-300 truncate">
          {truncatedMessage}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={() => onAction({ type: "view_diff", sliceId: slice.id })}
          className="font-mono text-xs px-3 py-1.5 rounded border border-[#1E2D3D] text-slate-300 hover:bg-[#1A2332]"
        >
          View diff
        </button>
        <button
          type="button"
          onClick={() => onAction({ type: "view_uat_results", sliceId: slice.id })}
          className="font-mono text-xs px-3 py-1.5 rounded border border-[#1E2D3D] text-slate-300 hover:bg-[#1A2332]"
        >
          View UAT results
        </button>
      </div>
    </div>
  );
}
