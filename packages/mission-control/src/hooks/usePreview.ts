/**
 * usePreview hook — live preview panel state management.
 *
 * Provides:
 * - open/servers/viewport/scanning state
 * - Cmd+P (or Ctrl+P on Windows) keyboard binding to toggle panel
 * - Raw WebSocket listener for preview_open and browser_state_update events from server
 * - Multi-server detection via scanForDevServers()
 * - Manual port addition via addManualPort()
 * - Browser agent screenshot state for headless Playwright relay
 *
 * Pure function extraction: shouldTogglePreview(e) exported for direct test
 * assertions without React renderer — same pattern as shouldPulseOnTaskChange.
 */
import { useState, useEffect } from "react";

export type Viewport = "desktop" | "tablet" | "mobile" | "dual";

export interface DetectedServer {
  port: number;
  type: "frontend" | "backend" | "unknown";
  label?: string; // e.g., "Vite (:5173)"
}

export interface UsePreviewReturn {
  open: boolean;
  servers: DetectedServer[];
  activeFrontendPort: number | null;
  activeBackendPort: number | null;
  viewport: Viewport;
  scanning: boolean;
  browserScreenshot: { screenshot: string; url: string; title: string; viewportWidth?: number } | null;
  browserViewportWidth: number | null;
  setOpen: (open: boolean) => void;
  setActiveFrontendPort: (port: number | null) => void;
  setActiveBackendPort: (port: number | null) => void;
  setViewport: (viewport: Viewport) => void;
  triggerScan: () => void;
  addManualPort: (port: number) => void;
  clearBrowserScreenshot: () => void;
}

export const CANDIDATE_PORTS = [3000, 4173, 5173, 8080, 8000];

/**
 * scanForDevServers — probe candidate ports and return responding servers.
 *
 * Uses mode: "no-cors" fetch with 800ms abort timeout per port.
 * Port type classification:
 * - 5173, 4173, 3000 → "frontend"
 * - 8080, 8000 → "backend"
 * - others → "unknown"
 */
export async function scanForDevServers(): Promise<DetectedServer[]> {
  const results = await Promise.allSettled(
    CANDIDATE_PORTS.map(async (port) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 800);
      try {
        await fetch(`http://localhost:${port}/`, {
          signal: controller.signal,
          mode: "no-cors",
        });
        clearTimeout(timer);
        // Port heuristic for type classification:
        const type = [5173, 4173, 3000].includes(port)
          ? ("frontend" as const)
          : [8080, 8000].includes(port)
          ? ("backend" as const)
          : ("unknown" as const);
        const label =
          port === 5173
            ? "Vite"
            : port === 4173
            ? "Vite Preview"
            : port === 3000
            ? "Dev"
            : port === 8080
            ? "API"
            : port === 8000
            ? "API"
            : `Port ${port}`;
        return { port, type, label: `${label} (:${port})` };
      } catch {
        clearTimeout(timer);
        throw new Error(`Port ${port} not responding`);
      }
    })
  );
  const found: DetectedServer[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      found.push(r.value);
    }
  }
  return found;
}

/**
 * Pure function: returns true if the keyboard event should toggle the preview panel.
 * Exported for direct test assertions without mounting the hook.
 *
 * Matches: (metaKey || ctrlKey) && key === "p" (lowercase only).
 */
export function shouldTogglePreview(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === "p";
}

/**
 * usePreview — preview panel state hook with multi-server support.
 *
 * Default state: open=false, servers=[], activeFrontendPort=null,
 *                activeBackendPort=null, viewport="desktop", scanning=false
 *
 * Keyboard: Cmd+P / Ctrl+P toggles open, calls e.preventDefault()
 * WebSocket: listens on ws://localhost:4001 for:
 *   - { type: "preview_open", port: number } — adds port and opens panel
 *   - { type: "browser_state_update", screenshot, url, title } — sets browser agent view
 */
export function usePreview(wsUrl: string = "ws://localhost:4001"): UsePreviewReturn {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<DetectedServer[]>([]);
  const [activeFrontendPort, setActiveFrontendPort] = useState<number | null>(null);
  const [activeBackendPort, setActiveBackendPort] = useState<number | null>(null);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [scanning, setScanning] = useState(false);
  const [browserScreenshot, setBrowserScreenshot] = useState<{ screenshot: string; url: string; title: string; viewportWidth?: number } | null>(null);

  const clearBrowserScreenshot = () => setBrowserScreenshot(null);

  const addManualPort = (port: number) => {
    setServers((prev) => {
      if (prev.find((s) => s.port === port)) return prev;
      return [
        ...prev,
        { port, type: "unknown", label: `Manual (:${port})` },
      ];
    });
    setActiveFrontendPort(port);
  };

  const triggerScan = () => {
    setScanning(true);
    scanForDevServers().then((found) => {
      setServers(found);
      const frontend = found.find((s) => s.type === "frontend");
      const backend = found.find((s) => s.type === "backend");
      if (frontend) setActiveFrontendPort(frontend.port);
      if (backend) setActiveBackendPort(backend.port);
      setScanning(false);
    });
  };

  // Keyboard binding: Cmd+P (macOS) / Ctrl+P (Windows) toggles preview
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (shouldTogglePreview(e)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  // WebSocket: listen for preview_open and browser_state_update broadcasts from server (pipeline.ts)
  // Auto-reconnects every 2 s if the connection drops or the server isn't ready yet.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      ws = new WebSocket(wsUrl);

      ws.onmessage = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data as string);
          if (data.type === "preview_open" && typeof data.port === "number") {
            if (data.port > 0) {
              addManualPort(data.port);
            }
            setOpen(true);
          }
          if (data.type === "browser_state_update" && typeof data.screenshot === "string") {
            setBrowserScreenshot({
              screenshot: data.screenshot,
              url: data.url ?? "",
              title: data.title ?? "",
              viewportWidth: data.viewportWidth,
            });
            setOpen(true);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          timer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  // Auto-clear browser screenshot after 10s of no updates (return to iframe mode)
  useEffect(() => {
    if (!browserScreenshot) return;
    const timer = setTimeout(() => setBrowserScreenshot(null), 10000);
    return () => clearTimeout(timer);
  }, [browserScreenshot]);

  return {
    open,
    servers,
    activeFrontendPort,
    activeBackendPort,
    viewport,
    scanning,
    browserScreenshot,
    browserViewportWidth: browserScreenshot?.viewportWidth ?? null,
    setOpen,
    setActiveFrontendPort,
    setActiveBackendPort,
    setViewport,
    triggerScan,
    addManualPort,
    clearBrowserScreenshot,
  };
}
