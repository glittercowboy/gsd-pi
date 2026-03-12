/**
 * SingleColumnView — view router for sidebar-driven navigation.
 *
 * Renders one full-width view component based on the active ViewType.
 * Replaces TabLayout's tab-switching mechanism.
 */
import { ChatViewConnected as ChatView } from "@/components/views/ChatView";
import { MilestoneView } from "@/components/views/MilestoneView";
import { HistoryView } from "@/components/views/HistoryView";
import { SettingsView } from "@/components/views/SettingsView";
import { AssetsView } from "@/components/views/AssetsView";
import { ReviewViewWithAnimation } from "@/components/views/ReviewView";
import type { ViewType } from "@/lib/view-types";
import type { PlanningState } from "@/server/types";
import type { ChatMessage, ReviewResults } from "@/server/chat-types";
import type { SessionTab } from "@/hooks/useSessionManager";
import type { CostState } from "@/hooks/useCostTracker";
import type React from "react";

interface SingleColumnViewProps {
  activeView: ViewType;
  planningState: PlanningState | null;
  chatMessages: ChatMessage[];
  onChatSend: (msg: string) => void;
  isChatProcessing: boolean;
  /** Multi-session props */
  sessions?: SessionTab[];
  activeSessionId?: string;
  onSelectSession?: (id: string) => void;
  onCreateSession?: (forkFrom?: string) => void;
  onCloseSession?: (id: string) => void;
  onRenameSession?: (id: string, name: string) => void;
  /** Review mode props — wired from useChatMode via AppShell (Plan 04) */
  reviewResults?: ReviewResults | null;
  onReviewDismiss?: () => void;
  onReviewFix?: (draftMessage: string) => void;
  /** Discuss mode overlay — QuestionCard + DecisionLogDrawer from useChatMode */
  discussOverlay?: React.ReactNode;
  /** Preview toggle — wired from usePreview via AppShell */
  onTogglePreview?: () => void;
  previewOpen?: boolean;
  /**
   * headingRef — programmatic focus target for keyboard panel switching (KEYS-06).
   * Attached to the main element (tabIndex={-1}) so focus moves after Ctrl+1-5.
   * Ref is typed HTMLHeadingElement for usePanelFocus compatibility; attached to main via cast.
   */
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
  /** Phase 13 props — wired from useSessionManager via AppShell */
  isAutoMode?: boolean;
  isCrashed?: boolean;
  costState?: CostState;
  onInterrupt?: () => void;
  onDismissCrash?: () => void;
}

export function SingleColumnView({
  activeView,
  planningState,
  chatMessages,
  onChatSend,
  isChatProcessing,
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  onRenameSession,
  reviewResults,
  onReviewDismiss,
  onReviewFix,
  discussOverlay,
  onTogglePreview,
  previewOpen,
  headingRef,
  isAutoMode,
  isCrashed,
  costState,
  onInterrupt,
  onDismissCrash,
}: SingleColumnViewProps) {
  return (
    // tabIndex={-1} enables programmatic focus after Ctrl+1-5 panel switch (KEYS-06)
    <main
      className="flex-1 min-w-0 h-full overflow-hidden"
      tabIndex={-1}
      ref={headingRef as React.RefObject<HTMLElement | null>}
    >
      <div key={activeView.kind} className="animate-in fade-in duration-200 h-full">
      {activeView.kind === "chat" && (
        <ChatView
          planningState={planningState}
          chatMessages={chatMessages}
          onChatSend={onChatSend}
          isChatProcessing={isChatProcessing}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onCloseSession={onCloseSession}
          onRenameSession={onRenameSession}
          discussOverlay={discussOverlay}
          onTogglePreview={onTogglePreview}
          previewOpen={previewOpen}
          isAutoMode={isAutoMode}
          isCrashed={isCrashed}
          costState={costState}
          onInterrupt={onInterrupt}
          onDismissCrash={onDismissCrash}
        />
      )}
      {activeView.kind === "milestone" && (
        <MilestoneView
          planningState={planningState}
          sessions={sessions?.map((s) => ({
            id: s.id,
            name: s.name,
            worktreePath: s.hasWorktree ? "(worktree)" : null,
            worktreeBranch: s.worktreeBranch,
          }))}
        />
      )}
      {activeView.kind === "history" && (
        <HistoryView />
      )}
      {activeView.kind === "settings" && (
        <SettingsView />
      )}
      {activeView.kind === "assets" && (
        <AssetsView />
      )}
      {activeView.kind === "review" && reviewResults && (
        <ReviewViewWithAnimation
          results={reviewResults}
          onDismiss={onReviewDismiss ?? (() => {})}
          onFix={onReviewFix ?? (() => {})}
        />
      )}
      </div>
    </main>
  );
}
