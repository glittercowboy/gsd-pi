/**
 * Sidebar — VS Code-style sidebar with project tree navigation.
 *
 * - GsdLogo + Projects label + collapse toggle (top)
 * - New Window + Open Folder action buttons
 * - ProjectTree with nav items
 * - ConnectionStatus (bottom)
 */
import { useCallback } from "react";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { PanelLeftClose, PanelLeft, ExternalLink, FolderOpen, Settings, MessageSquare, Flag, Clock, Images, Code } from "lucide-react";
import { cn } from "@/lib/utils";
import { LAYOUT_DEFAULTS } from "@/styles/design-tokens";
import { GsdLogo } from "@/components/sidebar/GsdLogo";
import { ProjectTree } from "@/components/sidebar/ProjectTree";
import { ConnectionStatus } from "@/components/sidebar/ConnectionStatus";
import type { ConnectionStatus as ConnectionStatusType } from "@/hooks/useReconnectingWebSocket";
import type { GSD2ProjectState, ConfigState } from "@/server/types";
import type { ViewType } from "@/lib/view-types";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  connectionStatus: ConnectionStatusType;
  projectState: GSD2ProjectState | null;
  configState: ConfigState | null;
  activeView: ViewType;
  onSelectView: (view: ViewType) => void;
  onOpenFolder: () => void;
  projectName?: string;
  onOpenCodeExplorer?: () => void;
}

export function Sidebar({
  collapsed,
  onToggle,
  connectionStatus,
  projectState,
  configState,
  activeView,
  onSelectView,
  onOpenFolder,
  projectName,
  onOpenCodeExplorer,
}: SidebarProps) {
  const handleNewWindow = useCallback(() => {
    window.open(location.href, "_blank");
  }, []);

  const { updateReady, installing, installUpdate } = useAppUpdater();

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-navy-600 bg-navy-900 transition-all duration-200",
      )}
      style={{
        width: collapsed
          ? LAYOUT_DEFAULTS.sidebarCollapsedWidth
          : LAYOUT_DEFAULTS.sidebarWidth,
        minWidth: collapsed
          ? LAYOUT_DEFAULTS.sidebarCollapsedWidth
          : LAYOUT_DEFAULTS.sidebarWidth,
      }}
    >
      {/* Top header — collapse toggle only when collapsed, logo+label+toggle when expanded */}
      {collapsed ? (
        <div className="flex h-[48px] items-center justify-center border-b border-navy-600">
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="flex h-8 w-8 items-center justify-center rounded text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="flex h-[48px] items-center gap-2 border-b border-navy-600 px-3">
          <GsdLogo className="h-7 w-7 shrink-0" />
          <div className="flex-1" />
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Action buttons — vertically stacked */}
      {!collapsed && (
        <div className="flex flex-col px-2">
          {projectName && (
            <div className="flex items-center gap-2 px-2 py-2 border-b border-navy-600 mb-1">
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="truncate text-xs font-mono font-medium text-slate-300" title={projectName}>{projectName}</span>
            </div>
          )}
          <button
            type="button"
            onClick={handleNewWindow}
            className="flex min-h-[44px] items-center gap-2 rounded p-2 text-sm text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300"
            title="New Window"
          >
            <ExternalLink className="h-4 w-4" />
            <span>New Window</span>
          </button>
          <button
            type="button"
            onClick={onOpenFolder}
            className="flex min-h-[44px] items-center gap-2 rounded p-2 text-sm text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300"
            title="Open Project"
          >
            <FolderOpen className="h-4 w-4" />
            <span>Open Project</span>
          </button>
          <button
            type="button"
            onClick={onOpenCodeExplorer}
            className="flex min-h-[44px] items-center gap-2 rounded p-2 text-sm text-slate-400 transition-colors hover:bg-navy-700 hover:text-slate-300"
            title="Code Explorer"
          >
            <Code className="h-4 w-4" />
            <span>Code Explorer</span>
          </button>
        </div>
      )}

      {/* Body: Project tree */}
      <div className="flex-1 overflow-auto scrollbar-thin" style={{ scrollbarWidth: "thin", scrollbarColor: "#334155 transparent" }}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1 py-2">
            <button
              type="button"
              onClick={handleNewWindow}
              aria-label="New Window"
              title="New Window"
              className="flex min-h-[44px] w-full items-center justify-center rounded transition-colors hover:bg-navy-700 text-slate-400 hover:text-slate-300"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onOpenFolder}
              aria-label="Open Project"
              title="Open Project"
              className="flex min-h-[44px] w-full items-center justify-center rounded transition-colors hover:bg-navy-700 text-slate-400 hover:text-slate-300"
            >
              <FolderOpen className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onOpenCodeExplorer}
              aria-label="Code Explorer"
              title="Code Explorer"
              className="flex min-h-[44px] w-full items-center justify-center rounded transition-colors hover:bg-navy-700 text-slate-400 hover:text-slate-300"
            >
              <Code className="h-4 w-4" />
            </button>
            {(
              [
                { icon: MessageSquare, kind: "chat" },
                { icon: Flag, kind: "milestone" },
                { icon: Clock, kind: "history" },
                { icon: Images, kind: "assets" },
              ] as const
            ).map(({ icon: Icon, kind }) => (
              <button
                key={kind}
                type="button"
                onClick={() => onSelectView({ kind })}
                aria-label={kind}
                title={kind.charAt(0).toUpperCase() + kind.slice(1)}
                className={cn(
                  "flex min-h-[44px] w-full items-center justify-center rounded transition-colors hover:bg-navy-700",
                  activeView.kind === kind
                    ? "text-cyan-accent"
                    : "text-slate-400 hover:text-slate-300",
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        ) : (
          <ProjectTree
            projectState={projectState}
            activeView={activeView}
            onSelectView={onSelectView}
          />
        )}
      </div>

      {/* Settings gear icon */}
      <div className="border-t border-navy-600 p-2">
        <button
          type="button"
          onClick={() => onSelectView({ kind: "settings" })}
          aria-label="Settings"
          title="Settings"
          className={cn(
            "flex min-h-[44px] w-full items-center gap-2 rounded p-2 text-sm transition-colors hover:bg-navy-700",
            activeView.kind === "settings"
              ? "text-cyan-accent"
              : "text-slate-400 hover:text-slate-300",
          )}
        >
          <Settings className="h-4 w-4" />
          {!collapsed && <span>Settings</span>}
        </button>
      </div>

      {/* Update notification — shown when background download is complete */}
      {updateReady && (
        <div
          className="border-t p-2"
          style={{ borderColor: '#1E2D3D', backgroundColor: '#131C2B' }}
        >
          <button
            type="button"
            onClick={installUpdate}
            disabled={installing}
            title="Restart to apply update"
            className="flex w-full items-center gap-2 rounded p-2 text-xs transition-colors hover:bg-navy-700"
            style={{ color: '#5BC8F0' }}
          >
            <span style={{ fontSize: '10px' }}>↑</span>
            {!collapsed && (
              <span>{installing ? 'Installing…' : 'Update ready — restart to apply'}</span>
            )}
          </button>
        </div>
      )}

      {/* Bottom: Connection status */}
      <div className="border-t border-navy-600 p-2">
        <ConnectionStatus
          status={connectionStatus}
          modelProfile={configState?.model_profile}
          collapsed={collapsed}
        />
      </div>
    </aside>
  );
}
