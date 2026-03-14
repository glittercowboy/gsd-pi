/**
 * useSessionManager — Multi-session chat state management hook.
 *
 * Manages per-session message state over a shared WebSocket connection.
 * Routes chat events by sessionId to the correct session's message buffer.
 * Exposes pure functions for testability alongside the React hook.
 *
 * @module
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useReconnectingWebSocket } from "./useReconnectingWebSocket";
import { processStreamEvent } from "./useChat";
import { setCustomCommands } from "../lib/slash-commands";
import { classifyPiSdkEvent } from "../server/ndjson-parser";
import { useCostTracker } from "./useCostTracker";
import type { ChatMessage, ChatResponse, StreamEvent, PermissionPromptEvent, SessionMetadata, GSD2StreamEvent } from "../server/chat-types";
import type { SlashCommand } from "../lib/slash-commands";
import type { CostState } from "./useCostTracker";

// -- Types --

export interface SessionTab {
  id: string;
  name: string;
  isProcessing: boolean;
  hasWorktree: boolean;
  worktreeBranch?: string | null;
}

export interface SessionManagerState {
  sessions: SessionTab[];
  activeSessionId: string;
  messagesBySession: Map<string, ChatMessage[]>;
  processingBySession: Map<string, boolean>;
}

export interface UseSessionManagerResult {
  sessions: SessionTab[];
  activeSessionId: string;
  activeMessages: ChatMessage[];
  isActiveProcessing: boolean;
  selectSession: (id: string) => void;
  createSession: (forkFrom?: string) => void;
  closeSession: (id: string, closeAction?: "merge" | "keep" | "delete") => void;
  renameSession: (id: string, name: string) => void;
  sendMessage: (text: string) => void;
  permissionPrompt: PermissionPromptEvent | null;
  respondToPermission: (action: "approve" | "always_allow" | "deny") => void;
  /** True when /gsd auto is running (auto_mode_announcement mode=start received) */
  isAutoMode: boolean;
  /** True when the gsd process crashed unexpectedly */
  isCrashed: boolean;
  /** Send SIGINT to the active session's process */
  interrupt: () => void;
  /** Dismiss crash banner — clears isCrashed state */
  resetCrash: () => void;
  /** Current accumulated cost state from useCostTracker */
  costState: CostState;
  /** Last boundary violation detected — null when dismissed or no violation */
  boundaryViolation: { path: string } | null;
  /** Dismiss the boundary violation banner */
  dismissBoundaryViolation: () => void;
}

// -- Pure functions (exported for testing) --

/** Generate a simple unique ID for chat messages. */
function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create initial session manager state. */
export function createSessionManagerState(
  overrides?: Partial<SessionManagerState>,
): SessionManagerState {
  return {
    sessions: [],
    activeSessionId: "",
    messagesBySession: new Map(),
    processingBySession: new Map(),
    ...overrides,
  };
}

/** Route a chat_event stream event to the correct session's message buffer. */
export function routeChatEvent(
  state: SessionManagerState,
  sessionId: string,
  event: StreamEvent,
): SessionManagerState {
  const newMap = new Map(state.messagesBySession);
  const msgs = [...(newMap.get(sessionId) ?? [])];

  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    // Accumulate into existing streaming message
    const result = processStreamEvent(event, last.content);
    const updated: ChatMessage = {
      ...last,
      content: result.content,
      toolName: result.toolName ?? last.toolName,
      toolDone: result.toolDone ?? last.toolDone,
    };
    msgs[msgs.length - 1] = updated;
  } else {
    // Create new assistant message
    const result = processStreamEvent(event, "");
    const newMsg: ChatMessage = {
      id: createMessageId(),
      role: event.type === "system" ? "system" : "assistant",
      content: result.content,
      timestamp: Date.now(),
      streaming: true,
      toolName: result.toolName,
      toolDone: result.toolDone,
    };
    msgs.push(newMsg);
  }

  newMap.set(sessionId, msgs);

  // Mark as processing
  const newProcessing = new Map(state.processingBySession);
  newProcessing.set(sessionId, true);

  return { ...state, messagesBySession: newMap, processingBySession: newProcessing };
}

