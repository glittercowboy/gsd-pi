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
import { useState, useEffect, useRef, useCallback } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { SingleColumnView } from "@/components/layout/SingleColumnView";
import { PreviewPanelWithState } from "@/components/preview/PreviewPanelWithState";
import { PermissionModal } from "@/components/modals/PermissionModal";
import { FolderPickerModal } from "@/components/modals/FolderPickerModal";
import { LoadingLogo } from "@/components/session/LoadingLogo";
import { OnboardingScreen } from "@/components/session/OnboardingScreen";
import { ResumeCard } from "@/components/session/ResumeCard";
import ProjectHomeScreen from "@/components/workspace/ProjectHomeScreen";
import ProjectTabBar from "@/components/workspace/ProjectTabBar";
import type { OpenProject } from "@/components/workspace/ProjectTabBar";
import { usePlanningState } from "@/hooks/usePlanningState";
import { useSessionFlow } from "@/hooks/useSessionFlow";
import { useSessionManager } from "@/hooks/useSessionManager";
import { useSidebarNav } from "@/hooks/useSidebarNav";
import { useChatMode } from "@/hooks/useChatMode";
import { usePreview } from "@/hooks/usePreview";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { useSettings } from "@/hooks/useSettings";
import { useBuilderMode } from "@/hooks/useBuilderMode";
import { InterfaceModeProvider } from "@/context/InterfaceModeContext";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { readSession, writeSession } from "@/server/session-persistence-api";
import type { MissionControlSession } from "@/server/session-persistence-api";
import type { IntentType } from "@/server/classify-intent-api";

