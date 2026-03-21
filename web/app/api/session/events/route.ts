import {
  collectCurrentProjectOnboardingState,
  getProjectBridgeServiceForCwd,
  requireProjectCwd,
} from "../../../../../src/web/bridge-service.ts";
import { cancelShutdown } from "../../../../lib/shutdown-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function encodeSseData(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
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

  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const closeWith = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    controller.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = bridge.subscribe((event) => {
        if (closed) return;
        controller.enqueue(encodeSseData(event));
      });

      request.signal.addEventListener("abort", () => closeWith(controller), { once: true });
    },
    cancel() {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
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
