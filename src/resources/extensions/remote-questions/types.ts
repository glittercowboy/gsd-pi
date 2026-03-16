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

export interface RemotePromptRecord {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  status: RemotePromptStatus;
  channel: RemoteChannel;
  timeoutAt: number;
  pollIntervalMs: number;
  questions: RemoteQuestion[];
  ref?: RemotePromptRef;
  response?: RemoteAnswer;
  lastPollAt?: number;
  lastError?: string;
  context?: {
    source: string;
  };
}

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
