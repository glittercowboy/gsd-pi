import { useState } from "react";
import type { GSD2SliceInfo, GSD2UatItem, SliceAction } from "@/server/types";

interface SliceNeedsReviewProps {
  slice: GSD2SliceInfo;
  uatItems: GSD2UatItem[];           // from GSD2State.uatFile.items (active slice only)
  onItemToggle: (itemId: string, checked: boolean) => void;
  onAction: (action: SliceAction) => void;
  builderMode?: boolean;
}

export function SliceNeedsReview({
  slice,
  uatItems,
  onItemToggle,
  onAction,
  builderMode,
}: SliceNeedsReviewProps) {
  const [checkedItems, setCheckedItems] = useState<Map<string, boolean>>(
    () => new Map(uatItems.map((i) => [i.id, i.checked]))
  );
  const [checklistExpanded, setChecklistExpanded] = useState(false);

  const allChecked =
    uatItems.length > 0 && [...checkedItems.values()].every(Boolean);
  const verifiedCount = [...checkedItems.values()].filter(Boolean).length;

  function handleToggle(itemId: string, checked: boolean) {
    const next = new Map(checkedItems);
    next.set(itemId, checked);
    setCheckedItems(next);
    onItemToggle(itemId, checked);
    // Persist via REST API
    const updatedItems = uatItems.map((i) =>
      i.id === itemId ? { ...i, checked } : { ...i, checked: next.get(i.id) ?? i.checked }
    );
    fetch("/api/uat-results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sliceId: slice.id, items: updatedItems }),
    });
  }

  return (
    <div data-testid="slice-needs-review" className="flex flex-col gap-2 py-2">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-[#5BC8F0] font-bold">{slice.id}</span>
          <span className="font-mono text-sm text-slate-300">{slice.name}</span>
        </div>
        <span className="text-xs font-mono text-[#F59E0B] uppercase tracking-wider">
          {builderMode ? 'Ready for your review' : '⚠ NEEDS YOUR REVIEW'}
        </span>
      </div>

      {/* Meta line */}
      <div className="font-mono text-xs text-slate-400">
        {slice.taskCount} tasks complete
        {slice.costEstimate !== null && (
          <> · Total cost: ${slice.costEstimate.toFixed(2)}</>
        )}
      </div>
      <div className="font-mono text-xs text-slate-400">
        Branch ready: {slice.branch} · squash merge pending
      </div>

      {/* Verified count */}
      <div className="font-mono text-xs text-slate-400">
        UAT checklist: {verifiedCount} of {uatItems.length} verified
      </div>

      {/* Checklist (expanded) */}
      {checklistExpanded && uatItems.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-1 border border-[#1E2D3D] rounded p-2 bg-[#0F1419]">
          {uatItems.map((item) => (
            <label key={item.id} className="flex items-center gap-2 py-1 cursor-pointer">
              <input
                type="checkbox"
                checked={checkedItems.get(item.id) ?? false}
                onChange={(e) => {
                  handleToggle(item.id, e.target.checked);
                }}
                className="accent-[#22C55E] h-4 w-4"
              />
              <span className="font-mono text-xs text-slate-300">
                {item.id}: {item.text}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={() => setChecklistExpanded((prev) => !prev)}
          className="font-mono text-xs px-3 py-1.5 rounded border border-[#1E2D3D] text-slate-300 hover:bg-[#1A2332]"
        >
          {checklistExpanded ? "Hide UAT checklist" : "Run UAT checklist"}
        </button>
        <button
          type="button"
          disabled={!allChecked}
          onClick={() => {
            if (allChecked) {
              onAction({ type: "merge", sliceId: slice.id });
            }
          }}
          className={
            allChecked
              ? "bg-[#22C55E] text-[#0F1419] font-bold px-3 py-1.5 text-xs font-mono rounded"
              : "opacity-40 cursor-not-allowed bg-[#1A2332] text-slate-500 px-3 py-1.5 text-xs font-mono rounded"
          }
        >
          {builderMode ? 'Ship it' : 'Merge to main'}
        </button>
      </div>
    </div>
  );
}
