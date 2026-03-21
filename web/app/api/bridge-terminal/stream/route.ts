import { getProjectBridgeServiceForCwd, requireProjectCwd } from "../../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

function encodeEvent(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseDimension(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request): Promise<Response> {
  const projectCwd = requireProjectCwd(request);
  const bridge = getProjectBridgeServiceForCwd(projectCwd);
  const url = new URL(request.url);
  const cols = parseDimension(url.searchParams.get("cols"), 120);
  const rows = parseDimension(url.searchParams.get("rows"), 30);

  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const closeWith = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    try {
      controller.close();
    } catch {
      // Already closed.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await bridge.ensureStarted();
      } catch (error) {
        controller.enqueue(
          encodeEvent({
            type: "output",
            data: `\u001b[31mFailed to start main bridge terminal: ${error instanceof Error ? error.message : String(error)}\u001b[0m\r\n`,
          }),
        );
      }

      unsubscribe = bridge.subscribeTerminal((data) => {
        if (closed) return;
        controller.enqueue(encodeEvent({ type: "output", data }));
      });

      controller.enqueue(encodeEvent({ type: "connected" }));

      try {
        await bridge.resizeTerminal(cols, rows);
        await bridge.redrawTerminal();
      } catch (error) {
        controller.enqueue(
          encodeEvent({
            type: "output",
            data: `\u001b[31mFailed to attach to main bridge terminal: ${error instanceof Error ? error.message : String(error)}\u001b[0m\r\n`,
          }),
        );
      }

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
