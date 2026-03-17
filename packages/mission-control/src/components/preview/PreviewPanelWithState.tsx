/**
 * PreviewPanelWithState — stateful wrapper for PreviewPanel.
 *
 * Calls usePreview() internally and manages all server state.
 * No longer accepts port as a prop — the hook handles multi-server detection,
 * scan, and WebSocket preview_open events.
 *
 * Pattern matches ReviewViewWithAnimation (stateful) over ReviewView (pure).
 * onClose is required. onViewportChange is lifted to AppShell so viewport
 * changes persist to session file.
 */
import { useState } from "react";
import { PreviewPanel } from "./PreviewPanel";
import { usePreview } from "@/hooks/usePreview";
import type { Viewport } from "@/hooks/usePreview";

export interface PreviewPanelWithStateProps {
  initialViewport?: Viewport;
  onClose: () => void;
  onViewportChange?: (v: Viewport) => void;
  isNativeApp?: boolean;
}

export function PreviewPanelWithState({
  initialViewport = "desktop",
  onClose,
  onViewportChange,
  isNativeApp = false,
}: PreviewPanelWithStateProps) {
  const {
    servers,
    activeFrontendPort,
    activeBackendPort,
    scanning,
    setActiveFrontendPort,
    setActiveBackendPort,
    setViewport,
    triggerScan,
    addManualPort,
  } = usePreview();

  const [viewport, setLocalViewport] = useState<Viewport>(initialViewport);

  // Dual-mode independent server selectors
  const [dualLeftPort, setDualLeftPort] = useState<number | null>(activeFrontendPort);
  const [dualRightPort, setDualRightPort] = useState<number | null>(activeFrontendPort);

  const handleViewportChange = (v: Viewport) => {
    setLocalViewport(v);
    setViewport(v);
    onViewportChange?.(v);
  };

  return (
    <PreviewPanel
      servers={servers}
      activeFrontendPort={activeFrontendPort}
      activeBackendPort={activeBackendPort}
      viewport={viewport}
      scanning={scanning}
      onClose={onClose}
      onSelectFrontendPort={setActiveFrontendPort}
      onSelectBackendPort={setActiveBackendPort}
      onViewportChange={handleViewportChange}
      onScan={triggerScan}
      onAddManualPort={addManualPort}
      isNativeApp={isNativeApp}
      dualLeftPort={dualLeftPort}
      dualRightPort={dualRightPort}
      onDualLeftPortChange={setDualLeftPort}
      onDualRightPortChange={setDualRightPort}
    />
  );
}
