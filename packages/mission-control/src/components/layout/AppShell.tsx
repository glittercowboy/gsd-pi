/**
 * AppShell — top-level layout with session flow routing.
 *
 * Routes through session state machine:
 * - "initializing" -> LoadingLogo
 * - "onboarding" -> OnboardingScreen
 * - "resume" / "dashboard" -> Normal dashboard with optional ResumeCard overlay
 *
 * Uses useSidebarNav for view state, passes activeView to both
 * Sidebar and SingleColumnView. Wires PermissionModal and FolderPickerModal overlays.
 * Uses useSessionManager for multi-session chat support.
 * Uses usePreview for live preview panel state (Cmd+P toggle, port detection).
 */
import { useState, useEffect, useRef } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { SingleColumnView } from "@/components/layout/SingleColumnView";
import { PreviewPanelWithState } from "@/components/preview/PreviewPanelWithState";
import { PermissionModal } from "@/components/modals/PermissionModal";
import { FolderPickerModal } from "@/components/modals/FolderPickerModal";
import { LoadingLogo } from "@/components/session/LoadingLogo";
import { OnboardingScreen } from "@/components/session/OnboardingScreen";
import { ResumeCard } from "@/components/session/ResumeCard";
import { usePlanningState } from "@/hooks/usePlanningState";
import { useSessionFlow } from "@/hooks/useSessionFlow";
import { useSessionManager } from "@/hooks/useSessionManager";
import { useSidebarNav } from "@/hooks/useSidebarNav";
import { useChatMode } from "@/hooks/useChatMode";
import { usePreview } from "@/hooks/usePreview";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { useSettings } from "@/hooks/useSettings";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { readSession, writeSession } from "@/server/session-persistence-api";
import type { MissionControlSession } from "@/server/session-persistence-api";

