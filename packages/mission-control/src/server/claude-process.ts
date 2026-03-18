/**
 * GSD process manager.
 *
 * Spawns gsd binary per user message using:
 *   gsd -p "<prompt>" --mode json
 *
 * GSD emits its own NDJSON event format. An adapter layer in sendMessage()
 * transforms these into the Claude CLI stream-json format so the rest of the
 * pipeline works unchanged:
 *   - agent_end  → { type: "result" }   (replaces turn_end — handles multi-turn tool use)
 *   - turn_end   → suppressed            (fires per tool round-trip, not final completion)
 *   - message_update (text_delta) → stream_event content_block_delta text_delta
 *   - tool_execution_start    → stream_event text_delta "[toolName]\n$ command\n"
 *   - tool_execution_update   → stream_event text_delta (cumulative output delta)
 *   - tool_execution_end      → stream_event text_delta "\n"
 *   - session                 → captures session ID internally, not forwarded
 *   - agent_start/turn_start/message_start/message_end → suppressed
 *   - everything else (cost_update, phase_transition, etc.) → forwarded as-is
 *
 * Uses Node's child_process.spawn for reliable stdin/stdout on Windows
 * (Bun.spawn has known issues with stream handling on Windows).
 *
 * CRITICAL: CLAUDECODE env var is stripped to avoid "nested session" rejection.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { StreamEvent } from "./chat-types";
import { createNdjsonParser } from "./ndjson-parser";

export interface ClaudeProcessOptions {
  allowedTools?: string[];
  model?: string;
  /**
   * Control --dangerously-skip-permissions flag.
   * - undefined (default): flag IS added (skip permissions ON)
   * - true: flag IS added (explicit skip permissions ON)
   * - false: flag is NOT added (permissions prompts enabled)
   */
  skipPermissions?: boolean;
}

/**
 * Manages gsd child processes.
 * Spawns a new process per message for reliability.
 */
export class ClaudeProcessManager {
  private activeProcess: ChildProcess | null = null;
  private _sessionId: string | null = null;
  private _isProcessing = false;
  private eventHandlers: Array<(event: StreamEvent) => void> = [];
  private cwd: string;
  private options: ClaudeProcessOptions;
  /** Injectable spawn function for testing. Defaults to node:child_process.spawn. */
  _spawnFn: typeof nodeSpawn = nodeSpawn;

  constructor(cwd: string, options: ClaudeProcessOptions = {}) {
    this.cwd = cwd;
    this.options = options;
  }

  get isActive(): boolean {
    return this.activeProcess !== null;
  }

