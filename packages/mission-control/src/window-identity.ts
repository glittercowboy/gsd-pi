/**
 * Per-window identity for multi-window isolation.
 * Each Tauri window gets a unique windowId from sessionStorage.
 * The server creates a separate pipeline (with its own WS port) per window.
 */

const ID_KEY = "mc-window-id";
const WS_PORT_KEY = "mc-ws-port";
const API_BASE = "http://127.0.0.1:4200";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export let windowId: string = "";
export let wsPort: number = 4001;

/**
 * Initialize window identity:
 * 1. Get or generate windowId from sessionStorage
 * 2. Register with server to get a dedicated wsPort
 * 3. Patch global fetch to add X-Window-Id header for all /api/ calls
 */
export async function initWindowIdentity(): Promise<void> {
  let id = sessionStorage.getItem(ID_KEY);
  if (!id) {
    id = generateId();
    sessionStorage.setItem(ID_KEY, id);
  }
  windowId = id;

  try {
    const res = await fetch(`${API_BASE}/api/window/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windowId: id }),
    });
    if (res.ok) {
      const data = await res.json() as { wsPort: number };
      wsPort = data.wsPort;
      sessionStorage.setItem(WS_PORT_KEY, String(wsPort));
    }
  } catch {
    const cached = sessionStorage.getItem(WS_PORT_KEY);
    wsPort = cached ? parseInt(cached, 10) : 4001;
  }

  // Patch global fetch to inject X-Window-Id header for all API calls
  const origFetch = globalThis.fetch.bind(globalThis);
  (globalThis as any).fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;
    if (url.includes("/api/")) {
      init = {
        ...init,
        headers: { "X-Window-Id": windowId, ...(init?.headers ?? {}) },
      };
    }
    return origFetch(input as RequestInfo | URL, init);
  };
}

/** WebSocket base URL for this window's pipeline */
export function getWsUrl(): string {
  return `ws://127.0.0.1:${wsPort}`;
}
