import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GSD2SliceInfo, SliceAction } from "@/server/types";

interface SliceAccordionProps {
  slices: GSD2SliceInfo[];
  activeSliceId: string;        // e.g. "S01" — auto-expands this row
  isAutoMode: boolean;          // re-expands active row when true
  onAction: (action: SliceAction) => void;
}

export function SliceAccordion({ slices, activeSliceId, isAutoMode, onAction }: SliceAccordionProps) {
  const [openSliceIds, setOpenSliceIds] = useState<Set<string>>(
    () => new Set(activeSliceId ? [activeSliceId] : [])
  );

  // Re-expand active slice when auto_mode becomes true
  useEffect(() => {
    if (isAutoMode && activeSliceId) {
      setOpenSliceIds((prev) => {
        const next = new Set(prev);
        next.add(activeSliceId);
        return next;
      });
    }
  }, [isAutoMode, activeSliceId]);

  function toggleSlice(sliceId: string) {
    setOpenSliceIds((prev) => {
      const next = new Set(prev);
      if (next.has(sliceId)) {
        next.delete(sliceId);
      } else {
        next.add(sliceId);
      }
      return next;
    });
  }

  return (
    <div
      data-testid="slice-accordion"
      className="flex flex-col divide-y divide-[#1E2D3D]"
    >
      {slices.map((slice) => {
        const isOpen = openSliceIds.has(slice.id);
        const isActive = slice.id === activeSliceId;

        return (
          <div
            key={slice.id}
            data-testid={`slice-row-${slice.id}`}
            className={cn(
              "bg-[#131C2B]",
              isActive && "ring-1 ring-inset ring-cyan-400/20",
            )}
          >
            {/* Row header — click to toggle */}
            <button
              type="button"
              onClick={() => toggleSlice(slice.id)}
              className={cn(
                "flex w-full items-center gap-2 px-4 py-3 text-left",
                "transition-colors hover:bg-[#1A2332]",
              )}
              aria-expanded={isOpen}
            >
              <span className="text-slate-400">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </span>
              <span className="flex-1 font-display text-sm font-medium text-slate-200">
                {slice.id}: {slice.name}
              </span>
              <span className={cn(
                "rounded px-2 py-0.5 font-mono text-xs uppercase tracking-wide",
                slice.status === "in_progress" && "bg-cyan-400/10 text-cyan-400",
                slice.status === "complete" && "bg-green-500/10 text-green-400",
                slice.status === "needs_review" && "bg-amber-500/10 text-amber-400",
                slice.status === "planned" && "bg-slate-700 text-slate-400",
              )}>
                {slice.status.replace("_", " ")}
              </span>
            </button>

            {/* Expanded content placeholder — filled by 14-03/14-04 */}
            {isOpen && (
              <div className="border-t border-[#1E2D3D] px-4 py-3">
                <p className="text-xs text-slate-500">
                  Slice detail — coming in 14-03/14-04
                </p>
                {/* Stub actions for wiring */}
                <div className="mt-2 flex gap-2">
                  {slice.status === "planned" && (
                    <button
                      type="button"
                      onClick={() => onAction({ type: "start_slice", sliceId: slice.id })}
                      className="rounded bg-cyan-500/10 px-3 py-1 text-xs text-cyan-400 hover:bg-cyan-500/20"
                    >
                      Start slice
                    </button>
                  )}
                  {(slice.status === "in_progress" || slice.status === "needs_review") && (
                    <button
                      type="button"
                      onClick={() => onAction({ type: "view_plan", sliceId: slice.id })}
                      className="rounded bg-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-600"
                    >
                      View plan
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