  get isProcessing(): boolean {
    return this._isProcessing;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * Register an event handler for streaming events from Claude.
   */
  onEvent(handler: (event: StreamEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /**
   * No-op for compatibility — process is spawned per message.
   */
  async start(): Promise<void> {
    console.log("[claude-process] Ready (per-message spawn mode)");
  }

  /**
   * Send a user message by spawning a gsd process.
   * Uses --mode json for NDJSON streaming output.
   */
  async sendMessage(prompt: string): Promise<void> {
    if (this._isProcessing) {
      throw new Error("Claude is already processing a request. Please wait.");
    }

    this._isProcessing = true;

    // Map /gsd slash commands to GSD subcommand invocations.
    // "/gsd auto" → gsd auto --mode json  (not gsd -p "/gsd auto" --mode json)
    const gsdCmdMatch = prompt.trim().match(/^\/gsd(?:\s+(.+))?$/);
    let args: string[];
    if (gsdCmdMatch) {
      const subAndArgs = gsdCmdMatch[1]?.trim();
      args = subAndArgs
        ? [...subAndArgs.split(/\s+/), "--mode", "json"]
        : ["--mode", "json"];
    } else {
      args = ["-p", prompt, "--mode", "json"];
    }

    if (this.options.model) {
      args.push("--model", this.options.model);
    }

    // Strip CLAUDECODE env var to avoid "nested session" rejection
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // Suppress external Chromium window — Mission Control relays screenshots to preview panel
    env.GSD_BROWSER_HEADLESS = "1";

    // On Windows, npm global binaries are .cmd wrappers — must use gsd.cmd with shell:false
    const gsdBin = process.platform === "win32" ? "gsd.cmd" : "gsd";

    console.log(`[claude-process] Spawning: ${gsdBin} ${args.slice(0, 6).join(" ")}...`);
    console.log(`[claude-process] CWD: ${this.cwd}`);

    // Use Node's spawn for reliable stream handling on Windows
    const proc = this._spawnFn(gsdBin, args, {
      cwd: this.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    this.activeProcess = proc;
    let chunkCount = 0;
    let stderrText = "";

    /**
     * Emit a synthetic event to all registered handlers.
     */
    const emit = (event: StreamEvent) => {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    };

    // Tracks cumulative output length for tool_execution_update delta streaming
    let lastToolOutputLength = 0;
    // Tracks the current tool name for browser screenshot extraction
    let currentToolName = "";

    const parser = createNdjsonParser((rawEvent) => {
      const raw = rawEvent as unknown as Record<string, unknown>;
      const rawType = raw.type as string;

      // Capture GSD session ID
      if (rawType === "session") {
        this._sessionId = raw.id as string;
        console.log(`[claude-process] Session ID: ${this._sessionId}`);
        return;
      }

      // Suppress GSD lifecycle noise
      if (
        rawType === "agent_start" ||
        rawType === "turn_start" ||
        rawType === "message_start" ||
        rawType === "message_end"
      ) {
        return;
      }

      // turn_end fires once per tool-use round-trip; agent may have more turns.
      // Do NOT emit result or clear _isProcessing here — wait for agent_end.
      if (rawType === "turn_end") {
        return;
      }

      // agent_end → the entire agent run is complete; signal pipeline to close turn
      if (rawType === "agent_end") {
        this._isProcessing = false;
        emit({ type: "result" } as StreamEvent);
        return;
      }

      // message_update: transform text_delta to stream_event content_block_delta.
      // GSD sends two formats: structured { assistantMessageEvent: { type: "text_delta", delta } }
      // and simple { text: "..." }. Handle both to avoid dropped words mid-sentence.
      if (rawType === "message_update") {
        const aMe = raw.assistantMessageEvent as Record<string, unknown> | undefined;
        const textContent =
          (aMe?.type === "text_delta" && typeof aMe.delta === "string" ? aMe.delta : null) ??
          (typeof raw.text === "string" ? raw.text : null);
        if (textContent) {
          emit({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: textContent },
            },
          } as StreamEvent);
        }
        return;
      }

      // tool_execution_start → emit tool name + command as text
      if (rawType === "tool_execution_start") {
        lastToolOutputLength = 0;
        const toolName = raw.toolName as string;
        currentToolName = toolName;
        const args = raw.args as Record<string, unknown> | undefined;
        let header = `\n[${toolName}]`;
        if (toolName === "bash" && args?.command) {
          header += `\n$ ${String(args.command)}`;
        } else if (args?.file_path) {
          header += `\n${String(args.file_path)}`;
        } else if (args?.path) {
          header += `\n${String(args.path)}`;
        } else if (args?.pattern) {
          header += `\n${String(args.pattern)}`;
        }
        emit({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: header + "\n" },
          },
        } as StreamEvent);
        return;
      }

      // tool_execution_update → stream delta of cumulative output
      if (rawType === "tool_execution_update") {
        const partialResult = raw.partialResult as
          | { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }
          | undefined;
        const currentText = partialResult?.content?.[0]?.text ?? "";
        const delta = currentText.slice(lastToolOutputLength);
        lastToolOutputLength = currentText.length;
        if (delta) {
          emit({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: delta },
            },
          } as StreamEvent);
        }
        // Extract browser screenshots from tool results and emit as browser_state_update
        if (currentToolName.startsWith("browser_")) {
          const contentItems = partialResult?.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }> | undefined;
          if (contentItems) {
            const imageItem = contentItems.find((item) => item.type === "image" && item.data);
            if (imageItem && imageItem.data) {
              // Extract URL from text content if available
              const textItem = contentItems.find((item) => item.type === "text" && item.text);
              const urlMatch = textItem?.text?.match(/(?:Navigated to|Current URL|URL):\s*(\S+)/);
              const titleMatch = textItem?.text?.match(/Title:\s*(.+)/);
              const viewportMatch = textItem?.text?.match(
                /(?:Viewport|Window size|Resized to|Size):\s*(\d+)\s*[x×]\s*(\d+)/i
              );
              const viewportWidth  = viewportMatch ? parseInt(viewportMatch[1], 10) : undefined;
              const viewportHeight = viewportMatch ? parseInt(viewportMatch[2], 10) : undefined;
              emit({
                type: "browser_state_update",
                screenshot: imageItem.data,
                url: urlMatch?.[1] ?? "",
                title: titleMatch?.[1]?.trim() ?? "",
                toolName: currentToolName,
                viewportWidth,
                viewportHeight,
              } as unknown as StreamEvent);
            }
          }
        }
        return;
      }

      // tool_execution_end → reset tracking + emit trailing newline
      if (rawType === "tool_execution_end") {
        lastToolOutputLength = 0;
        currentToolName = "";
        emit({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "\n" },
          },
        } as StreamEvent);
        return;
      }

      // Pass through GSD-specific events (cost_update, phase_transition, auto_mode, etc.)
      emit(rawEvent);
    });

    proc.stdout!.on("data", (chunk: Buffer) => {
      chunkCount++;
      const text = chunk.toString();
      if (chunkCount <= 5) {
        console.log(`[claude-process] stdout #${chunkCount}: ${text.slice(0, 200)}`);
      }
      parser.push(text);
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrText += text;
      console.error(`[claude-process] stderr: ${text.trim().slice(0, 300)}`);
    });

    proc.on("close", (code) => {
      console.log(`[claude-process] Exited with code ${code}. Chunks: ${chunkCount}`);
      parser.flush();
      this.activeProcess = null;

      // If process failed with no stream events, emit error
      if (code !== 0 && chunkCount === 0) {
        const errMsg = stderrText.trim() || `Claude exited with code ${code}`;
        emit({
          type: "result",
          error: errMsg,
        } as StreamEvent);
        this._isProcessing = false;
      } else if (code !== 0 && chunkCount > 0) {
        // Process produced output but crashed — emit process_crashed event
        this._isProcessing = false;
        emit({
          type: "process_crashed",
          exitCode: code,
          stderr: stderrText.trim(),
        } as unknown as StreamEvent);
      } else if (this._isProcessing) {
        // Safety: ensure isProcessing is cleared even if no turn_end event
        this._isProcessing = false;
        emit({ type: "result" } as StreamEvent);
      }
    });

    proc.on("error", (err) => {
      console.error(`[claude-process] Spawn error:`, err.message);
      this.activeProcess = null;
      this._isProcessing = false;
      emit({
        type: "result",
        error: `Failed to start Claude: ${err.message}`,
      } as StreamEvent);
    });
  }

  /**
   * Interrupt the active process.
   * On Windows, SIGINT is not reliably delivered to process trees spawned with
   * shell:false, so we use taskkill /F /T to forcefully terminate the entire tree.
   * On POSIX, we send SIGINT and escalate to SIGKILL after 3 seconds if needed.
   * No-op if no process is currently active.
   */
  interrupt(): void {
    if (!this.activeProcess) return;
    const proc = this.activeProcess;

    if (process.platform === "win32" && proc.pid) {
      // On Windows, SIGINT is not reliably delivered to process trees.
      // taskkill /F /T forcefully terminates the entire tree.
      nodeSpawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
        shell: false,
        stdio: "ignore",
      });
    } else {
      proc.kill("SIGINT");
      // Escalate to SIGKILL after 3 seconds if the process is still running
      const timer = setTimeout(() => {
        if (this.activeProcess === proc) {
          try { proc.kill("SIGKILL"); } catch (_) {}
        }
      }, 3000);
      proc.once("close", () => clearTimeout(timer));
    }
  }

  /**
   * Kill the active process.
   */
  async kill(): Promise<void> {
    if (!this.activeProcess) return;
    this.activeProcess.kill();
    this.activeProcess = null;
    this._isProcessing = false;
  }
}