/** Mark a session's streaming message as complete. */
export function routeChatComplete(
  state: SessionManagerState,
  sessionId: string,
): SessionManagerState {
  const newMap = new Map(state.messagesBySession);
  const msgs = [...(newMap.get(sessionId) ?? [])];

  const last = msgs[msgs.length - 1];
  if (last && last.streaming) {
    msgs[msgs.length - 1] = { ...last, streaming: false };
  }
  newMap.set(sessionId, msgs);

  const newProcessing = new Map(state.processingBySession);
  newProcessing.set(sessionId, false);

  return { ...state, messagesBySession: newMap, processingBySession: newProcessing };
}

/** Add an error message to a session. */
export function routeChatError(
  state: SessionManagerState,
  sessionId: string,
  error: string,
): SessionManagerState {
  const newMap = new Map(state.messagesBySession);
  const msgs = [...(newMap.get(sessionId) ?? [])];

  msgs.push({
    id: createMessageId(),
    role: "system",
    content: error,
    timestamp: Date.now(),
    streaming: false,
  });
  newMap.set(sessionId, msgs);

  const newProcessing = new Map(state.processingBySession);
  newProcessing.set(sessionId, false);

  return { ...state, messagesBySession: newMap, processingBySession: newProcessing };
}

/** Update sessions list from server metadata. */
export function handleSessionUpdate(
  state: SessionManagerState,
  serverSessions: SessionTab[],
): SessionManagerState {
  const validActive = serverSessions.some((s) => s.id === state.activeSessionId);
  return {
    ...state,
    sessions: serverSessions,
    activeSessionId: validActive ? state.activeSessionId : (serverSessions[0]?.id ?? ""),
  };
}

/** Switch active session. */
export function selectSession(
  state: SessionManagerState,
  sessionId: string,
): SessionManagerState {
  return { ...state, activeSessionId: sessionId };
}

/** Get messages for the active session. */
export function getActiveMessages(state: SessionManagerState): ChatMessage[] {
  return state.messagesBySession.get(state.activeSessionId) ?? [];
}

/** Get processing state for the active session. */
export function getActiveProcessing(state: SessionManagerState): boolean {
  return state.processingBySession.get(state.activeSessionId) ?? false;
}

/** Remove a session. If removing active, auto-switch to first remaining. */
export function removeSession(
  state: SessionManagerState,
  sessionId: string,
): SessionManagerState {
  const remaining = state.sessions.filter((s) => s.id !== sessionId);
  const newMessages = new Map(state.messagesBySession);
  newMessages.delete(sessionId);
  const newProcessing = new Map(state.processingBySession);
  newProcessing.delete(sessionId);

  let activeId = state.activeSessionId;
  if (activeId === sessionId) {
    activeId = remaining[0]?.id ?? "";
  }

  return {
    ...state,
    sessions: remaining,
    activeSessionId: activeId,
    messagesBySession: newMessages,
    processingBySession: newProcessing,
  };
}

/**
 * Derive a short session name from the first user message content.
 * Takes first 30 chars, cleans to title case, trims trailing incomplete word.
 * Matches Claude Desktop auto-naming behavior.
 */
export function deriveSessionName(message: string): string {
  // Strip attachment patterns and trim
  const cleaned = message.replace(/\[Attached:[^\]]*\]/g, "").trim();
  if (!cleaned) return "Chat";

  // Take first 30 chars
  let name = cleaned.slice(0, 30);

  // Trim trailing incomplete word (unless the whole thing is one word)
  if (name.length >= 30) {
    const lastSpace = name.lastIndexOf(" ");
    if (lastSpace > 5) {
      name = name.slice(0, lastSpace);
    }
  }

  // Clean up: capitalize first letter, remove trailing punctuation
  name = name.charAt(0).toUpperCase() + name.slice(1);
  name = name.replace(/[.,;:!?\-]+$/, "").trim();

  return name || "Chat";
}

// -- GSD2 event application --

export interface ApplyGSD2EventState {
  isAutoMode: boolean;
  isCrashed: boolean;
}

export interface ApplyGSD2EventResult extends ApplyGSD2EventState {
  messageInsert?: ChatMessage;
}

/**
 * Pure helper: apply a classified GSD2StreamEvent to the auto/crash state machine.
 * Returns updated state and an optional message to insert into the message list.
 * Called by useSessionManager for each classified Pi SDK event.
 */
