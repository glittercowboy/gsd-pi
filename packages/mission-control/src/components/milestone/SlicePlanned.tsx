import type { GSD2SliceInfo, SliceAction } from "@/server/types";

interface SlicePlannedProps {
  slice: GSD2SliceInfo;
  onAction: (action: SliceAction) => void;
  builderMode?: boolean;
}

export function SlicePlanned({ slice, onAction, builderMode }: SlicePlannedProps) {
  const canStart = slice.dependencies.every((dep) => dep.complete);

  return (
    <div
      data-testid="slice-planned"
      className="rounded-lg border border-[#1E2D3D] bg-[#131C2B] p-4"
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-[#5BC8F0] font-bold">{slice.id}</span>
        <span className="font-mono text-sm text-slate-200 flex-1 ml-3">{slice.name}</span>
        <span className="text-xs font-mono text-slate-400 uppercase tracking-wider">{builderMode ? 'Ready to build' : 'PLANNED'}</span>
      </div>

      {/* Divider */}
      <div className="border-t border-[#1E2D3D] my-2" />

      {/* Meta line */}
      <p className="font-mono text-xs text-slate-400">
        {slice.taskCount} tasks planned
        {slice.costEstimate !== null && (
          <> · est. ~${slice.costEstimate.toFixed(2)}</>
        )}
        {" · branch: "}
        {slice.branch}
      </p>

      {/* Dependencies */}
      {slice.dependencies.length > 0 && (
        <p className="font-mono text-xs text-slate-400 mt-1">
          Depends on:{" "}
          {slice.dependencies.map((dep, i) => (
            <span key={dep.id}>
              {i > 0 && ", "}
              <span className={dep.complete ? "text-[#22C55E]" : "text-slate-500"}>
                {dep.id} {dep.name} {dep.complete ? "✓" : "·"}
              </span>
            </span>
          ))}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between mt-3">
        <button
          type="button"
          onClick={() => onAction({ type: "view_plan", sliceId: slice.id })}
          className="px-3 py-1.5 text-xs font-mono border border-[#1E2D3D] rounded text-slate-300 hover:bg-[#1A2332]"
        >
          {builderMode ? 'See what will be built' : 'Review plan'}
        </button>
        <button
          type="button"
          disabled={!canStart}
          onClick={() => {
            if (canStart) {
              onAction({ type: "start_slice", sliceId: slice.id });
            }
          }}
          className={
            canStart
              ? "px-3 py-1.5 text-xs font-mono rounded bg-[#5BC8F0] text-[#0F1419] font-bold"
              : "px-3 py-1.5 text-xs font-mono rounded opacity-40 cursor-not-allowed bg-[#1A2332] text-slate-500"
          }
        >
          {builderMode ? 'Build this feature' : 'Start this slice'}
        </button>
      </div>
    </div>
  );
}
