/**
 * SSE endpoint streaming PTY output to the browser.
 *
 * GET /api/terminal/stream?id=<sessionId>
 *
 * Creates the PTY session on first connection if it doesn't exist.
 */

import {
  getOrCreateSession,
  addListener,
  isAllowedTerminalCommand,
} from "../../../../lib/pty-manager";
import { requireProjectCwd } from "../../../../../src/web/bridge-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("id") || "default";
  const command = url.searchParams.get("command") || undefined;
  const commandArgs = url.searchParams.getAll("arg");
  const projectCwd = requireProjectCwd(request);

  if (!isAllowedTerminalCommand(command)) {
    return Response.json(
      { error: `Command not allowed: ${command}` },
      { status: 403 },
    );
  }

  // Ensure the session exists
  try {
    getOrCreateSession(sessionId, projectCwd, command, commandArgs);
  } catch (error) {
    console.error("[pty-stream] Failed to create session:", error);
    return Response.json(
      { error: "Failed to create PTY session", detail: String(error) },
      { status: 500 },
    );
  }

  let removeListener: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Send an initial connected event
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`,
        ),
      );

      removeListener = addListener(sessionId, (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "output", data })}\n\n`,
            ),
          );
        } catch {
          // Stream closed
        }
      });

      request.signal.addEventListener(
        "abort",
        () => {
          if (closed) return;
          closed = true;
          removeListener?.();
          removeListener = null;
          try {
            controller.close();
          } catch {
            // Already closed
          }
        },
        { once: true },
      );
    },
    cancel() {
      if (closed) return;
      closed = true;
      removeListener?.();
      removeListener = null;
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
