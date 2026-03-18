/**
 * MilestoneView — milestone overview with stacked per-milestone sections.
 *
 * Shows ALL milestones scanned from .gsd/milestones/ (via gsd2State.allMilestones),
 * each with its own SliceAccordion. Active milestone is highlighted.
 * Metric stat cards aggregate across all milestones.
 */
import { useState } from "react";
import { PanelWrapper } from "@/components/layout/PanelWrapper";
import { MilestoneMetrics } from "@/components/milestone/MilestoneMetrics";
import { SliceAccordion } from "@/components/milestone/SliceAccordion";
import { InlineReadPanel } from "@/components/milestone/InlineReadPanel";
import type { GSD2State, GSD2RoadmapState, SliceAction } from "@/server/types";
import { cn } from "@/lib/utils";

export interface WorktreeSessionInfo {
  id: string;
  name: string;
  worktreePath: string | null;
  worktreeBranch?: string | null;
}

/** MilestoneAction — routed to WebSocket layer by SingleColumnView/AppShell. */
export type MilestoneAction =
  | { type: 'send_message'; message: string }
  | { type: 'interrupt' };

interface MilestoneViewProps {
  gsd2State: GSD2State | null;
  sessions?: WorktreeSessionInfo[];
  onAction?: (action: MilestoneAction) => void;
}

/** Section header for a single milestone group. */
function MilestoneSectionHeader({
  milestone,
  isActive,
}: {
  milestone: GSD2RoadmapState;
  isActive: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-2.5 border-b border-[#1E2D3D]",
        isActive ? "bg-[#0D1A27]" : "bg-[#0F1419]"
      )}
    >
      <span className="inline-flex items-center rounded bg-navy-700 px-2 py-0.5 font-mono text-xs text-slate-400">
        {milestone.milestoneId}
      </span>
      <span className="font-display text-sm font-semibold text-slate-200">
        {milestone.milestoneName}
      </span>
      {isActive && (
        <span className="ml-auto text-[10px] font-mono text-[#5BC8F0] uppercase tracking-wider">
          Active
        </span>
      )}
    </div>
  );
}

