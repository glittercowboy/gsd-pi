/**
 * ChatView — standalone chat + task status view.
 *
 * Extracted from TabLayout's "Chat & Task" tab content.
 * Shows session tabs (when multi-session active), compact task status bar, and ChatPanel.
 */
import { useState, useCallback } from "react";
import type React from "react";
import { Monitor } from "lucide-react";
import { MigrationBanner } from "../MigrationBanner";
import { TaskExecuting } from "@/components/active-task/TaskExecuting";
import { TaskWaiting } from "@/components/active-task/TaskWaiting";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ChatDragDropUpload } from "@/components/chat/ChatDragDropUpload";
import { SessionTabs } from "@/components/chat/SessionTabs";
import { SessionCreateModal } from "@/components/chat/SessionCreateModal";
import { SessionCloseModal } from "@/components/chat/SessionCloseModal";
import type { AssetItem } from "@/hooks/useAssets";
import type { PlanningState, PhaseState, PlanState } from "@/server/types";
import type { ChatMessage } from "@/server/chat-types";
import type { SessionTab } from "@/hooks/useSessionManager";

interface ChatViewProps {
  planningState: PlanningState | null;
  chatMessages: ChatMessage[];
  onChatSend: (msg: string) => void;
  isChatProcessing: boolean;
  /** Multi-session props — optional for backward compat */
  sessions?: SessionTab[];
  activeSessionId?: string;
  onSelectSession?: (id: string) => void;
  onCreateSession?: (forkFrom?: string) => void;
  onCloseSession?: (id: string) => void;
  onRenameSession?: (id: string, name: string) => void;
  /** Discuss mode overlay — passed from useChatMode via AppShell -> SingleColumnView */
  discussOverlay?: React.ReactNode;
  /** Preview toggle — wired from usePreview via AppShell -> SingleColumnView */
  onTogglePreview?: () => void;
  previewOpen?: boolean;
}

