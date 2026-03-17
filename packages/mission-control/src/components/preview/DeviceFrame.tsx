/**
 * DeviceFrame — CSS device frame shells for Dual preview mode.
 *
 * Renders iPhone 14 and Pixel 7 styled frames containing iframes.
 * Each iframe is wrapped in ErrorBoundaryFrame so a crash shows
 * "Preview unavailable" inside the device shell without taking down the app.
 * Pure render component: no hooks, no side effects.
 *
 * Dimensions from RESEARCH.md:
 * - iPhone 14: 390x750, border-radius 47
 * - Pixel 7: 412x750, border-radius 17
 */
import { ErrorBoundaryFrame } from "./ErrorBoundaryFrame";

export const DEVICE_FRAMES = {
  iphone: { width: 390, height: 750, radius: 47, label: "iPhone 14" },
  pixel: { width: 412, height: 750, radius: 17, label: "Pixel 7" },
} as const;

export type DeviceType = keyof typeof DEVICE_FRAMES;

export interface DeviceFrameProps {
  device: DeviceType;
  src?: string;
  iframeId: string;
}

export function DeviceFrame({ device, src, iframeId }: DeviceFrameProps) {
  const frame = DEVICE_FRAMES[device];
  const isIphone = device === "iphone";

  return (
    <div className="flex flex-col items-center gap-2">
      {/* Device label */}
      <span className="text-xs text-slate-500 font-mono">{frame.label}</span>

      {/* Device shell */}
      <div
        style={{
          width: frame.width,
          height: frame.height,
          borderRadius: frame.radius,
          border: "2px solid rgba(255,255,255,0.12)",
          background: "#0a0d12",
          overflow: "hidden",
          position: "relative",
          flexShrink: 0,
        }}
      >
        {/* Notch (iPhone) or punch-hole (Pixel) cosmetic indicator */}
        {isIphone ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: "50%",
              transform: "translateX(-50%)",
              width: 120,
              height: 30,
              background: "#0a0d12",
              borderBottomLeftRadius: 16,
              borderBottomRightRadius: 16,
              zIndex: 10,
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.15)",
              zIndex: 10,
            }}
          />
        )}

        {/* Content iframe wrapped in ErrorBoundaryFrame for crash isolation */}
        <ErrorBoundaryFrame>
          <iframe
            id={iframeId}
            src={src}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              display: "block",
            }}
            title={frame.label}
          />
        </ErrorBoundaryFrame>
      </div>
    </div>
  );
}