/** All milestone sections stacked with shared panel state. */
function MilestoneContent({
  gsd2State,
  onAction,
}: {
  gsd2State: GSD2State | null;
  onAction?: (action: MilestoneAction) => void;
}) {
  const activeSliceId = gsd2State?.projectState.active_slice ?? "";
  const activeMilestoneId = gsd2State?.projectState.active_milestone ?? "";
  const isAutoMode = gsd2State?.projectState.auto_mode ?? false;
  const allMilestones = gsd2State?.allMilestones ?? [];

  const [panelState, setPanelState] = useState<{
    isOpen: boolean;
    title: string;
    content: string;
    isLoading: boolean;
  }>({ isOpen: false, title: '', content: '', isLoading: false });

  async function handleSliceAction(action: SliceAction) {
    switch (action.type) {
      case 'start_slice':
        onAction?.({ type: 'send_message', message: '/gsd auto' });
        break;
      case 'pause':
        onAction?.({ type: 'interrupt' });
        break;
      case 'steer':
        onAction?.({ type: 'send_message', message: action.message });
        break;
      case 'merge':
        onAction?.({ type: 'send_message', message: `/gsd merge ${gsd2State?.projectState.active_slice}` });
        break;
      case 'view_plan': {
        setPanelState({ isOpen: true, title: `${action.sliceId} Plan`, content: '', isLoading: true });
        const res = await fetch(`/api/gsd-file?sliceId=${action.sliceId}&type=plan`);
        const data = await res.json() as { content: string };
        setPanelState(prev => ({ ...prev, content: data.content, isLoading: false }));
        break;
      }
      case 'view_task': {
        setPanelState({ isOpen: true, title: 'Current Task', content: '', isLoading: true });
        const res = await fetch(`/api/gsd-file?sliceId=${action.sliceId}&type=task`);
        const data = await res.json() as { content: string };
        setPanelState(prev => ({ ...prev, content: data.content, isLoading: false }));
        break;
      }
      case 'view_diff': {
        setPanelState({ isOpen: true, title: `${action.sliceId} Diff`, content: '', isLoading: true });
        const res = await fetch(`/api/gsd-file?sliceId=${action.sliceId}&type=diff`);
        const data = await res.json() as { content: string };
        setPanelState(prev => ({ ...prev, content: data.content, isLoading: false }));
        break;
      }
      case 'view_uat_results': {
        setPanelState({ isOpen: true, title: `${action.sliceId} UAT Results`, content: '', isLoading: true });
        const res = await fetch(`/api/gsd-file?sliceId=${action.sliceId}&type=uat_results`);
        const data = await res.json() as { content: string };
        setPanelState(prev => ({ ...prev, content: data.content, isLoading: false }));
        break;
      }
    }
  }

  async function handleViewTasks(sliceId: string, milestone: GSD2RoadmapState) {
    const slice = milestone.slices.find((s) => s.id === sliceId);
    const done = slice?.tasks?.filter((t) => t.status === 'complete').length ?? 0;

    if (done === 0) {
      // Nothing completed (or no tasks at all) — fetch and show PLAN.md content
      setPanelState({ isOpen: true, title: `${sliceId} — Plan`, content: '', isLoading: true });
      const res = await fetch(`/api/gsd-file?sliceId=${sliceId}&milestoneId=${milestone.milestoneId}&type=plan`);
      const data = await res.json() as { content: string };
      setPanelState((prev) => ({ ...prev, content: data.content, isLoading: false }));
    } else {
      // Show only completed tasks inline — no fetch needed
      const completedTasks = slice?.tasks?.filter((t) => t.status === 'complete') ?? [];
      const content = completedTasks.map((t) => `[x] ${t.id}: ${t.name}`).join('\n');
      setPanelState({ isOpen: true, title: `${sliceId} — Tasks`, content, isLoading: false });
    }
  }

  function handleUatItemToggle(itemId: string, checked: boolean) {
    const sliceId = gsd2State?.projectState.active_slice ?? '';
    const currentItems = gsd2State?.uatFile?.items ?? [];
    const updated = currentItems.map((i) => (i.id === itemId ? { ...i, checked } : i));
    fetch('/api/uat-results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sliceId, items: updated }),
    });
  }

  return (
    <div className="flex flex-col">
      {/* Aggregate metric cards */}
      <MilestoneMetrics gsd2State={gsd2State} />

      {/* Stacked milestone cards */}
      <div className="flex flex-col gap-3 p-3">
        {allMilestones.map((milestone) => {
          const isActive = milestone.milestoneId === activeMilestoneId;
          async function handleMilestoneAction(action: SliceAction) {
            if (action.type === 'view_tasks') {
              await handleViewTasks(action.sliceId, milestone);
            } else {
              handleSliceAction(action);
            }
          }
          return (
            <div
              key={milestone.milestoneId}
              className={cn(
                "rounded-lg overflow-hidden border",
                isActive
                  ? "border-[#5BC8F0]/30 shadow-[0_0_0_1px_rgba(91,200,240,0.08)]"
                  : "border-[#1E2D3D] opacity-75"
              )}
            >
              <MilestoneSectionHeader milestone={milestone} isActive={isActive} />
              <SliceAccordion
                slices={milestone.slices}
                activeSliceId={isActive ? activeSliceId : ""}
                isAutoMode={isActive ? isAutoMode : false}
                gsd2State={isActive ? gsd2State : null}
                onAction={handleMilestoneAction}
                onUatItemToggle={handleUatItemToggle}
              />
            </div>
          );
        })}
      </div>

      {/* Modal for view_plan / view_task / view_diff / view_uat_results */}
      <InlineReadPanel
        isOpen={panelState.isOpen}
        title={panelState.title}
        content={panelState.content}
        isLoading={panelState.isLoading}
        onClose={() => setPanelState(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}

/** Session section header (for split worktree view). */
function SessionSectionHeader({ session }: { session: WorktreeSessionInfo }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-navy-800/50 border-b border-navy-600">
      <span className="font-medium text-sm text-slate-300">{session.name}</span>
      {session.worktreeBranch ? (
        <span className="text-xs px-2 py-0.5 rounded bg-cyan-accent/10 text-cyan-accent font-mono">
          {session.worktreeBranch}
        </span>
      ) : (
        <span className="text-xs px-2 py-0.5 rounded bg-navy-700 text-slate-500">
          Watching main branch
        </span>
      )}
    </div>
  );
}

export function MilestoneView({ gsd2State, sessions, onAction }: MilestoneViewProps) {
  const allMilestones = gsd2State?.allMilestones ?? [];
  const worktreeSessions = sessions?.filter((s) => s.worktreePath) ?? [];

  // Split view: when 2+ sessions have worktrees — stacked vertically
  if (worktreeSessions.length >= 2) {
    return (
      <>
        <h1 className="sr-only">Milestone</h1>
        <PanelWrapper
          title="Milestone"
          isLoading={gsd2State === null}
          isEmpty={gsd2State !== null && allMilestones.length === 0}
        >
          <div className="space-y-4">
            {worktreeSessions.map((session, index) => (
              <div
                key={session.id}
                className="animate-in fade-in duration-200 rounded-lg border border-navy-600 overflow-hidden"
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <SessionSectionHeader session={session} />
                <div className="overflow-auto max-h-[50vh]">
                  <MilestoneContent gsd2State={gsd2State} onAction={onAction} />
                </div>
              </div>
            ))}
          </div>
        </PanelWrapper>
      </>
    );
  }

  // Standard single view
  return (
    <>
      <h1 className="sr-only">Milestone</h1>
      <PanelWrapper
        title="Milestone"
        isLoading={gsd2State === null}
        isEmpty={gsd2State !== null && allMilestones.length === 0}
      >
        <MilestoneContent gsd2State={gsd2State} onAction={onAction} />
      </PanelWrapper>
    </>
  );
}