export function applyGSD2Event(
  event: GSD2StreamEvent,
  state: ApplyGSD2EventState,
): ApplyGSD2EventResult {
  switch (event.kind) {
    case "auto_mode_announcement":
      return { ...state, isAutoMode: event.mode === "start" };
    case "phase_transition":
      return {
        ...state,
        messageInsert: {
          id: `phase-${Date.now()}`,
          role: "phase_transition",
          content: event.phase,
          timestamp: Date.now(),
          streaming: false,
          phaseTransition: { phase: event.phase },
        },
      };
    case "tool_use":
      return {
        ...state,
        messageInsert: {
          id: `tool-${Date.now()}`,
          role: "tool_use",
          content: event.name,
          timestamp: Date.now(),
          streaming: true,
          toolName: event.name,
          toolInput: event.input,
        },
      };
    default:
      return { ...state };
  }
}

/** Build a chat WebSocket payload with the active sessionId. */
export function buildChatPayload(
  state: SessionManagerState,
  text: string,
): { type: "chat"; prompt: string; sessionId: string } {
  return { type: "chat", prompt: text, sessionId: state.activeSessionId };
}

// -- React Hook --

export interface UseSessionManagerOptions {
  /** Callback fired for each stream event, used to feed useActivity. */
  onActivityEvent?: (event: StreamEvent) => void;
  /** Optional budget ceiling (USD) from preferences.md — passed to useCostTracker */
  budgetCeiling?: number | null;
}

/**
 * Hook for managing multi-session chat over a shared WebSocket.
 * Replaces useChat for multi-session scenarios.
 */