export function ChatView({
  planningState,
  chatMessages,
  onChatSend,
  isChatProcessing,
  sessions = [],
  activeSessionId = "",
  onSelectSession,
  onCreateSession,
  onCloseSession,
  onRenameSession,
  discussOverlay,
  onTogglePreview,
  previewOpen = false,
}: ChatViewProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [closeModalSession, setCloseModalSession] = useState<SessionTab | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<AssetItem | null>(null);
  const [migrationDismissed, setMigrationDismissed] = useState(false);

  const handleAssetUploaded = useCallback((asset: AssetItem) => {
    setPendingAttachment(asset);
  }, []);

  const handleChatSend = useCallback(
    (msg: string) => {
      if (pendingAttachment) {
        const prefix = `[Attached: .planning/assets/${pendingAttachment.name}]`;
        onChatSend(`${prefix}\n\n${msg}`);
        setPendingAttachment(null);
      } else {
        onChatSend(msg);
      }
    },
    [onChatSend, pendingAttachment],
  );

  const currentPhase: PhaseState | undefined = planningState
    ? planningState.phases.find((p) => p.status === "in_progress") ??
      planningState.phases[planningState.phases.length - 1]
    : undefined;

  const currentPlan: PlanState | undefined = currentPhase
    ? currentPhase.completedPlans < currentPhase.plans.length
      ? currentPhase.plans[currentPhase.completedPlans]
      : undefined
    : undefined;

  const isExecuting =
    currentPlan !== undefined && currentPhase?.status === "in_progress";

  const nextPlan: PlanState | undefined = (() => {
    if (!planningState) return undefined;
    if (currentPhase && currentPhase.completedPlans < currentPhase.plans.length) {
      return currentPhase.plans[currentPhase.completedPlans];
    }
    const nextPhase = planningState.phases.find((p) => p.status === "not_started");
    return nextPhase?.plans[0];
  })();

  const handleCloseTab = useCallback((id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (session?.hasWorktree) {
      setCloseModalSession(session);
    } else {
      onCloseSession?.(id);
    }
  }, [sessions, onCloseSession]);

  const handleCreateClick = useCallback(() => {
    setShowCreateModal(true);
  }, []);

  const hasMultipleSessions = sessions.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Screen-reader heading for this view */}
      <h1 className="sr-only">GSD Mission Control — Chat</h1>
      {/* Session tabs row — only when multi-session is active */}
      {hasMultipleSessions && onSelectSession && onRenameSession && (
        <div className="relative">
          <SessionTabs
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={onSelectSession}
            onClose={handleCloseTab}
            onCreate={handleCreateClick}
            onRename={onRenameSession}
          />
          {/* Preview toggle button — absolute far right of session tabs row */}
          {onTogglePreview && (
            <button
              type="button"
              onClick={onTogglePreview}
              title="Toggle live preview (Cmd+P)"
              className={`absolute right-1 top-1/2 -translate-y-1/2 shrink-0 rounded p-1.5 transition-colors ${
                previewOpen
                  ? "text-cyan-accent hover:bg-navy-700"
                  : "text-slate-500 hover:text-slate-300 hover:bg-navy-700"
              }`}
            >
              <Monitor className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      {/* Preview toggle bar — shown only when no session tabs but preview is wired */}
      {!hasMultipleSessions && onTogglePreview && (
        <div className="flex items-center justify-end border-b border-navy-600 bg-navy-900/50 px-2 py-1">
          <button
            type="button"
            onClick={onTogglePreview}
            title="Toggle live preview (Cmd+P)"
            className={`shrink-0 rounded p-1.5 transition-colors ${
              previewOpen
                ? "text-cyan-accent hover:bg-navy-700"
                : "text-slate-500 hover:text-slate-300 hover:bg-navy-700"
            }`}
          >
            <Monitor className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Migration banner — shown when v1 project (.planning/) detected without .gsd/ */}
      {planningState?.needsMigration && !migrationDismissed && (
        <MigrationBanner
          onRunMigration={() => {
            handleChatSend("/gsd migrate");
            setMigrationDismissed(true);
          }}
          onDismiss={() => setMigrationDismissed(true)}
        />
      )}

      {/* Compact task status at top */}
      <div className="border-b border-navy-600 bg-navy-900/50">
        <div className="p-2">
          {isExecuting && currentPlan ? (
            <TaskExecuting
              taskId={`${currentPlan.phase}-${String(currentPlan.plan).padStart(2, "0")}`}
              wave={currentPlan.wave}
              planNumber={currentPlan.plan}
              filesCount={currentPlan.files_modified.length}
              taskCount={currentPlan.task_count}
              mustHaves={currentPlan.must_haves}
              filesModified={currentPlan.files_modified}
            />
          ) : (
            <TaskWaiting
              lastCompleted={planningState?.state.stopped_at}
              nextTask={nextPlan ? `Plan ${nextPlan.plan}` : undefined}
              nextPlanNumber={nextPlan?.plan}
            />
          )}
        </div>
      </div>

      {/* Chat panel takes remaining space, with drag-drop upload */}
      <div className="flex-1 min-h-0">
        <ChatDragDropUpload onAssetUploaded={handleAssetUploaded}>
          <ChatPanel
            messages={chatMessages}
            onSend={handleChatSend}
            isProcessing={isChatProcessing}
            overlay={discussOverlay}
          />
          {pendingAttachment && (
            <div className="absolute bottom-14 left-4 right-4 z-10 flex items-center gap-2 rounded-md bg-navy-700 border border-cyan-accent/30 px-3 py-2">
              <span className="text-xs text-cyan-accent font-mono truncate flex-1">
                Attached: {pendingAttachment.name}
              </span>
              <button
                type="button"
                onClick={() => setPendingAttachment(null)}
                className="text-slate-400 hover:text-slate-200 text-xs"
              >
                Remove
              </button>
            </div>
          )}
        </ChatDragDropUpload>
      </div>

      {/* Create session modal */}
      <SessionCreateModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreateFresh={() => onCreateSession?.()}
        onCreateFork={() => onCreateSession?.(activeSessionId)}
      />

      {/* Close session modal (worktree sessions only) */}
      {closeModalSession && (
        <SessionCloseModal
          isOpen={true}
          sessionName={closeModalSession.name}
          onClose={() => setCloseModalSession(null)}
          onMerge={() => {
            onCloseSession?.(closeModalSession.id);
            setCloseModalSession(null);
          }}
          onKeep={() => {
            onCloseSession?.(closeModalSession.id);
            setCloseModalSession(null);
          }}
          onDelete={() => {
            onCloseSession?.(closeModalSession.id);
            setCloseModalSession(null);
          }}
        />
      )}
    </div>
  );
}
