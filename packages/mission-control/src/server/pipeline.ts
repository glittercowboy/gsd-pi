/**
 * Pipeline orchestrator: connects file watcher -> state deriver -> differ -> WebSocket server.
 *
 * On startup: builds initial state, restores session metadata, starts WebSocket server, starts file watcher.
 * On file change: rebuilds state, computes diff, broadcasts to connected clients.
 * Multi-session: uses SessionManager to route chat messages to correct session by sessionId.
 */
import { resolve } from "node:path";
import { createFileWatcher } from "./watcher";
import { buildFullState } from "./state-deriver";
import { computeDiff } from "./differ";
import { createWsServer } from "./ws-server";
import { ClaudeProcessManager } from "./claude-process";
import { SessionManager } from "./session-manager";
import { discoverCustomCommands } from "./discover-commands";
import { setCustomCommands } from "../lib/slash-commands";
import { createSwitchGuard } from "./switch-guard";
import { parseStreamForModeEvents } from "./mode-interceptor";
import { detectBoundaryViolation } from "./boundary-enforcer";
import type { PlanningState } from "./types";
import type { WsServer, SessionAction } from "./ws-server";
import type { ChatResponse, StreamEvent } from "./chat-types";
import type { SessionState, IProcessManager } from "./session-manager";
import type { ServerWebSocket } from "bun";

export interface PipelineOptions {
  planningDir: string;
  wsPort: number;
  /** Reconciliation interval in ms. Defaults to 5000. */
  reconcileMs?: number;
  /**
   * Optional process factory for testing — receives cwd and config-derived options.
   * When omitted, defaults to real ClaudeProcessManager with config options applied.
   */
  processFactory?: (cwd: string, opts?: { skipPermissions?: boolean }) => IProcessManager;
}

export interface PipelineHandle {
  stop(): void;
  /** Access the Claude process manager for lifecycle control (first/default session). */
  processManager: ClaudeProcessManager;
  /** Access the session manager for multi-session control. */
  sessionManager: SessionManager;
  /** Switch to a different project's planning directory. */
  switchProject(newPlanningDir: string): Promise<void>;
  /** Get the current planning directory path. */
  getPlanningDir(): string;
  /** Get the detected dev server port for the current project, or null if not detected. */
  getPreviewPort(): number | null;
  /** Set the detected dev server port (called when dev_server_detected fires). */
  setPreviewPort(port: number): void;
}

/**
 * Starts the file-to-state pipeline.
 *
 * 1. Builds initial PlanningState from planningDir
 * 2. Restores session metadata and creates default session
 * 3. Creates WebSocket server on wsPort
 * 4. Creates file watcher on planningDir
 * 5. Sets up reconciliation interval
 */
