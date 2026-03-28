import {
  collectCurrentProjectOnboardingState,
  getProjectBridgeServiceForCwd,
  requireProjectCwd,
} from "../../../../../src/web/bridge-service.ts";
import { cancelShutdown } from "../../../../lib/shutdown-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

const LIVE_BUFFER_CAP = 10_000;
const PING_INTERVAL_MS = 30_000;

/** Unnamed SSE event — backward-compatible for existing clients (onmessage handler). */
function encodeSseData(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Named SSE event — used for replay/live/snapshot typed events. */
function encodeSseEvent(type: "replay" | "live" | "snapshot", payload: unknown): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: Request): Promise<Response> {
  // SSE reconnection proves the client is alive — cancel any pending shutdown.
  cancelShutdown();

  const projectCwd = requireProjectCwd(request);
  const bridge = getProjectBridgeServiceForCwd(projectCwd);
  const onboarding = await collectCurrentProjectOnboardingState(projectCwd);

  if (onboarding.locked) {
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    await bridge.ensureStarted();
  } catch {
    // Keep the stream open and let the initial bridge_status event surface the failure state.
  }

  // Parse and strictly validate the ?since=N cursor parameter.
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  let sinceSeq = -1; // Default: no cursor, skip replay
  if (sinceParam !== null) {
    const parsed = parseInt(sinceParam, 10);
    // Only accept non-negative integers; reject NaN, negative, decimal
    if (!isNaN(parsed) && parsed >= 0 && String(parsed) === sinceParam) {
      sinceSeq = parsed;
    }
  }
  const hasReplayCursor = sinceSeq >= 0;

  // Get the EventLog reference from the bridge (may be null if not yet started).
  const eventLog = bridge.getEventLog();

  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const closeWith = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    if (pingInterval !== null) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    controller.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const liveBuffer: unknown[] = [];
      let isReplaying = hasReplayCursor && eventLog !== null;
      let bufferOverflow = false;

      // Subscribe to live events first — captures events arriving during replay.
      unsubscribe = bridge.subscribe((event) => {
        if (closed) return;
        if (isReplaying) {
          if (liveBuffer.length >= LIVE_BUFFER_CAP) {
            bufferOverflow = true;
          } else {
            liveBuffer.push(event);
          }
        } else {
          controller.enqueue(encodeSseEvent("live", event));
        }
      });

      // Start ping heartbeat to detect zombie connections.
      pingInterval = setInterval(() => {
        if (closed) {
          if (pingInterval !== null) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          if (pingInterval !== null) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
        }
      }, PING_INTERVAL_MS);

      // Replay missed events if cursor provided and EventLog is available.
      if (hasReplayCursor && eventLog !== null) {
        void (async () => {
          try {
            // Check for stale cursor — sinceSeq is before the oldest log entry.
            const oldest = await eventLog.oldestSeq();
            if (oldest !== null && sinceSeq < oldest) {
              // Stale cursor — send snapshot signal; client should refresh.
              controller.enqueue(encodeSseEvent("snapshot", { reason: "cursor_expired" }));
            } else {
              // Capture replay ceiling BEFORE reading the file to prevent duplicate delivery.
              // Only replay file entries with seq <= ceiling; live buffer entries > ceiling.
              const replayCeilingSeq = eventLog.currentSeq;

              // Stream missed events from the log up to the ceiling seq.
              for await (const entry of eventLog.readSince(sinceSeq)) {
                if (closed) return;
                if (entry.seq > replayCeilingSeq) break; // Don't read past the ceiling.
                controller.enqueue(encodeSseEvent("replay", entry.event));
              }

              if (bufferOverflow) {
                // Too many live events arrived during replay — fall back to snapshot.
                controller.enqueue(encodeSseEvent("snapshot", { reason: "buffer_overflow" }));
              } else {
                // Flush buffered live events that arrived during replay (seq > ceiling).
                for (const buffered of liveBuffer) {
                  if (closed) return;
                  controller.enqueue(encodeSseEvent("replay", buffered));
                }
              }
            }
          } catch {
            // Log rotation or read error during replay — switch to live gracefully.
            if (!closed) {
              controller.enqueue(encodeSseEvent("snapshot", { reason: "replay_error" }));
            }
          } finally {
            isReplaying = false;
            liveBuffer.length = 0;
            // Send live transition sentinel — client dismisses "Catching up..." banner.
            if (!closed) {
              controller.enqueue(encodeSseEvent("live", { type: "stream_live" }));
            }
          }
        })();
      } else if (!hasReplayCursor) {
        // No cursor — legacy path: existing behavior via unnamed events.
        // Re-wire subscribe to use unnamed encodeSseData for backward compatibility
        // with clients that use onmessage rather than addEventListener.
        unsubscribe?.();
        unsubscribe = bridge.subscribe((event) => {
          if (closed) return;
          controller.enqueue(encodeSseData(event));
        });
      }

      request.signal.addEventListener("abort", () => closeWith(controller), { once: true });
    },
    cancel() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (pingInterval !== null) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
