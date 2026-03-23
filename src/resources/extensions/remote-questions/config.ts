/**
 * Remote Questions — configuration resolution and validation
 */

import { loadEffectiveGSDPreferences, type RemoteQuestionsConfig } from "../gsd/preferences.js";
import type { RemoteChannel } from "./types.js";

export interface ResolvedConfig {
  channel: RemoteChannel;
  channelId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  token: string;
}

const ENV_KEYS: Record<RemoteChannel, string> = {
  slack: "SLACK_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  telegram: "TELEGRAM_BOT_TOKEN",
  signal: "SIGNAL_SERVICE_URL",
};

// Channel ID format validation — prevents SSRF if preferences are attacker-controlled
const CHANNEL_ID_PATTERNS: Record<RemoteChannel, RegExp> = {
  slack: /^[A-Z0-9]{9,12}$/,
  discord: /^\d{17,20}$/,
  telegram: /^-?\d{5,20}$/,
  signal: /^\+\d{7,15}$/,
};

const DEFAULT_TIMEOUT_MINUTES = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 30;
const MIN_POLL_INTERVAL_SECONDS = 2;
const MAX_POLL_INTERVAL_SECONDS = 30;

export function resolveRemoteConfig(): ResolvedConfig | null {
  const prefs = loadEffectiveGSDPreferences();
  const rq: RemoteQuestionsConfig | undefined = prefs?.preferences.remote_questions;
  if (!rq || !rq.channel || !rq.channel_id) return null;
  if (rq.channel !== "slack" && rq.channel !== "discord" && rq.channel !== "telegram" && rq.channel !== "signal") return null;

  const channelId = String(rq.channel_id);
  if (!CHANNEL_ID_PATTERNS[rq.channel].test(channelId)) return null;

  const token = process.env[ENV_KEYS[rq.channel]];
  if (!token) return null;

  const timeoutMinutes = clampNumber(rq.timeout_minutes, DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
  const pollIntervalSeconds = clampNumber(rq.poll_interval_seconds, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS);

  return {
    channel: rq.channel,
    channelId,
    timeoutMs: timeoutMinutes * 60 * 1000,
    pollIntervalMs: pollIntervalSeconds * 1000,
    token,
  };
}

export function getRemoteConfigStatus(): string {
  const prefs = loadEffectiveGSDPreferences();
  const rq: RemoteQuestionsConfig | undefined = prefs?.preferences.remote_questions;
  if (!rq || !rq.channel || !rq.channel_id) return "Remote questions: not configured";
  if (rq.channel !== "slack" && rq.channel !== "discord" && rq.channel !== "telegram" && rq.channel !== "signal") return `Remote questions: unknown channel type \"${rq.channel}\"`;
  const channelId = String(rq.channel_id);
  if (!CHANNEL_ID_PATTERNS[rq.channel].test(channelId)) return `Remote questions: invalid ${rq.channel} channel ID format`;
  const envVar = ENV_KEYS[rq.channel];
  if (!process.env[envVar]) return `Remote questions: ${envVar} not set — remote questions disabled`;

  const timeoutMinutes = clampNumber(rq.timeout_minutes, DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES);
  const pollIntervalSeconds = clampNumber(rq.poll_interval_seconds, DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS);
  return `Remote questions: ${rq.channel} configured (timeout ${timeoutMinutes}m, poll ${pollIntervalSeconds}s)`;
}

export function isValidChannelId(channel: RemoteChannel, id: string): boolean {
  return CHANNEL_ID_PATTERNS[channel].test(id);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