export async function startPipeline(
  options: PipelineOptions
): Promise<PipelineHandle> {
  const { planningDir: initialPlanningDir, wsPort, reconcileMs = 5000, processFactory: injectedProcessFactory } = options;

  let planningDir = initialPlanningDir;

  // Detected dev server port — closure variable, per-project, reset on switchProject (Pitfall 3)
  let previewPort: number | null = null;

  // Resolve repo root from planningDir (one level up from .gsd)
  let repoRoot = resolve(planningDir, "..");

  // Discover custom slash commands from ~/.claude/commands/ and .claude/commands/
  let customCmds = await discoverCustomCommands(repoRoot);
  if (customCmds.length > 0) {
    setCustomCommands(customCmds);
    console.log(`[pipeline] Discovered ${customCmds.length} custom slash commands`);
  }

  // 1. Build initial state
  let currentState: PlanningState = await buildFullState(planningDir);

  // 2. Create session manager with config-bridge processFactory and restore persisted sessions
  // GSD 2: config.json removed; skip_permissions defaults to true, worktree_enabled to false.
  // TODO (Phase 13): read skip_permissions from .gsd/preferences.md or CLI flag.
  const skipPermissions = true;
  const configuredProcessFactory = injectedProcessFactory
    ? (cwd: string) => injectedProcessFactory(cwd, { skipPermissions })
    : (cwd: string) => new ClaudeProcessManager(cwd, { skipPermissions });
  const sessionManager = new SessionManager(planningDir, { processFactory: configuredProcessFactory });
  sessionManager.setWorktreeEnabled(false);
  await sessionManager.restoreMetadata(repoRoot);

  // Ensure at least one default session exists
  if (sessionManager.listSessions().length === 0) {
    sessionManager.createSession(repoRoot);
  }

  // Keep a reference to the first session's process manager for backward compat
  let processManager = sessionManager.listSessions()[0].processManager as ClaudeProcessManager;

  /** Wire up Claude event forwarding for a session to its active client. */
  function wireSessionEvents(session: SessionState) {
    if (session.wired) return;
    session.wired = true;
    let modeBuffer = "";

    session.processManager.onEvent((event: unknown) => {
      const ev = event as StreamEvent & { error?: string };
      if (!session.activeClient) return;

      if (ev.type === "result") {
        // Turn complete — check for error
        if (ev.error) {
          console.error(`[pipeline] Claude error (session ${session.id}):`, ev.error);
          const error: ChatResponse = {
            type: "chat_error",
            error: ev.error,
          };
          wsServer.sendToClient(session.activeClient, error);
        } else {
          console.log(`[pipeline] Claude turn complete (session ${session.id})`);
          const complete: ChatResponse = {
            type: "chat_complete",
            sessionId: session.processManager.sessionId ?? undefined,
          };
          wsServer.sendToClient(session.activeClient, complete);
        }
        session.activeClient = null;
        return;
      }

      // Intercept text_delta events to strip mode tags and emit mode events
      if (
        ev.type === "stream_event" &&
        ev.event?.type === "content_block_delta" &&
        ev.event?.delta?.type === "text_delta" &&
        ev.event.delta.text
      ) {
        // Boundary enforcement: block out-of-project file access (PERM-03)
        // Check raw text before mode tag stripping to catch all path references
        const rawText = ev.event.delta.text;
        const violation = detectBoundaryViolation(rawText, repoRoot);
        if (violation.violated && violation.path) {
          console.warn(`[pipeline] BOUNDARY_VIOLATION: session ${session.id} accessed ${violation.path} — interrupting`);
          // BLOCK: interrupt the active gsd process to prevent further file operations
          session.processManager.interrupt();
          // Then notify the frontend
          wsServer.publishChat({
            type: "boundary_violation",
            path: violation.path,
            sessionId: session.id,
            timestamp: Date.now(),
          });
          // Do not forward the offending delta to the client
          return;
        }

        const { events, stripped, remainder } = parseStreamForModeEvents(
          ev.event.delta.text,
          modeBuffer
        );
        modeBuffer = remainder;

        // Broadcast each mode event only to this session's active client
        for (const modeEvent of events) {
          wsServer.sendToClient(session.activeClient!, { ...modeEvent, sessionId: session.id });

          // Handle dev_server_detected: update stored port and broadcast preview_open to all clients
          if (modeEvent.type === "dev_server_detected" && modeEvent.port) {
            previewPort = modeEvent.port;
            wsServer.publishChat({ type: "preview_open", port: modeEvent.port });
          }
        }

        // Suppress blank delta when all text was mode tags
        if (stripped.trim() === "" && events.length > 0) {
          return;
        }

        // Mutate delta text to stripped version if different
        if (stripped !== ev.event.delta.text) {
          ev.event.delta.text = stripped;
        }
      }

      // Forward streaming event
      const response: ChatResponse = { type: "chat_event", event: ev, sessionId: session.id };
      try {
        wsServer.sendToClient(session.activeClient, response);
      } catch (sendErr) {
        console.error(`[pipeline] Failed to send chat_event to client (session ${session.id}):`, sendErr);
      }
    });
  }

  // Wire events for all restored sessions
  for (const session of sessionManager.listSessions()) {
    wireSessionEvents(session);
  }

  // Start the default session's process (non-blocking)
  processManager.start().catch((err: Error) => {
    console.error("[pipeline] Failed to start Claude process:", err);
  });

  // 3. Create WebSocket server with multi-session chat handler
  const wsServer: WsServer = createWsServer({
    port: wsPort,
    getFullState: () => currentState,
    customCommands: customCmds,
    onChatMessage: async (prompt: string, ws: ServerWebSocket, sessionId?: string) => {
      console.log(`[pipeline] Chat message: "${prompt.slice(0, 80)}" (session: ${sessionId ?? "default"})`);

      // Resolve session: by ID or fallback to first (default) session
      let session: SessionState | undefined;
      if (sessionId) {
        session = sessionManager.getSession(sessionId);
        if (!session) {
          const error: ChatResponse = {
            type: "chat_error",
            error: `Session not found: ${sessionId}`,
            sessionId,
          };
          wsServer.sendToClient(ws, error);
          return;
        }
      } else {
        // Backward compat: no sessionId = use first session
        const sessions = sessionManager.listSessions();
        session = sessions[0];
        if (!session) {
          const error: ChatResponse = {
            type: "chat_error",
            error: "No sessions available",
          };
          wsServer.sendToClient(ws, error);
          return;
        }
      }

      // Check if this session's Claude is already processing
      if (session.processManager.isProcessing) {
        const error: ChatResponse = {
          type: "chat_error",
          error: "Claude is already processing a request in this session. Please wait.",
          sessionId: session.id,
        };
        wsServer.sendToClient(ws, error);
        return;
      }

      // Route message to session's process manager
      session.activeClient = ws;
      try {
        await session.processManager.sendMessage(prompt);
      } catch (err) {
        console.error(`[pipeline] Failed to send message to Claude (session ${session.id}):`, err);
        session.activeClient = null;
        const error: ChatResponse = {
          type: "chat_error",
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        };
        wsServer.sendToClient(ws, error);
      }
    },
    onSessionAction: async (action: SessionAction, ws: ServerWebSocket) => {
      try {
        switch (action.type) {
          case "session_create": {
            const newSession = sessionManager.createSession(repoRoot, {
              forkFromSessionId: action.forkFromSessionId,
            });
            wireSessionEvents(newSession);
            newSession.processManager.start().catch((err: Error) => {
              console.error(`[pipeline] Failed to start Claude for new session:`, err);
            });
            wsServer.publishSessionUpdate({
              type: "session_update",
              sessions: sessionManager.getMetadata(),
            });
            break;
          }
          case "session_close": {
            // Check if session has worktree — if so, use worktree-aware close
            const closingSession = sessionManager.getSession(action.sessionId);
            if (closingSession?.worktreePath) {
              const closeAction = (action as SessionAction & { closeAction?: string }).closeAction as "merge" | "keep" | "delete" | undefined;
              await sessionManager.closeSessionWithWorktree(
                action.sessionId,
                closeAction ?? "delete",
                repoRoot,
              );
            } else {
              await sessionManager.closeSession(action.sessionId);
            }
            wsServer.publishSessionUpdate({
              type: "session_update",
              sessions: sessionManager.getMetadata(),
            });
            break;
          }
          case "session_rename": {
            await sessionManager.renameSession(action.sessionId, action.name, repoRoot);
            wsServer.publishSessionUpdate({
              type: "session_update",
              sessions: sessionManager.getMetadata(),
            });
            break;
          }
          case "session_list": {
            wsServer.sendToClient(ws, {
              type: "session_update",
              sessions: sessionManager.getMetadata(),
            });
            break;
          }
          case "session_interrupt": {
            const interruptSession = sessionManager.getSession(action.sessionId);
            if (interruptSession) {
              console.log(`[pipeline] Interrupt session: ${action.sessionId}`);
              interruptSession.processManager.interrupt();
            } else {
              console.warn(`[pipeline] session_interrupt: session not found: ${action.sessionId}`);
            }
            break;
          }
        }
      } catch (err) {
        console.error(`[pipeline] Session action error:`, err);
        wsServer.sendToClient(ws, {
          type: "chat_error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  // 4. Create file watcher with onChange callback
  let watcher = createFileWatcher({
    planningDir,
    debounceMs: 50,
    onChange: async (_changedFiles: Set<string>) => {
      try {
        const newState = await buildFullState(planningDir);
        const diff = computeDiff(currentState, newState);
        if (diff) {
          currentState = newState;
          wsServer.broadcast(diff);
        }
      } catch (err) {
        console.error("[pipeline] Error processing file change:", err);
      }
    },
  });

  // 5. Set up reconciliation interval
  let reconcileInterval = setInterval(async () => {
    try {
      const freshState = await buildFullState(planningDir);
      const diff = computeDiff(currentState, freshState);
      if (diff) {
        console.warn("[pipeline] Reconciliation detected drift, broadcasting");
        currentState = freshState;
        wsServer.broadcast(diff);
      }
    } catch (err) {
      console.error("[pipeline] Reconciliation error:", err);
    }
  }, reconcileMs);

  // Switch guard prevents concurrent switches and switching during processing
  const switchGuard = createSwitchGuard(() => {
    // Check if ANY session is processing
    return sessionManager.listSessions().some((s) => s.processManager.isProcessing);
  });

  let seq = wsServer.getSequence();

  const handle: PipelineHandle = {
    stop() {
      clearInterval(reconcileInterval);
      watcher.close();
      // Close all sessions
      const closePromises = sessionManager.listSessions().map((s) => sessionManager.closeSession(s.id));
      Promise.all(closePromises).catch(() => {});
      wsServer.stop();
    },
    processManager,
    sessionManager,

    getPlanningDir() {
      return planningDir;
    },

    getPreviewPort() {
      return previewPort;
    },

    setPreviewPort(port: number) {
      previewPort = port;
    },

    async switchProject(newPlanningDir: string): Promise<void> {
      await switchGuard.acquire();
      try {
        // Pause reconcile interval before switch to prevent stale-closure race
        clearInterval(reconcileInterval);

        // Close existing watcher
        watcher.close();

        // Close all existing sessions
        for (const session of sessionManager.listSessions()) {
          await sessionManager.closeSession(session.id);
        }

        // Resolve new paths
        planningDir = newPlanningDir;
        repoRoot = resolve(newPlanningDir, "..");

        // Reset preview port — new project has its own dev server (Pitfall 3)
        previewPort = null;

        // Rebuild state from new planning dir
        currentState = await buildFullState(planningDir);

        // Re-apply config bridge for new project
        // GSD 2: config.json removed; skip_permissions defaults to true, worktree_enabled to false.
        const newSkipPermissions = true;
        const newConfiguredFactory = injectedProcessFactory
          ? (cwd: string) => injectedProcessFactory(cwd, { skipPermissions: newSkipPermissions })
          : (cwd: string) => new ClaudeProcessManager(cwd, { skipPermissions: newSkipPermissions });
        // Update the SessionManager's processFactory for new sessions
        (sessionManager as any)["processFactory"] = newConfiguredFactory;
        sessionManager.setWorktreeEnabled(false);

        // Create fresh default session in new project
        const newSession = sessionManager.createSession(repoRoot);
        wireSessionEvents(newSession);
        processManager = newSession.processManager as ClaudeProcessManager;
        handle.processManager = processManager;

        // Start the new session's process
        processManager.start().catch((err: Error) => {
          console.error("[pipeline] Failed to start Claude process after switch:", err);
        });

        // Re-discover custom commands for new repo root
        customCmds = await discoverCustomCommands(repoRoot);
        if (customCmds.length > 0) {
          setCustomCommands(customCmds);
        }

        // Create new file watcher
        watcher = createFileWatcher({
          planningDir,
          debounceMs: 50,
          onChange: async (_changedFiles: Set<string>) => {
            try {
              const newState = await buildFullState(planningDir);
              const diff = computeDiff(currentState, newState);
              if (diff) {
                currentState = newState;
                wsServer.broadcast(diff);
              }
            } catch (err) {
              console.error("[pipeline] Error processing file change:", err);
            }
          },
        });

        // Restart reconcile interval for new project
        reconcileInterval = setInterval(async () => {
          try {
            const freshState = await buildFullState(planningDir);
            const diff = computeDiff(currentState, freshState);
            if (diff) {
              console.warn("[pipeline] Reconciliation detected drift, broadcasting");
              currentState = freshState;
              wsServer.broadcast(diff);
            }
          } catch (err) {
            console.error("[pipeline] Reconciliation error:", err);
          }
        }, reconcileMs);

        // Broadcast project_switched event BEFORE full state (lets clients clear local state)
        wsServer.publishChat({
          type: "project_switched",
          path: newPlanningDir,
          timestamp: Date.now(),
        });

        // Broadcast full state to all WebSocket clients
        seq++;
        wsServer.broadcast({
          type: "full",
          changes: currentState,
          timestamp: Date.now(),
          sequence: seq,
        } as any);

        // Broadcast session update
        wsServer.publishSessionUpdate({
          type: "session_update",
          sessions: sessionManager.getMetadata(),
        });

        console.log("[pipeline] Switched to project:", newPlanningDir);
      } finally {
        switchGuard.release();
      }
    },
  };

  return handle;
}
