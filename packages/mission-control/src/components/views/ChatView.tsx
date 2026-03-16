/**
 * ChatView — standalone chat + task status view.
 *
 * Extracted from TabLayout's "Chat & Task" tab content.
 * Shows session tabs (when multi-session active), compact task status bar, and ChatPanel.
 *
 * Architecture note: ChatView is intentionally hook-free so it can be called directly
 * in tests (direct function call + JSON.stringify pattern). All interactive state
 * (modals, pending attachment, migration dismissal) is managed by ChatViewConnected,
 * which is the component used by the app at runtime.
 */
import { useState, useCallback, useEffect } from "react";
import type React from "react";
import { Monitor } from "lucide-react";
import { MigrationBanner } from "../MigrationBanner";
import { TaskExecutingConnected as TaskExecuting } from "@/components/active-task/TaskExecuting";
import { TaskWaiting } from "@/components/active-task/TaskWaiting";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ChatDragDropUpload } from "@/components/chat/ChatDragDropUpload";
import { SessionTabs } from "@/components/chat/SessionTabs";
import { SessionCreateModal } from "@/components/chat/SessionCreateModal";
import { SessionCloseModal } from "@/components/chat/SessionCloseModal";
import type { AssetItem } from "@/hooks/useAssets";
import type { PlanningState } from "@/server/types";
import type { ChatMessage } from "@/server/chat-types";
import type { SessionTab } from "@/hooks/useSessionManager";
import type { CostState } from "@/hooks/useCostTracker";

export interface ChatViewProps {
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
  /** Crash recovery — set to true when a process_crashed event arrives */
  isCrashed?: boolean;
  /** Called when user dismisses crash banner or sends a new message */
  onDismissCrash?: () => void;
  /** Cost tracking — current accumulated cost state from useCostTracker */
  costState?: CostState;
  /** Called when user dismisses the budget warning banner */
  onDismissBudgetWarning?: () => void;
  /** True when /gsd auto is running — shows EXECUTING badge in header */
  isAutoMode?: boolean;
  /** Called on Escape keypress while auto mode is active */
  onInterrupt?: () => void;
  /** Builder mode — hides cost badge, token count, model name, slash autocomplete */
  builderMode?: boolean;
}

/** Internal props injected by ChatViewConnected; not part of the public API. */
interface ChatViewInternalProps extends ChatViewProps {
  showCreateModal?: boolean;
  closeModalSession?: SessionTab | null;
  pendingAttachment?: AssetItem | null;
  migrationDismissed?: boolean;
  onAssetUploaded?: (asset: AssetItem) => void;
  onCloseAttachment?: () => void;
  onRunMigration?: () => void;
  onDismissMigration?: () => void;
  onCloseTab?: (id: string) => void;
  onCreateClick?: () => void;
  onConfirmClose?: () => void;
  onConfirmMerge?: () => void;
  onConfirmKeep?: () => void;
  onConfirmDelete?: () => void;
  onCancelClose?: () => void;
  // isCrashed, onDismissCrash, costState, onDismissBudgetWarning inherited from ChatViewProps
}