// Planning directory — usePlanningState does not expose planningDir, fall back to ".planning"
const PLANNING_DIR = ".planning";

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const { state, status } = usePlanningState();
  const { mode, continueHere, dismiss } = useSessionFlow(state, status);

  // Load settings to get budget_ceiling for cost tracking
  const { settings } = useSettings();
  const budgetCeiling = typeof settings?.merged?.budget_ceiling === "number"
    ? settings.merged.budget_ceiling
    : null;

  const {
    sessions,
    activeSessionId,
    activeMessages,
    isActiveProcessing,
    selectSession,
    createSession,
    closeSession,
    renameSession,
    sendMessage,
    permissionPrompt,
    respondToPermission,
    isAutoMode,
    isCrashed,
    costState,
    interrupt,
    resetCrash,
    boundaryViolation,
    dismissBoundaryViolation,
  } = useSessionManager("ws://localhost:4001", { budgetCeiling });

  const { activeView, setActiveView } = useSidebarNav();

  // Keyboard shortcuts — command palette (Ctrl+Shift+P) and panel switching (Ctrl+1-5)
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const { headingRef } = usePanelFocus((kind) => setActiveView({ kind }));

  const { overlay: discussOverlay, reviewResults, handleFix, dismissReview, chatModeState } = useChatMode(
    "ws://localhost:4001",
    sendMessage,
  );

  // Live preview state — Cmd+P keyboard binding handled inside usePreview
  const { open: previewOpen, port: previewPort, viewport, setOpen: setPreviewOpen, setViewport } = usePreview();

  // Session ref — tracks last read session data for partial viewport writes
  const sessionRef = useRef<MissionControlSession | null>(null);

  // Restore activeViewport from session file on mount
  useEffect(() => {
    readSession(PLANNING_DIR).then((session) => {
      sessionRef.current = session;
      setViewport(session.activeViewport);
    });
  }, [setViewport]);

  // Write viewport to session file whenever it changes
  useEffect(() => {
    if (sessionRef.current) {
      const updated: MissionControlSession = { ...sessionRef.current, activeViewport: viewport };
      sessionRef.current = updated;
      writeSession(PLANNING_DIR, updated);
    }
  }, [viewport]);

  // Write viewport to session file on beforeunload (sync, best-effort)
  useEffect(() => {
    const handler = () => {
      if (sessionRef.current) {
        writeSession(PLANNING_DIR, { ...sessionRef.current, activeViewport: viewport });
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [viewport]);

  // Switch to review ViewType when review mode activates; return to chat when it ends
  useEffect(() => {
    if (chatModeState.mode === "review") {
      setActiveView({ kind: "review" });
    } else if (activeView.kind === "review" && chatModeState.mode === "chat") {
      setActiveView({ kind: "chat" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatModeState.mode]);

  // Initializing: show loading logo centered
  if (mode === "initializing") {
    return (
      <div className="flex h-screen items-center justify-center bg-navy-base">
        <LoadingLogo />
      </div>
    );
  }

  // Onboarding: full-screen welcome for new projects
  if (mode === "onboarding") {
    return (
      <>
        <OnboardingScreen
          onOpenFolder={() => setFolderPickerOpen(true)}
          onStartChat={() => {
            dismiss();
            setActiveView({ kind: "chat" });
          }}
        />
        <FolderPickerModal
          open={folderPickerOpen}
          onClose={() => setFolderPickerOpen(false)}
          onSelect={() => dismiss()}
        />
      </>
    );
  }

  // Dashboard (with optional ResumeCard overlay)
  return (
    <div className="flex flex-col h-screen bg-navy-base">
      {/* Boundary violation banner — shown when AI attempted out-of-project file access (PERM-03) */}
      {boundaryViolation && (
        <div
          role="alert"
          style={{
            background: "#EF4444",
            color: "#fff",
            padding: "10px 16px",
            fontSize: "13px",
            fontFamily: "JetBrains Mono, monospace",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            flexShrink: 0,
          }}
        >
          <span>
            The AI attempted to access a file outside your project:{" "}
            <code>{boundaryViolation.path}</code>. The operation was blocked.
          </span>
          <button
            type="button"
            onClick={dismissBoundaryViolation}
            style={{
              background: "transparent",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "12px",
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((prev) => !prev)}
        connectionStatus={status}
        projectState={state?.state ?? null}
        configState={state?.config ?? null}
        activeView={activeView}
        onSelectView={setActiveView}
        onOpenFolder={() => setFolderPickerOpen(true)}
      />
      <div className="relative min-w-0 flex-1">
        <SingleColumnView
          activeView={activeView}
          planningState={state}
          chatMessages={activeMessages}
          onChatSend={sendMessage}
          isChatProcessing={isActiveProcessing}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={selectSession}
          onCreateSession={createSession}
          onCloseSession={closeSession}
          onRenameSession={renameSession}
          reviewResults={reviewResults}
          onReviewDismiss={dismissReview}
          onReviewFix={handleFix}
          discussOverlay={discussOverlay}
          onTogglePreview={() => setPreviewOpen(!previewOpen)}
          previewOpen={previewOpen}
          headingRef={headingRef}
          isAutoMode={isAutoMode}
          isCrashed={isCrashed}
          costState={costState}
          onInterrupt={interrupt}
          onDismissCrash={resetCrash}
          onMilestoneAction={(action) => {
            if (action.type === 'send_message') {
              sendMessage(action.message);
            } else if (action.type === 'interrupt') {
              interrupt();
            }
          }}
        />
        {/* Preview panel — absolute inset-0 with left offset to preserve Chat column 1 */}
        {previewOpen && (
          <div className="absolute inset-0 left-[340px] z-30">
            <PreviewPanelWithState
              initialPort={previewPort}
              initialViewport={viewport}
              onClose={() => setPreviewOpen(false)}
              onViewportChange={setViewport}
            />
          </div>
        )}
        {mode === "resume" && continueHere && (
          <ResumeCard
            data={continueHere}
            onResume={() => {
              dismiss();
              setActiveView({ kind: "chat" });
            }}
            onDismiss={dismiss}
          />
        )}
      </div>
      <PermissionModal
        prompt={permissionPrompt}
        onRespond={respondToPermission}
      />
      <FolderPickerModal
        open={folderPickerOpen}
        onClose={() => setFolderPickerOpen(false)}
        onSelect={() => dismiss()}
      />
      {/* Command palette — Ctrl+Shift+P / Cmd+Shift+P to open */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectCommand={(cmd) => {
          setPaletteOpen(false);
          setActiveView({ kind: "chat" });
          sendMessage(cmd);
        }}
      />
      </div>
    </div>
  );
}
