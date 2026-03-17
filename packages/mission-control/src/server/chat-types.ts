/**
 * Shared types for chat infrastructure.
 * Used by ndjson-parser, claude-process, chat-router, and WebSocket chat channel.
 */

// -- Stream Event Types (from Claude CLI stream-json output) --

export type ChatEventType = "system" | "assistant" | "result" | "stream_event" | "permission_prompt" | "rate_limit_event";

export interface StreamEvent {
  type: ChatEventType;
  event?: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string; partial_json?: string };
    content_block?: { type: string; name?: string; id?: string };
  };
  session_id?: string;
  result?: string;
  subtype?: string;
  /** Sub-agent parent tool use ID — present when event originates from a sub-agent. */
  parent_tool_use_id?: string | null;
  /** Unique event identifier from the Claude CLI stream. */
  uuid?: string;
}

// -- Permission Prompt (forwarded from Claude CLI when --dangerously-skip-permissions is OFF) --

export interface PermissionPromptEvent {
  type: "permission_prompt";
  toolName: string;
  toolInput: string;
  promptId: string;
}

export interface PermissionResponse {
  type: "permission_response";
  promptId: string;
  action: "approve" | "always_allow" | "deny";
}

// -- Chat Message (client-side representation) --

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "phase_transition" | "tool_use";
  content: string;
  timestamp: number;
  streaming: boolean;
  toolName?: string;
  toolDone?: boolean;
  /** For phase_transition messages: the phase name */
  phaseTransition?: { phase: string };
  /** For tool_use messages: the raw tool input */
  toolInput?: unknown;
}

// -- Session Metadata (lightweight client-facing representation) --

export interface SessionMetadata {
  id: string;
  name: string;
  slug: string;
  isProcessing: boolean;
  createdAt: number;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
}

// -- Chat Request/Response (WebSocket protocol) --

export interface ChatRequest {
  type: "chat";
  prompt: string;
  sessionId?: string;
}

export interface ChatResponse {
  type: "chat_event" | "chat_complete" | "chat_error" | "permission_prompt";
  event?: StreamEvent;
  sessionId?: string;
  error?: string;
}

// -- Mode Events (Discuss + Review) --

export interface QuestionCardPayload {
  id: string;
  area: string;             // e.g., "Layout style"
  type: "multiple_choice" | "free_text";
  question: string;
  options?: Array<{ value: string; label: string }>;
  questionNumber: number;   // 1-based
  totalQuestions: number;
}

export interface DecisionEntry {
  questionId: string;
  area: string;
  answer: string;
}

export interface PillarScore {
  name: string;             // e.g., "Accessibility"
  score: number;            // 0–10
  findings: string[];
}

export interface FixAction {
  priority: number;         // 1, 2, or 3
  pillar: string;
  description: string;
  draftMessage: string;     // pre-drafted message sent on "Fix" click
}

export interface ReviewResults {
  pillars: PillarScore[];
  topFixes: FixAction[];
}

export type ModeEventType =
  | "discuss_mode_start"
  | "question_card"
  | "decision_logged"
  | "discuss_mode_end"
  | "review_mode_start"
  | "review_mode_end"
  | "dev_server_detected";

export interface ModeEvent {
  type: ModeEventType;
  sessionId?: string;
  total?: number;                    // present on discuss_mode_start
  question?: QuestionCardPayload;   // present on question_card
  decision?: DecisionEntry;         // present on decision_logged
  results?: ReviewResults;          // present on review_mode_start
  port?: number;                     // present on dev_server_detected
}

// WebSocket broadcast event types (not ModeEvents — sent via publishChat):
// { type: "preview_open", port: number }   — fired when dev server port detected
// { type: "preview_close" }               — fired when preview is dismissed

// -- GSD 2 / Pi SDK stream event types --

export type GSD2EventType =
  | "plain_text"
  | "tool_use"
  | "tool_result"
  | "phase_transition"
  | "cost_update"
  | "stuck_detection"
  | "timeout"
  | "auto_mode_announcement";

export type PhaseTransitionPhase = "Research" | "Planning" | "Executing" | "Complete";

export interface PiSdkCostData {
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface PiSdkPhaseTransition {
  phase: PhaseTransitionPhase;
}

export type GSD2StreamEvent =
  | { kind: "plain_text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; tool_use_id: string; content: unknown }
  | { kind: "phase_transition"; phase: PhaseTransitionPhase }
  | { kind: "cost_update"; total_cost_usd: number; input_tokens: number; output_tokens: number }
  | { kind: "stuck_detection"; message: string }
  | { kind: "timeout"; message: string; elapsed_seconds: number }
  | { kind: "auto_mode_announcement"; mode: "start" | "stop"; slice?: string };

// -- Browser State (relayed from headless Playwright to preview panel) --

export interface BrowserStateUpdate {
  type: "browser_state_update";
  screenshot: string;  // base64-encoded JPEG
  url: string;
  title?: string;
  toolName?: string;   // which browser_* tool produced this
}
