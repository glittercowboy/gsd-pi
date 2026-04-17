import { spawn, type ChildProcess } from "node:child_process";
import {
  isTailscaleInstalled,
  getInstallCommand,
  getTailscaleStatus,
} from "../../../../../src/web/tailscale.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_URL_PATTERN = /https:\/\/login\.tailscale\.com\/[^\s]+/;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per command

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SetupEvent =
  | { type: "output"; line: string }
  | { type: "auth-url"; url: string }
  | { type: "done"; success: boolean; message?: string }
  | { type: "error"; message: string }
  | { type: "detect"; platform: string; installed: boolean }
  | { type: "verify"; connected: boolean; hostname?: string; tailnetUrl?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize CLI output lines — strip file paths, home directory references, and control chars */
function sanitizeLine(line: string): string {
  return line
    .replace(/\/Users\/[^\s/]+/g, '/Users/***')      // macOS home dirs
    .replace(/\/home\/[^\s/]+/g, '/home/***')         // Linux home dirs
    .replace(/C:\\Users\\[^\s\\]+/g, 'C:\\Users\\***') // Windows home dirs
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')    // control chars (keep \n \r \t)
}

function sendEvent(
  controller: ReadableStreamDefaultController,
  event: SetupEvent,
): void {
  // Sanitize output lines before sending to client
  if (event.type === "output") {
    event = { ...event, line: sanitizeLine(event.line) };
  }
  try {
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
    );
  } catch {
    // Controller may be closed if client disconnected
  }
}

/**
 * Spawn a command and stream stdout/stderr as SSE output events.
 * Kills the process on client abort (signal) or timeout.
 * Returns the process exit code (1 on error).
 *
 * Note: tailscale up emits the auth URL on stderr — both stdout and stderr
 * are forwarded as output events, and stderr is additionally scanned for the
 * auth URL pattern.
 */
function runStreamingCommand(
  cmd: string,
  args: string[],
  controller: ReadableStreamDefaultController,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      sendEvent(controller, {
        type: "error",
        message: `Failed to start: ${cmd} ${args.join(" ")}`,
      });
      resolve(1);
      return;
    }

    // Kill process after COMMAND_TIMEOUT_MS
    const timeout = setTimeout(() => {
      sendEvent(controller, {
        type: "error",
        message: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
      });
      proc.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);

    // Kill process when client disconnects
    const onAbort = (): void => {
      proc.kill("SIGTERM");
      clearTimeout(timeout);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        sendEvent(controller, { type: "output", line });
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        // tailscale up emits the auth URL on stderr — detect and surface it
        const match = line.match(AUTH_URL_PATTERN);
        if (match) {
          sendEvent(controller, { type: "auth-url", url: match[0] });
        }
        // Always emit stderr as output so the user sees it
        sendEvent(controller, { type: "output", line });
      }
    });

    proc.on("error", (err) => {
      sendEvent(controller, {
        type: "error",
        message: `Process error: ${err.message}`,
      });
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(1);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(code ?? 1);
    });
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  const { step } = (await request.json()) as { step: string };
  const platform = process.platform; // Server-side OS detection
  const signal = request.signal; // AbortSignal for client disconnect

  const stream = new ReadableStream({
    async start(controller) {
      try {
        switch (step) {
          case "detect": {
            const installed = isTailscaleInstalled();
            sendEvent(controller, {
              type: "detect",
              platform,
              installed,
            });
            sendEvent(controller, { type: "done", success: true });
            break;
          }

          case "install": {
            if (platform !== "darwin" && platform !== "linux") {
              sendEvent(controller, {
                type: "error",
                message: `Unsupported platform: ${platform}. Tailscale setup is supported on macOS and Linux.`,
              });
              break;
            }
            // getInstallCommand returns a display string — split into cmd + args
            const installStr = getInstallCommand(platform);
            const [cmd, ...args] = installStr.split(" ");
            sendEvent(controller, {
              type: "output",
              line: `Running: ${installStr}`,
            });
            const code = await runStreamingCommand(cmd, args, controller, signal);
            if (code === 0) {
              sendEvent(controller, {
                type: "done",
                success: true,
                message: "Tailscale installed successfully",
              });
            } else {
              sendEvent(controller, {
                type: "error",
                message: `Install failed with exit code ${code}. Check the output above.`,
              });
            }
            break;
          }

          case "connect": {
            sendEvent(controller, {
              type: "output",
              line: "Running: tailscale up",
            });
            const code = await runStreamingCommand(
              "tailscale",
              ["up"],
              controller,
              signal,
            );
            if (code === 0) {
              sendEvent(controller, {
                type: "done",
                success: true,
                message: "Tailscale connected",
              });
            } else {
              sendEvent(controller, {
                type: "error",
                message: `tailscale up failed with exit code ${code}`,
              });
            }
            break;
          }

          case "disconnect": {
            sendEvent(controller, {
              type: "output",
              line: "Running: tailscale down",
            });
            const code = await runStreamingCommand(
              "tailscale",
              ["down"],
              controller,
              signal,
            );
            if (code === 0) {
              sendEvent(controller, {
                type: "done",
                success: true,
                message: "Tailscale disconnected",
              });
            } else {
              sendEvent(controller, {
                type: "error",
                message: `tailscale down failed with exit code ${code}`,
              });
            }
            break;
          }

          case "verify": {
            const result = getTailscaleStatus();
            if (result.ok) {
              sendEvent(controller, {
                type: "verify",
                connected: true,
                hostname: result.info.hostname,
                tailnetUrl: result.info.url,
              });
              sendEvent(controller, { type: "done", success: true });
            } else {
              sendEvent(controller, {
                type: "verify",
                connected: false,
              });
              sendEvent(controller, {
                type: "error",
                message:
                  "Tailscale is not connected. Try running the Connect step again.",
              });
            }
            break;
          }

          default:
            sendEvent(controller, {
              type: "error",
              message: `Unknown step: ${step}`,
            });
        }
      } catch (err) {
        sendEvent(controller, {
          type: "error",
          message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