export function useSessionManager(
  wsUrl: string = "ws://localhost:4001",
  options: UseSessionManagerOptions = {},
): UseSessionManagerResult {
  const [sessions, setSessions] = useState<SessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messagesBySession, setMessagesBySession] = useState<Map<string, ChatMessage[]>>(new Map());
  const [processingBySession, setProcessingBySession] = useState<Map<string, boolean>>(new Map());
  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPromptEvent | null>(null);
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [isCrashed, setIsCrashed] = useState(false);
  const [boundaryViolation, setBoundaryViolation] = useState<{ path: string } | null>(null);
  const { addCostEvent, costState } = useCostTracker(options.budgetCeiling ?? null);

  // Keep isAutoMode in a ref for use inside the message handler (avoid stale closure)
  const isAutoModeRef = useRef(isAutoMode);
  useEffect(() => { isAutoModeRef.current = isAutoMode; }, [isAutoMode]);
  const isCrashedRef = useRef(isCrashed);
  useEffect(() => { isCrashedRef.current = isCrashed; }, [isCrashed]);

  const onActivityEventRef = useRef(options.onActivityEvent);
  onActivityEventRef.current = options.onActivityEvent;

  // Build virtual state for pure function calls
  const getState = useCallback((): SessionManagerState => ({
    sessions,
    activeSessionId,
    messagesBySession,
    processingBySession,
  }), [sessions, activeSessionId, messagesBySession, processingBySession]);

  const applyState = useCallback((newState: SessionManagerState) => {
    setSessions(newState.sessions);
    setActiveSessionId(newState.activeSessionId);
    setMessagesBySession(newState.messagesBySession);
    setProcessingBySession(newState.processingBySession);
  }, []);

  // Use refs for state in message handler to avoid stale closures
  const stateRef = useRef<SessionManagerState>({ sessions: [], activeSessionId: "", messagesBySession: new Map(), processingBySession: new Map() });
  useEffect(() => {
    stateRef.current = { sessions, activeSessionId, messagesBySession, processingBySession };
  }, [sessions, activeSessionId, messagesBySession, processingBySession]);

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as Record<string, unknown>;
    if (!msg || typeof msg !== "object") return;
    const msgType = msg.type as string | undefined;

    // Ignore planning state messages
    if (msgType === "full" || msgType === "diff") return;

    // Handle custom commands discovery
    if (msgType === "custom_commands") {
      const commands = msg.commands as SlashCommand[] | undefined;
      if (commands && Array.isArray(commands)) {
        setCustomCommands(commands);
      }
      return;
    }

    // Handle permission prompt
    if (msgType === "permission_prompt") {
      const promptData = msg as unknown as PermissionPromptEvent;
      setPermissionPrompt({
        type: "permission_prompt",
        toolName: promptData.toolName,
        toolInput: promptData.toolInput,
        promptId: promptData.promptId,
      });
      return;
    }

    // Handle project switched — clear all sessions
    if (msgType === "project_switched") {
      setSessions([]);
      setActiveSessionId("");
      setMessagesBySession(new Map());
      setProcessingBySession(new Map());
      // Request fresh session list
      sendRef.current(JSON.stringify({ type: "session_list" }));
      return;
    }

    // Handle session_update from server
    if (msgType === "session_update") {
      const serverSessions = (msg.sessions as SessionMetadata[]) ?? [];
      const tabs: SessionTab[] = serverSessions.map((s) => ({
        id: s.id,
        name: s.name,
        isProcessing: s.isProcessing,
        hasWorktree: !!(s.worktreePath),
        worktreeBranch: s.worktreeBranch ?? null,
      }));
      const current = stateRef.current;
      const updated = handleSessionUpdate(current, tabs);
      applyState(updated);
      return;
    }

    // Determine sessionId for chat events
    const sessionId = (msg.sessionId as string) || stateRef.current.activeSessionId;

    if (msgType === "chat_event" && msg.event) {
      const evt = msg.event as StreamEvent;

      // Feed activity events
      onActivityEventRef.current?.(evt);

      // Handle process_crashed raw event (cast from 13-02)
      if ((evt as { type: string }).type === "process_crashed") {
        setIsCrashed(true);
        setIsAutoMode(false);
        return;
      }

      // Classify Pi SDK events for auto mode, cost, phase, tool state
      const rawEvent = msg.event as Record<string, unknown>;
      const classified = classifyPiSdkEvent(rawEvent);
      if (classified) {
        if (classified.kind === "cost_update") {
          addCostEvent(classified.total_cost_usd);
        } else {
          const result = applyGSD2Event(classified, {
            isAutoMode: isAutoModeRef.current,
            isCrashed: isCrashedRef.current,
          });
          if (result.isAutoMode !== isAutoModeRef.current) {
            setIsAutoMode(result.isAutoMode);
          }
          if (result.messageInsert) {
            setMessagesBySession((prev) => {
              const newMap = new Map(prev);
              const msgs = [...(newMap.get(sessionId) ?? [])];
              msgs.push(result.messageInsert!);
              newMap.set(sessionId, msgs);
              return newMap;
            });
          }
        }
        return;
      }

      // Skip noise events
      if (evt.type === "system" && !evt.result) return;
      if ((evt as { type: string }).type === "rate_limit_event") return;
      if (evt.type === "stream_event" && evt.event) {
        const inner = evt.event;
        if (inner.type === "message_start" || inner.type === "message_delta" || inner.type === "message_stop") return;
      }
      if (evt.type === "assistant") return;

      const current = stateRef.current;
      const updated = routeChatEvent(current, sessionId, evt);
      setMessagesBySession(updated.messagesBySession);
      setProcessingBySession(updated.processingBySession);
      return;
    }

    if (msgType === "chat_complete") {
      const current = stateRef.current;
      const updated = routeChatComplete(current, sessionId);
      setMessagesBySession(updated.messagesBySession);
      setProcessingBySession(updated.processingBySession);

      // Auto-naming: if session still has default "Chat N" name, derive from first user message
      const sessionTab = current.sessions.find((s) => s.id === sessionId);
      if (sessionTab && /^Chat \d+$/.test(sessionTab.name)) {
        const msgs = current.messagesBySession.get(sessionId) ?? [];
        const firstUserMsg = msgs.find((m) => m.role === "user");
        if (firstUserMsg) {
          const derivedName = deriveSessionName(firstUserMsg.content);
          if (derivedName !== "Chat") {
            // Send rename over WebSocket — server handles worktree/branch rename
            sendRef.current(JSON.stringify({ type: "session_rename", sessionId, name: derivedName }));
            // Optimistic update
            setSessions((prev) =>
              prev.map((s) => (s.id === sessionId ? { ...s, name: derivedName } : s)),
            );
          }
        }
      }

      return;
    }

    if (msgType === "chat_error") {
      const errorText = (msg.error as string) ?? "Unknown error occurred";
      const current = stateRef.current;
      const updated = routeChatError(current, sessionId, errorText);
      setMessagesBySession(updated.messagesBySession);
      setProcessingBySession(updated.processingBySession);
      return;
    }

    // Handle boundary violation — AI tried to access a file outside the project (PERM-03)
    if (msgType === "boundary_violation") {
      const path = (msg.path as string) ?? "(unknown path)";
      setBoundaryViolation({ path });
      return;
    }
  }, [applyState]);

  const { send } = useReconnectingWebSocket(wsUrl, {
    onMessage: handleMessage,
  });

  // Keep send in a ref for the message handler
  const sendRef = useRef(send);
  sendRef.current = send;

  // On mount, request session list
  useEffect(() => {
    // Small delay to ensure WS is connected
    const timer = setTimeout(() => {
      send(JSON.stringify({ type: "session_list" }));
    }, 100);
    return () => clearTimeout(timer);
  }, [send]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Add user message to active session's buffer
    const userMsg: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
      streaming: false,
    };

    setMessagesBySession((prev) => {
      const newMap = new Map(prev);
      const msgs = [...(newMap.get(stateRef.current.activeSessionId) ?? [])];
      msgs.push(userMsg);
      newMap.set(stateRef.current.activeSessionId, msgs);
      return newMap;
    });

    setProcessingBySession((prev) => {
      const newMap = new Map(prev);
      newMap.set(stateRef.current.activeSessionId, true);
      return newMap;
    });

    // Send over WebSocket with sessionId
    const payload = buildChatPayload(stateRef.current, trimmed);
    send(JSON.stringify(payload));
  }, [send]);

  const doSelectSession = useCallback((id: string) => {
    setActiveSessionId(id);
  }, []);

  const createSessionAction = useCallback((forkFrom?: string) => {
    const payload: Record<string, unknown> = { type: "session_create" };
    if (forkFrom) {
      payload.forkFromSessionId = forkFrom;
    }
    send(JSON.stringify(payload));
  }, [send]);

  const closeSessionAction = useCallback((id: string, closeAction?: "merge" | "keep" | "delete") => {
    send(JSON.stringify({ type: "session_close", sessionId: id, closeAction }));

    // Optimistically remove from local state
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      // Auto-switch if closing active
      setActiveSessionId((currentActive) => {
        if (currentActive === id) {
          return remaining[0]?.id ?? "";
        }
        return currentActive;
      });
      return remaining;
    });

    // Clean up message buffer
    setMessagesBySession((prev) => {
      const newMap = new Map(prev);
      newMap.delete(id);
      return newMap;
    });
    setProcessingBySession((prev) => {
      const newMap = new Map(prev);
      newMap.delete(id);
      return newMap;
    });
  }, [send]);

  const renameSessionAction = useCallback((id: string, name: string) => {
    send(JSON.stringify({ type: "session_rename", sessionId: id, name }));
    // Optimistic update
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name } : s)),
    );
  }, [send]);

  const respondToPermission = useCallback((action: "approve" | "always_allow" | "deny") => {
    if (!permissionPrompt) return;
    send(JSON.stringify({
      type: "permission_response",
      promptId: permissionPrompt.promptId,
      action,
    }));
    setPermissionPrompt(null);
  }, [send, permissionPrompt]);

  // Interrupt: send SIGINT signal to active session's process via WebSocket
  const interrupt = useCallback(() => {
    const sessionId = stateRef.current.activeSessionId;
    if (!sessionId) return;
    send(JSON.stringify({ type: "session_interrupt", sessionId }));
  }, [send]);

  // resetCrash: clears crash banner state
  const resetCrash = useCallback(() => {
    setIsCrashed(false);
  }, []);

  // dismissBoundaryViolation: clears boundary violation banner
  const dismissBoundaryViolation = useCallback(() => {
    setBoundaryViolation(null);
  }, []);

  return {
    sessions,
    activeSessionId,
    activeMessages: messagesBySession.get(activeSessionId) ?? [],
    isActiveProcessing: processingBySession.get(activeSessionId) ?? false,
    selectSession: doSelectSession,
    createSession: createSessionAction,
    closeSession: closeSessionAction,
    renameSession: renameSessionAction,
    sendMessage,
    permissionPrompt,
    respondToPermission,
    isAutoMode,
    isCrashed,
    interrupt,
    resetCrash,
    costState,
    boundaryViolation,
    dismissBoundaryViolation,
  };
}