// Planning directory — usePlanningState does not expose planningDir, fall back to ".planning"
const PLANNING_DIR = ".planning";

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const { state, status } = usePlanningState();
  const { mode, continueHere, dismiss, goHome } = useSessionFlow(state, status);

  // Multi-project tab state (WORKSPACE-04)
  const [openProjects, setOpenProjects] = useState<OpenProject[]>([]);
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null);

  // Load settings to get budget_ceiling for cost tracking
  const { settings } = useSettings();
  const budgetCeiling = typeof settings?.merged?.budget_ceiling === "number"
    ? settings.merged.budget_ceiling
    : null;

  // Builder mode — read from settings (BUILDER-01)
  const { builderMode } = useBuilderMode();

  // Builder mode routing state (BUILDER-04)
  const [routingBadgeState, setRoutingBadgeState] = useState<{
    intent: Exclude<IntentType, "UI_PHASE_GATE">;
    originalMessage: string;
    sentAs: string;
  } | null>(null);
  const [phaseGateState, setPhaseGateState] = useState<{ originalMessage: string } | null>(null);
  const [isClassifying, setIsClassifying] = useState(false);

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

  // handleBuilderSend: classify intent before dispatching in Builder mode (BUILDER-04)
  const handleBuilderSend = useCallback(async (message: string) => {
    if (!builderMode) {
      sendMessage(message);
      return;
    }
    setIsClassifying(true);
    try {
      const stateContent = JSON.stringify(state?.projectState ?? "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch("/api/classify-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, stateContext: stateContent }),
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timer);

      const intent: IntentType | null = res?.ok
        ? ((await res.json().catch(() => null))?.intent ?? null)
        : null;

      if (intent === "UI_PHASE_GATE") {
        setPhaseGateState({ originalMessage: message });
        return;
      }

      const resolvedIntent = (intent as Exclude<IntentType, "UI_PHASE_GATE"> | null) ?? "GENERAL_CODING";
      const sentAs = resolvedIntent === "GSD_COMMAND" ? "/gsd auto" : message;
      setRoutingBadgeState({ intent: resolvedIntent, originalMessage: message, sentAs });
      sendMessage(sentAs);
    } finally {
      setIsClassifying(false);
    }
  }, [builderMode, sendMessage, state]);

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

  // Home: project hub shown when user navigates home or has no active project (WORKSPACE-02)
  if (mode === "home") {
    return (
      <>
        <ProjectHomeScreen
          builderMode={builderMode}
          onOpenProject={(path) => {
            // Add to open projects list if not already there
            setOpenProjects((prev) => {
              if (prev.find((p) => p.path === path)) return prev;
              return [
                ...prev,
                {
                  id: path,
                  path,
                  name: path.split("/").pop() ?? path,
                  isProcessing: false,
                  isActive: true,
                },
              ];
            });
            setActiveProjectPath(path);
            // Switch pipeline to this project path
            fetch("/api/session/switch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path }),
            }).catch(() => {});
            dismiss();
          }}
          onOpenFolder={() => setFolderPickerOpen(true)}
          onCreateProject={async (name) => {
            const res = await fetch("/api/workspace/create", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            }).catch(() => null);
            if (res?.ok) {
              const { projectPath } = await res.json();
              setOpenProjects((prev) => [
                ...prev,
                {
                  id: projectPath,
                  path: projectPath,
                  name,
                  isProcessing: false,
                  isActive: true,
                },
              ]);
              setActiveProjectPath(projectPath);
              dismiss();
            }
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

  // Onboarding: full-screen welcome for new projects
  if (mode === "onboarding") {
    return (
      <>
        <OnboardingScreen
          onOpenProject={() => setFolderPickerOpen(true)}
          onNewProject={async (name, location) => {
            const res = await fetch("/api/workspace/create", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, workspacePath: location }),
            }).catch(() => null);
            if (res?.ok) {
              const { projectPath } = await res.json();
              setOpenProjects((prev) => {
                if (prev.find((p) => p.path === projectPath)) return prev;
                return [
                  ...prev,
                  {
                    id: projectPath,
                    path: projectPath,
                    name,
                    isProcessing: false,
                    isActive: true,
                  },
                ];
              });
              setActiveProjectPath(projectPath);
              await fetch("/api/project/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: projectPath }),
              }).catch(() => {});
              dismiss();
              setActiveView({ kind: "chat" });
            }
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
      {/* Project tab bar — visible only when 2+ projects are open (WORKSPACE-04) */}
      <ProjectTabBar
        openProjects={openProjects.map((p) => ({ ...p, isActive: p.path === activeProjectPath }))}
        onSwitchProject={(path) => {
          setActiveProjectPath(path);
          fetch("/api/session/switch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          }).catch(() => {});
        }}
      />
      <div className="flex flex-1 min-h-0 overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((prev) => !prev)}
        connectionStatus={status}
        projectState={state?.projectState ?? null}
        configState={null}
        activeView={activeView}
        onSelectView={(view) => {
          setActiveView(view);
          if (view.kind !== "chat") setPreviewOpen(false);
        }}
        onOpenFolder={() => setFolderPickerOpen(true)}
        projectName={
          state?.projectState?.milestone_name ||
          (activeProjectPath
            ? (activeProjectPath.split(/[\\/]/).filter(Boolean).pop() ?? undefined)
            : undefined)
        }
      />
      <div className="flex flex-1 min-w-0 overflow-hidden">
        <div className={previewOpen ? "flex flex-col w-[380px] min-w-[320px] shrink-0" : "flex flex-col flex-1 min-w-0"}>
          <SingleColumnView
            activeView={activeView}
            planningState={state}
            chatMessages={activeMessages}
            onChatSend={handleBuilderSend}
            isChatProcessing={isActiveProcessing || isClassifying}
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
            builderMode={builderMode}
            routingBadgeState={routingBadgeState}
            phaseGateState={phaseGateState}
            onClearRoutingBadge={() => setRoutingBadgeState(null)}
            onClearPhaseGate={() => setPhaseGateState(null)}
            onSendDirectMessage={sendMessage}
          />
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
        {previewOpen && (
          <div className="flex-1 min-w-0 h-full border-l border-navy-600">
            <PreviewPanelWithState
              initialPort={previewPort}
              initialViewport={viewport}
              onClose={() => setPreviewOpen(false)}
              onViewportChange={setViewport}
            />
          </div>
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
      {/* Command palette — Ctrl+Shift+P / Cmd+Shift+P to open; gated in Builder mode */}
      <CommandPalette
        open={builderMode ? false : paletteOpen}
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

/**
 * AppShellWithMode — thin wrapper that reads builderMode from settings
 * and wraps AppShell in InterfaceModeProvider.
 *
 * Used by App.tsx instead of AppShell directly so the provider is above
 * the entire component tree. Brief flash (Developer mode while settings load)
 * is acceptable — same pattern as trust/auth checking.
 */
export function AppShellWithMode() {
  const { settings } = useSettings();
  const builderMode = settings?.merged?.interface_mode === "builder";
  return (
    <InterfaceModeProvider builderMode={builderMode}>
      <AppShell />
    </InterfaceModeProvider>
  );
}
