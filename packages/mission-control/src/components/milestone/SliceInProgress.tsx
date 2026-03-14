import { useState } from "react";
import { ProgressBar } from "@/components/shared/ProgressBar";
import type { GSD2SliceInfo, SliceAction } from "@/server/types";

interface SliceInProgressProps {
  slice: GSD2SliceInfo;
  completedTaskCount: number;  // from activePlan.tasks.filter(t=>t.status==='complete').length
  totalTaskCount: number;      // from activePlan.tasks.length (or slice.taskCount)
  currentTaskName: string;     // from activePlan.tasks[completedTaskCount]?.name ?? ""
  runningCost: number;         // from GSD2State.projectState.cost
  commitCount: number;         // from GSD2State.gitBranchCommits
  onAction: (action: SliceAction) => void;
  builderMode?: boolean;
}

export function SliceInProgress({
  slice,
  completedTaskCount,
  totalTaskCount,
  currentTaskName,
  runningCost,
  commitCount,
  onAction,
  builderMode,
}: SliceInProgressProps) {
  const [steerOpen, setSteerOpen] = useState(false);
  const [steerText, setSteerText] = useState("");

  const progressValue = totalTaskCount > 0 ? (completedTaskCount / totalTaskCount) * 100 : 0;

  return (
    <div
      data-testid="slice-in-progress"
      className="rounded-lg border border-[#1E2D3D] bg-[#131C2B] p-4 border-l-2 border-l-[#F59E0B]"
    >
      {/* Amber pulse accent strip — only the left border animates */}
      <div className="animate-pulse absolute left-0 top-0 h-full w-0.5 bg-[#F59E0B] rounded-l-lg" />

      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-[#5BC8F0] font-bold">{slice.id}</span>
        <span className="font-mono text-sm text-slate-200 flex-1 ml-3">{slice.name}</span>
        <span className="text-xs font-mono text-[#F59E0B] uppercase tracking-wider">
          {builderMode ? 'Building now' : '● EXECUTING'}
        </span>
      </div>

      {/* Divider */}
      <div className="border-t border-[#1E2D3D] my-2" />

      {/* Task progress line */}
      <p className="font-mono text-xs text-slate-400">
        Task {completedTaskCount + 1} of {totalTaskCount}
        {currentTaskName && <>: {currentTaskName}</>}
      </p>

      {/* Progress bar */}
      <div className="mt-2">
        <ProgressBar value={progressValue} />
      </div>

      {/* Branch + commits + cost */}
      <p className="font-mono text-xs text-slate-400 mt-2">
        Branch: {slice.branch} · {commitCount} commits · ${runningCost.toFixed(2)} so far
      </p>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          onClick={() => onAction({ type: "pause" })}
          className="px-3 py-1.5 text-xs font-mono border border-[#1E2D3D] rounded text-slate-300 hover:bg-[#1A2332]"
        >
          Pause
        </button>
        <button
          type="button"
          onClick={() => onAction({ type: "view_task", sliceId: slice.id })}
          className="px-3 py-1.5 text-xs font-mono border border-[#1E2D3D] rounded text-slate-300 hover:bg-[#1A2332]"
        >
          View task
        </button>
        <button
          type="button"
          onClick={() => setSteerOpen(true)}
          className="px-3 py-1.5 text-xs font-mono border border-[#1E2D3D] rounded text-slate-300 hover:bg-[#1A2332]"
        >
          {builderMode ? 'Give direction' : 'Steer'}
        </button>
      </div>

      {/* Steer input — revealed on demand */}
      {steerOpen && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            onAction({ type: 'steer', message: steerText });
            setSteerOpen(false);
            setSteerText("");
          }}
        >
          <input
            autoFocus
            type="text"
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            placeholder="Give direction without stopping..."
            className="w-full font-mono text-sm bg-[#1A2332] border border-[#5BC8F0] rounded px-3 py-2 text-slate-200 placeholder-slate-500 outline-none"
          />
          <div className="flex gap-2 mt-2">
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-mono rounded bg-[#5BC8F0] text-[#0F1419] font-bold"
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => { setSteerOpen(false); setSteerText(""); }}
              className="px-3 py-1.5 text-xs font-mono border border-[#1E2D3D] rounded text-slate-400 hover:bg-[#1A2332]"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
