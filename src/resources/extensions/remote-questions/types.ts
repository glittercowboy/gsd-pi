/**
 * Remote Questions — shared types
 */

export type RemoteChannel = "slack" | "discord" | "telegram";

export interface RemoteQuestionOption {
  label: string;
  description: string;
}

export interface RemoteQuestion {
  id: string;
  header: string;
  question: string;
  options: RemoteQuestionOption[];
  allowMultiple: boolean;
}

export interface RemotePrompt {
  id: string;
  channel: RemoteChannel;
  createdAt: number;
  timeoutAt: number;
  pollIntervalMs: number;
  questions: RemoteQuestion[];
  context?: {
    source: string;
  };
}

export interface RemotePromptRef {
  id: string;
  channel: RemoteChannel;
  messageId: string;
  channelId: string;
  threadTs?: string;
  threadUrl?: string;
}

export interface RemoteAnswer {
  answers: Record<string, { answers: string[]; user_note?: string }>;
}

export type RemotePromptStatus = "pending" | "answered" | "timed_out" | "failed" | "cancelled";

/** Shared fields present on every prompt record regardless of dispatch state. */
interface RemotePromptRecordBase {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  channel: RemoteChannel;
  timeoutAt: number;
  pollIntervalMs: number;
  questions: RemoteQuestion[];
  response?: RemoteAnswer;
  lastPollAt?: number;
  lastError?: string;
  context?: {
    source: string;
  };
}

/** Record before the prompt has been dispatched to a channel. */
export interface PendingPromptRecord extends RemotePromptRecordBase {
  status: "pending";
  ref?: undefined;
}

/** Record after the prompt has been dispatched (ref is always present). */
export interface DispatchedPromptRecord extends RemotePromptRecordBase {
  status: RemotePromptStatus;
  ref: RemotePromptRef;
}

/**
 * A prompt record is either pre-dispatch (no ref) or post-dispatch (ref required).
 *
 * Narrow via `record.ref`:
 * ```ts
 * if (record.ref) {
 *   // DispatchedPromptRecord — ref is RemotePromptRef
 * }
 * ```
 */
export type RemotePromptRecord = PendingPromptRecord | DispatchedPromptRecord;

export interface RemoteDispatchResult {
  ref: RemotePromptRef;
}

export interface ChannelAdapter {
  readonly name: RemoteChannel;
  validate(): Promise<void>;
  sendPrompt(prompt: RemotePrompt): Promise<RemoteDispatchResult>;
  pollAnswer(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null>;
  acknowledgeAnswer?(ref: RemotePromptRef): Promise<void>;
}
