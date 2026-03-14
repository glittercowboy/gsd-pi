import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { SliceRow } from "@/components/milestone/SliceRow";
import { useBuilderMode } from "@/hooks/useBuilderMode";
import type { GSD2SliceInfo, GSD2State, SliceAction } from "@/server/types";

interface SliceAccordionProps {
  slices: GSD2SliceInfo[];
  activeSliceId: string;        // e.g. "S01" — auto-expands this row
  isAutoMode: boolean;          // re-expands active row when true
  /** Full GSD2State — used to pass runtime props (uatFile, gitBranchCommits, lastCommitMessage) to SliceRow */
  gsd2State?: GSD2State | null;
  onAction: (action: SliceAction) => void;
  /** Called when a UAT checklist item is toggled in the needs_review card */
  onUatItemToggle?: (itemId: string, checked: boolean) => void;
}

export function SliceAccordion({ slices, activeSliceId, isAutoMode, gsd2State, onAction, onUatItemToggle }: SliceAccordionProps) {
  const { builderMode } = useBuilderMode();
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

        // Runtime props from gsd2State (only available for active slice)
        const uatItems = isActive ? (gsd2State?.uatFile?.items ?? []) : [];
        const commitCount = isActive ? (gsd2State?.gitBranchCommits ?? 0) : 0;
        const lastCommitMessage = isActive ? (gsd2State?.lastCommitMessage ?? "") : "";

        return (
          <div
            key={slice.id}
            className={cn(
              "bg-[#131C2B]",
              isActive && "ring-1 ring-inset ring-cyan-400/20",
            )}
          >
            <SliceRow
              slice={slice}
              isOpen={isOpen}
              onToggle={() => toggleSlice(slice.id)}
              uatItems={uatItems}
              onUatItemToggle={onUatItemToggle}
              commitCount={commitCount}
              lastCommitMessage={lastCommitMessage}
              onAction={onAction}
              builderMode={builderMode}
            />
          </div>
        );
      })}
    </div>
  );
}
