/**
 * PreviewPanel — pure render component for the live preview overlay.
 *
 * No hooks, no side effects. Accepts all state and callbacks as props.
 * Pattern matches ReviewView (pure) + ReviewViewWithAnimation (stateful).
 *
 * Slide-in animation: "animate-in slide-in-from-right duration-200"
 * identical to DecisionLogDrawer.tsx
 *
 * Props:
 * - port: current dev server port (null = no server detected)
 * - viewport: current viewport mode
 * - onClose: callback for close button
 * - onPortChange: callback when port input changes
 * - onViewportChange: callback for viewport button clicks
 * - isNativeApp: show "No web preview" empty state
 */
import { X } from "lucide-react";
import { ViewportSwitcher } from "./ViewportSwitcher";
import { DeviceFrame } from "./DeviceFrame";
import type { Viewport } from "@/hooks/usePreview";

export interface PreviewPanelProps {
  port: number | null;
  viewport: Viewport;
  onClose: () => void;
  onPortChange: (port: number | null) => void;
  onViewportChange: (viewport: Viewport) => void;
  isNativeApp?: boolean;
}

export function PreviewPanel({
  port,
  viewport,
  onClose,
  onPortChange,
  onViewportChange,
  isNativeApp = false,
}: PreviewPanelProps) {
  const iframeSrc = port ? `/api/preview/` : undefined;

  return (
    <div className="animate-in slide-in-from-right duration-200 flex flex-col h-full bg-[#0F1419]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-navy-700 px-3 py-2 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs font-display uppercase tracking-wider text-slate-300">
            Live Preview
          </span>

          {/* Port input */}
          <input
            type="number"
            value={port ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              onPortChange(val ? Number(val) : null);
            }}
            placeholder="port"
            className="w-16 bg-navy-800 border border-navy-600 rounded px-2 py-0.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-accent/50"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Viewport switcher in header */}
          <ViewportSwitcher viewport={viewport} onViewportChange={onViewportChange} />

          {/* Close button */}
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-navy-700 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto flex items-center justify-center bg-[#0a0d12]">
        {isNativeApp ? (
          <div className="text-center text-slate-500">
            <p className="text-sm">No web preview available for native apps</p>
          </div>
        ) : viewport === "dual" ? (
          /* Dual mode: two device frames side by side */
          <div className="flex items-start gap-6 p-6">
            <DeviceFrame
              device="iphone"
              src={iframeSrc}
              iframeId="preview-iframe-iphone"
            />
            <DeviceFrame
              device="pixel"
              src={iframeSrc}
              iframeId="preview-iframe-pixel"
            />
          </div>
        ) : (
          /* Single viewport: one iframe filling the content area */
          <iframe
            src={iframeSrc}
            className="w-full h-full border-none"
            title="Live Preview"
            style={{
              maxWidth:
                viewport === "desktop"
                  ? "100%"
                  : viewport === "tablet"
                    ? 768
                    : 375,
            }}
          />
        )}
      </div>
    </div>
  );
}