/**
 * Pure (hook-free) render function for the chat view layout.
 * Called directly in tests; composed by ChatViewConnected in the running app.
 */
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
  isCrashed = false,
  onDismissCrash,
  showCreateModal = false,
  closeModalSession = null,
  pendingAttachment = null,
  migrationDismissed = false,
  onAssetUploaded,
  onCloseAttachment,
  onRunMigration,
  onDismissMigration,
  onCloseTab,
  onCreateClick,
  onConfirmClose,
  onConfirmMerge,
  onConfirmKeep,
  onConfirmDelete,
  onCancelClose,
  costState,
  onDismissBudgetWarning,
  isAutoMode = false,
  builderMode = false,
}: ChatViewInternalProps) {
  // TODO Phase 13-14: derive currentPlan, isExecuting, nextPlan from GSD2State
  // GSD2State has no .phases array — task/plan display will be rebuilt in Phase 13-14
  const currentPlan = undefined;
  const isExecuting = false;
  const nextPlan = undefined;

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
            onClose={onCloseTab ?? (() => {})}
            onCreate={onCreateClick ?? (() => {})}
            onRename={onRenameSession}
          />
          {/* EXECUTING badge — shown when auto mode is active */}
          {isAutoMode && (
            <span
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded px-2 py-0.5 font-display text-xs uppercase tracking-wider"
              style={{ backgroundColor: "#F59E0B", color: "#0F1419" }}
              role="status"
              aria-label="Auto mode executing"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              EXECUTING
            </span>
          )}
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
        <div className="flex items-center justify-between border-b border-navy-600 bg-navy-900/50 px-2 py-1">
          {/* EXECUTING badge (no-sessions variant) */}
          {isAutoMode ? (
            <span
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 font-display text-xs uppercase tracking-wider"
              style={{ backgroundColor: "#F59E0B", color: "#0F1419" }}
              role="status"
              aria-label="Auto mode executing"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              EXECUTING
            </span>
          ) : (
            <span />
          )}
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
      {/* EXECUTING badge — shown when no sessions and no preview toggle */}
      {!hasMultipleSessions && !onTogglePreview && isAutoMode && (
        <div className="flex items-center border-b border-navy-600 bg-navy-900/50 px-2 py-1">
          <span
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 font-display text-xs uppercase tracking-wider"
            style={{ backgroundColor: "#F59E0B", color: "#0F1419" }}
            role="status"
            aria-label="Auto mode executing"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
            EXECUTING
          </span>
        </div>
      )}

      {/* Migration banner — shown when v1 project (.planning/) detected without .gsd/ */}
      {planningState?.needsMigration && !migrationDismissed && (
        <MigrationBanner
          onRunMigration={onRunMigration ?? (() => {})}
          onDismiss={onDismissMigration ?? (() => {})}
        />
      )}

      {/* Crash recovery banner — shown when gsd process stops unexpectedly */}
      {isCrashed && (
        <div
          role="alert"
          className="mx-2 mt-2 rounded border bg-navy-900 p-3 font-mono text-xs"
          style={{ borderColor: "#F59E0B40" }}
        >
          <div className="flex items-start gap-2">
            <span style={{ color: "#F59E0B" }}>&#9888;</span>
            <div className="flex-1">
              <p className="font-display text-xs uppercase tracking-wider" style={{ color: "#F59E0B" }}>
                gsd process stopped unexpectedly
              </p>
              <p className="mt-0.5 text-slate-400">Chat history preserved.</p>
            </div>
            <button
              type="button"
              onClick={onDismissCrash}
              className="shrink-0 rounded px-2 py-1 text-xs font-mono transition-colors hover:bg-navy-700"
              style={{ color: "#5BC8F0", border: "1px solid #5BC8F0" }}
            >
              Reconnect
            </button>
          </div>
        </div>
      )}

      {/* Compact task status — only visible while GSD is actively working */}
      {(isExecuting || isChatProcessing || isAutoMode) && (
        <div className="border-b border-navy-600 bg-navy-900/50" data-testid="task-panel">
          <div className="relative p-2">
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
                lastCompleted={planningState?.projectState?.last_activity}
                nextTask={nextPlan ? `Plan ${nextPlan.plan}` : undefined}
                nextPlanNumber={nextPlan?.plan}
              />
            )}
            {/* Cost badge — hidden in Builder mode (BUILDER-02) */}
            {!builderMode && costState && costState.totalCost > 0 && (
              <span
                className="absolute right-2 top-2 font-mono text-xs tabular-nums"
                style={{
                  color:
                    costState.level === "critical"
                      ? "#EF4444"
                      : costState.level === "warning"
                        ? "#F59E0B"
                        : "#5BC8F0",
                }}
                title={
                  costState.budgetFraction !== null
                    ? `${Math.round(costState.budgetFraction * 100)}% of budget`
                    : "Running cost"
                }
              >
                {costState.formatted}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Budget warning banner — hidden in Builder mode (BUILDER-02); shown at critical level (95%+) */}
      {!builderMode && costState?.level === "critical" && (
        <div
          role="alert"
          className="mx-2 mt-1 flex items-center justify-between rounded border px-3 py-2 font-mono text-xs"
          style={{ borderColor: "#EF444440", backgroundColor: "#131C2B", color: "#EF4444" }}
        >
          <span>
            Budget limit nearly reached ({Math.round((costState.budgetFraction ?? 0) * 100)}%)
          </span>
          {onDismissBudgetWarning && (
            <button
              type="button"
              onClick={onDismissBudgetWarning}
              className="ml-2 text-slate-500 hover:text-slate-300"
              aria-label="Dismiss budget warning"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Chat panel takes remaining space, with drag-drop upload */}
      <div className="flex-1 min-h-0">
        <ChatDragDropUpload onAssetUploaded={onAssetUploaded ?? (() => {})}>
          <ChatPanel
            messages={chatMessages}
            onSend={onChatSend}
            isProcessing={isChatProcessing}
            overlay={discussOverlay}
            builderMode={builderMode}
          />
          {pendingAttachment && (
            <div className="absolute bottom-14 left-4 right-4 z-10 flex items-center gap-2 rounded-md bg-navy-700 border border-cyan-accent/30 px-3 py-2">
              <span className="text-xs text-cyan-accent font-mono truncate flex-1">
                Attached: {pendingAttachment.name}
              </span>
              <button
                type="button"
                onClick={onCloseAttachment}
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
        onClose={onConfirmClose ?? (() => {})}
        onCreateFresh={() => onCreateSession?.()}
        onCreateFork={() => onCreateSession?.(activeSessionId)}
      />

      {/* Close session modal (worktree sessions only) */}
      {closeModalSession && (
        <SessionCloseModal
          isOpen={true}
          sessionName={closeModalSession.name}
          onClose={onCancelClose ?? (() => {})}
          onMerge={() => {
            onCloseSession?.(closeModalSession.id);
            onConfirmMerge?.();
          }}
          onKeep={() => {
            onCloseSession?.(closeModalSession.id);
            onConfirmKeep?.();
          }}
          onDelete={() => {
            onCloseSession?.(closeModalSession.id);
            onConfirmDelete?.();
          }}
        />
      )}
    </div>
  );
}

/**
 * Stateful wrapper around ChatView that manages interactive state.
 * Use this in the app; use ChatView directly in tests.
 */
export function ChatViewConnected(props: ChatViewProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [closeModalSession, setCloseModalSession] = useState<SessionTab | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<AssetItem | null>(null);
  const [migrationDismissed, setMigrationDismissed] = useState(false);
  // Crash state — set to true by parent (via isCrashed prop) when process_crashed arrives
  // Wired to actual crash events in plan 13-05; local state here clears on dismiss
  const [localCrashed, setLocalCrashed] = useState(false);
  const isCrashed = props.isCrashed ?? localCrashed;
  const [budgetWarningDismissed, setBudgetWarningDismissed] = useState(false);

  // Escape key handler — interrupt auto mode
  useEffect(() => {
    if (!props.isAutoMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.onInterrupt) {
        e.preventDefault();
        props.onInterrupt();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [props.isAutoMode, props.onInterrupt]);

  const handleAssetUploaded = useCallback((asset: AssetItem) => {
    setPendingAttachment(asset);
  }, []);

  const handleChatSend = useCallback(
    (msg: string) => {
      if (pendingAttachment) {
        const prefix = `[Attached: .planning/assets/${pendingAttachment.name}]`;
        props.onChatSend(`${prefix}\n\n${msg}`);
        setPendingAttachment(null);
      } else {
        props.onChatSend(msg);
      }
    },
    [props.onChatSend, pendingAttachment],
  );

  const handleCloseTab = useCallback((id: string) => {
    const session = (props.sessions ?? []).find((s) => s.id === id);
    if (session?.hasWorktree) {
      setCloseModalSession(session);
    } else {
      props.onCloseSession?.(id);
    }
  }, [props.sessions, props.onCloseSession]);

  const handleCreateClick = useCallback(() => {
    setShowCreateModal(true);
  }, []);

  return (
    <ChatView
      {...props}
      onChatSend={handleChatSend}
      showCreateModal={showCreateModal}
      closeModalSession={closeModalSession}
      pendingAttachment={pendingAttachment}
      migrationDismissed={migrationDismissed}
      isCrashed={isCrashed}
      onDismissCrash={() => setLocalCrashed(false)}
      onAssetUploaded={handleAssetUploaded}
      onCloseAttachment={() => setPendingAttachment(null)}
      onRunMigration={() => {
        handleChatSend("/gsd migrate");
        setMigrationDismissed(true);
      }}
      onDismissMigration={() => setMigrationDismissed(true)}
      onCloseTab={handleCloseTab}
      onCreateClick={handleCreateClick}
      onConfirmClose={() => setShowCreateModal(false)}
      onConfirmMerge={() => setCloseModalSession(null)}
      onConfirmKeep={() => setCloseModalSession(null)}
      onConfirmDelete={() => setCloseModalSession(null)}
      onCancelClose={() => setCloseModalSession(null)}
      costState={
        budgetWarningDismissed && props.costState?.level === "critical"
          ? { ...props.costState, level: "warning" as const }
          : props.costState
      }
      onDismissBudgetWarning={() => setBudgetWarningDismissed(true)}
    />
  );
}
