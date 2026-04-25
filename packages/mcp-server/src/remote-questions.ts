/**
 * Remote Questions — self-contained MCP-server adapter
 *
 * Mirrors the routing logic from src/resources/extensions/ask-user-questions.ts
 * but without any dependency on @gsd/pi-coding-agent or the main src/ tree.
 * All channel adapters (Discord, Slack, Telegram), config resolution, HTTP
 * calls, and polling are inlined here so packages/mcp-server remains a
 * standalone package.
 *
 * Entry points consumed by server.ts:
 *   isRemoteConfigured()     — cheap synchronous config check
 *   tryRemoteQuestions(...)  — dispatch + poll + return result
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RemoteChannel = 'slack' | 'discord' | 'telegram';

interface QuestionOption {
  label: string;
  description: string;
}

export interface RemoteQuestion {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  allowMultiple?: boolean;
}

interface RemotePrompt {
  id: string;
  channel: RemoteChannel;
  createdAt: number;
  timeoutAt: number;
  pollIntervalMs: number;
  questions: RemoteQuestion[];
  context: { source: string };
}

interface RemotePromptRef {
  id: string;
  channel: RemoteChannel;
  messageId: string;
  channelId: string;
  threadTs?: string;
  threadUrl?: string;
}

interface RemoteAnswer {
  answers: Record<string, { answers: string[]; user_note?: string }>;
}

export interface RemoteToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: Record<string, unknown>;
}

interface ResolvedConfig {
  channel: RemoteChannel;
  channelId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  token: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PER_REQUEST_TIMEOUT_MS = 15_000;
const DISCORD_API = 'https://discord.com/api/v10';
const SLACK_API = 'https://slack.com/api';
const TELEGRAM_API = 'https://api.telegram.org';

const DISCORD_NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const SLACK_NUMBER_REACTION_NAMES = ['one', 'two', 'three', 'four', 'five'];

const DEFAULT_TIMEOUT_MINUTES = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 30;
const MIN_POLL_INTERVAL_SECONDS = 2;
const MAX_POLL_INTERVAL_SECONDS = 30;

const CHANNEL_ID_PATTERNS: Record<RemoteChannel, RegExp> = {
  slack: /^[A-Z0-9]{9,12}$/,
  discord: /^\d{17,20}$/,
  telegram: /^-?\d{5,20}$/,
};

const ENV_KEYS: Record<RemoteChannel, string> = {
  slack: 'SLACK_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
  telegram: 'TELEGRAM_BOT_TOKEN',
};

// ---------------------------------------------------------------------------
// Config resolution — reads ~/.gsd/PREFERENCES.md YAML frontmatter
// ---------------------------------------------------------------------------

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Minimal YAML frontmatter reader. Handles:
 *   ---
 *   key: value
 *   nested_key:
 *     child: value
 *   ---
 * Sufficient for the flat remote_questions config block.
 */
function parseSimpleFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, unknown> = {};
  let currentSection: string | null = null;
  const sectionData: Record<string, Record<string, unknown>> = {};

  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Top-level key (no indent)
    const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (topMatch) {
      currentSection = topMatch[1];
      const val = topMatch[2].trim();
      if (val) {
        result[currentSection] = parseSimpleScalar(val);
        currentSection = null; // scalar, no children
      } else {
        sectionData[currentSection] = {};
        result[currentSection] = sectionData[currentSection];
      }
      continue;
    }

    // Indented child key
    const childMatch = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (childMatch && currentSection && sectionData[currentSection]) {
      const childKey = childMatch[1];
      const childVal = childMatch[2].trim();
      sectionData[currentSection][childKey] = parseSimpleScalar(childVal);
    }
  }

  return result;
}

function parseSimpleScalar(raw: string): string | number | boolean | null {
  const s = raw.replace(/^["']|["']$/g, '').trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  const n = Number(s);
  if (s !== '' && !Number.isNaN(n)) return n;
  return s;
}

function loadPreferencesFromFile(path: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(path, 'utf-8');
    return parseSimpleFrontmatter(content);
  } catch {
    return null;
  }
}

function resolveRemoteConfig(): ResolvedConfig | null {
  const gsdHome = process.env['GSD_HOME'] ?? join(homedir(), '.gsd');
  const globalPath = join(gsdHome, 'PREFERENCES.md');

  const prefs = loadPreferencesFromFile(globalPath);
  if (!prefs) return null;

  const rq = prefs['remote_questions'] as Record<string, unknown> | undefined;
  if (!rq || !rq['channel'] || !rq['channel_id']) return null;

  const channel = String(rq['channel']) as RemoteChannel;
  if (channel !== 'slack' && channel !== 'discord' && channel !== 'telegram') return null;

  const channelId = String(rq['channel_id']);
  if (!CHANNEL_ID_PATTERNS[channel].test(channelId)) return null;

  const token = process.env[ENV_KEYS[channel]];
  if (!token) return null;

  const timeoutMs = clampNumber(rq['timeout_minutes'], DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES) * 60 * 1000;
  const pollIntervalMs = clampNumber(rq['poll_interval_seconds'], DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS) * 1000;

  return { channel, channelId, timeoutMs, pollIntervalMs, token };
}

/**
 * Cheap synchronous check — does not make any HTTP requests.
 */
export function isRemoteConfigured(): boolean {
  return resolveRemoteConfig() !== null;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function apiRequest(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  authScheme: 'Bearer' | 'Bot',
  authToken: string,
  errorLabel: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `${authScheme} ${authToken}`,
  };

  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (response.status === 204) return {};

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const safeText = text.length > 200 ? text.slice(0, 200) + '\u2026' : text;
    throw new Error(`${errorLabel} HTTP ${response.status}: ${safeText}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Payload formatting
// ---------------------------------------------------------------------------

function formatForDiscord(prompt: RemotePrompt): { embeds: unknown[]; reactionEmojis: string[] } {
  const reactionEmojis: string[] = [];
  const embeds = prompt.questions.map((q, questionIndex) => {
    const supportsReactions = prompt.questions.length === 1;
    const optionLines = q.options.map((opt, i) => {
      const emoji = DISCORD_NUMBER_EMOJIS[i] ?? `${i + 1}.`;
      if (supportsReactions && DISCORD_NUMBER_EMOJIS[i]) reactionEmojis.push(DISCORD_NUMBER_EMOJIS[i]);
      return `${emoji} **${opt.label}** — ${opt.description}`;
    });

    const footerParts: string[] = [];
    if (supportsReactions) {
      footerParts.push(q.allowMultiple
        ? 'Reply with comma-separated choices (`1,3`) or react with matching numbers'
        : 'Reply with a number or react with the matching number');
    } else {
      footerParts.push(`Question ${questionIndex + 1}/${prompt.questions.length} — reply with one line per question or use semicolons`);
    }
    footerParts.push(`Source: ${prompt.context.source}`);

    return {
      title: q.header,
      description: q.question,
      color: 0x7c3aed,
      fields: [{ name: 'Options', value: optionLines.join('\n') }],
      footer: { text: footerParts.join(' · ') },
    };
  });

  return { embeds, reactionEmojis };
}

function formatForSlack(prompt: RemotePrompt): unknown[] {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'GSD needs your input' } },
  ];

  if (prompt.questions.length > 1) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Reply once in thread using one line per question or semicolons (`1; 2; custom note`).' }],
    });
  }

  for (const q of prompt.questions) {
    const supportsReactions = prompt.questions.length === 1;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${q.header}*\n${q.question}` } });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: q.options.map((opt, i) => `${i + 1}. *${opt.label}* — ${opt.description}`).join('\n') },
    });
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: prompt.questions.length > 1
          ? (q.allowMultiple ? 'For this question, use comma-separated numbers (`1,3`) or free text.' : 'For this question, use one number (`1`) or free text.')
          : (q.allowMultiple
              ? (supportsReactions ? 'Reply in thread with comma-separated numbers (`1,3`) or react with matching number emoji.' : 'Reply in thread with comma-separated numbers (`1,3`) or free text.')
              : (supportsReactions ? 'Reply in thread with a number (`1`) or react with the matching number emoji.' : 'Reply in thread with a number (`1`) or free text.')),
      }],
    });
    blocks.push({ type: 'divider' });
  }

  return blocks;
}

function formatForTelegram(prompt: RemotePrompt): { text: string; parse_mode: 'HTML'; reply_markup?: unknown } {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines: string[] = ['<b>GSD needs your input</b>', ''];

  for (let qi = 0; qi < prompt.questions.length; qi++) {
    const q = prompt.questions[qi];
    lines.push(`<b>${escape(q.header)}</b>`);
    lines.push(escape(q.question));
    lines.push('');
    for (let i = 0; i < q.options.length; i++) {
      lines.push(`${i + 1}. <b>${escape(q.options[i].label)}</b> — ${escape(q.options[i].description)}`);
    }
    lines.push('');
    if (prompt.questions.length === 1) {
      lines.push(q.allowMultiple ? 'Reply with comma-separated numbers (1,3) or free text.' : 'Reply with a number or tap a button below.');
    } else {
      lines.push(`Question ${qi + 1}/${prompt.questions.length} — reply with one line per question or use semicolons.`);
    }
    if (qi < prompt.questions.length - 1) lines.push('');
  }

  const result: { text: string; parse_mode: 'HTML'; reply_markup?: unknown } = {
    text: lines.join('\n'),
    parse_mode: 'HTML',
  };

  if (prompt.questions.length === 1 && prompt.questions[0].options.length <= 5) {
    result.reply_markup = {
      inline_keyboard: prompt.questions[0].options.map((opt, i) => [{
        text: `${i + 1}. ${opt.label}`,
        callback_data: `${prompt.id}:${i}`,
      }]),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseAnswerForQuestion(text: string, q: RemoteQuestion): { answers: string[]; user_note?: string } {
  if (!text) return { answers: [], user_note: 'No response provided' };

  if (/^[\d,\s]+$/.test(text)) {
    const nums = text
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= q.options.length);
    if (nums.length > 0) {
      const selected = nums.map((n) => q.options[n - 1].label);
      return { answers: q.allowMultiple ? selected : [selected[0]] };
    }
  }

  const single = parseInt(text, 10);
  if (!Number.isNaN(single) && single >= 1 && single <= q.options.length) {
    return { answers: [q.options[single - 1].label] };
  }

  const truncated = text.length > 500 ? text.slice(0, 500) + '\u2026' : text;
  return { answers: [], user_note: truncated };
}

function parseTextReply(text: string, questions: RemoteQuestion[]): RemoteAnswer {
  const answers: RemoteAnswer['answers'] = {};
  const trimmed = text.trim();

  if (questions.length === 1) {
    answers[questions[0].id] = parseAnswerForQuestion(trimmed, questions[0]);
    return { answers };
  }

  const parts = trimmed.includes(';')
    ? trimmed.split(';').map((s) => s.trim()).filter(Boolean)
    : trimmed.split('\n').map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < questions.length; i++) {
    answers[questions[i].id] = parseAnswerForQuestion(parts[i] ?? '', questions[i]);
  }

  return { answers };
}

function parseDiscordReactions(
  reactions: Array<{ emoji: string; count: number }>,
  questions: RemoteQuestion[],
): RemoteAnswer {
  const answers: RemoteAnswer['answers'] = {};
  if (questions.length !== 1) {
    for (const q of questions) {
      answers[q.id] = { answers: [], user_note: 'Discord reactions are only supported for single-question prompts' };
    }
    return { answers };
  }

  const q = questions[0];
  const picked = reactions
    .filter((r) => DISCORD_NUMBER_EMOJIS.includes(r.emoji) && r.count > 0)
    .map((r) => q.options[DISCORD_NUMBER_EMOJIS.indexOf(r.emoji)]?.label)
    .filter((l): l is string => Boolean(l));

  answers[q.id] = picked.length > 0
    ? { answers: q.allowMultiple ? picked : [picked[0]] }
    : { answers: [], user_note: 'No clear response via reactions' };

  return { answers };
}

function parseSlackReactions(reactionNames: string[], questions: RemoteQuestion[]): RemoteAnswer {
  const answers: RemoteAnswer['answers'] = {};
  if (questions.length !== 1) {
    for (const q of questions) {
      answers[q.id] = { answers: [], user_note: 'Slack reactions are only supported for single-question prompts' };
    }
    return { answers };
  }

  const q = questions[0];
  const picked = reactionNames
    .filter((name) => SLACK_NUMBER_REACTION_NAMES.includes(name))
    .map((name) => q.options[SLACK_NUMBER_REACTION_NAMES.indexOf(name)]?.label)
    .filter((l): l is string => Boolean(l));

  answers[q.id] = picked.length > 0
    ? { answers: q.allowMultiple ? picked : [picked[0]] }
    : { answers: [], user_note: 'No clear response via reactions' };

  return { answers };
}

function parseTelegramCallbackData(callbackData: string, questions: RemoteQuestion[], promptId: string): RemoteAnswer | null {
  const pattern = new RegExp(`^${promptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)$`);
  const match = callbackData.match(pattern);
  if (match && questions.length === 1) {
    const idx = parseInt(match[1], 10);
    const q = questions[0];
    if (idx >= 0 && idx < q.options.length) {
      return { answers: { [q.id]: { answers: [q.options[idx].label] } } };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel adapters
// ---------------------------------------------------------------------------

interface DispatchResult {
  ref: RemotePromptRef;
}

// --- Discord ---

async function discordValidate(token: string, channelId: string): Promise<{ botUserId: string; guildId: string | null }> {
  const meRes = await apiRequest(`${DISCORD_API}/users/@me`, 'GET', undefined, 'Bot', token, 'Discord API') as Record<string, unknown>;
  if (!meRes['id']) throw new Error('Discord auth failed: invalid token');
  const botUserId = String(meRes['id']);

  let guildId: string | null = null;
  try {
    const chanRes = await apiRequest(`${DISCORD_API}/channels/${channelId}`, 'GET', undefined, 'Bot', token, 'Discord API') as Record<string, unknown>;
    if (chanRes['guild_id']) guildId = String(chanRes['guild_id']);
  } catch { /* non-fatal */ }

  return { botUserId, guildId };
}

async function discordSend(prompt: RemotePrompt, token: string, channelId: string, guildId: string | null): Promise<DispatchResult> {
  const { embeds, reactionEmojis } = formatForDiscord(prompt);
  const res = await apiRequest(
    `${DISCORD_API}/channels/${channelId}/messages`,
    'POST',
    { content: '**GSD needs your input** — reply to this message with your answer', embeds },
    'Bot', token, 'Discord API',
  ) as Record<string, unknown>;

  if (!res['id']) throw new Error(`Discord send failed: ${JSON.stringify(res)}`);
  const messageId = String(res['id']);

  if (prompt.questions.length === 1) {
    for (const emoji of reactionEmojis) {
      try {
        await apiRequest(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, 'PUT', undefined, 'Bot', token, 'Discord API');
      } catch { /* best-effort */ }
    }
  }

  const threadUrl = guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : undefined;
  return { ref: { id: prompt.id, channel: 'discord', messageId, channelId, threadUrl } };
}

async function discordPoll(prompt: RemotePrompt, ref: RemotePromptRef, token: string, botUserId: string): Promise<RemoteAnswer | null> {
  // Try reactions first for single-question prompts
  if (prompt.questions.length === 1) {
    const reactions: Array<{ emoji: string; count: number }> = [];
    for (const emoji of DISCORD_NUMBER_EMOJIS) {
      try {
        const users = await apiRequest(
          `${DISCORD_API}/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent(emoji)}`,
          'GET', undefined, 'Bot', token, 'Discord API',
        ) as unknown[];
        if (Array.isArray(users)) {
          const humanUsers = users.filter((u) => (u as Record<string, unknown>)['id'] !== botUserId);
          if (humanUsers.length > 0) reactions.push({ emoji, count: humanUsers.length });
        }
      } catch (err) {
        const msg = String((err as Error).message ?? '');
        if (msg.includes('HTTP 404')) continue;
        if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) throw err;
      }
    }
    if (reactions.length > 0) return parseDiscordReactions(reactions, prompt.questions);
  }

  // Try text replies
  const messages = await apiRequest(
    `${DISCORD_API}/channels/${ref.channelId}/messages?after=${ref.messageId}&limit=10`,
    'GET', undefined, 'Bot', token, 'Discord API',
  ) as unknown[];

  if (!Array.isArray(messages)) return null;

  const replies = messages.filter((m) => {
    const msg = m as Record<string, unknown>;
    const author = msg['author'] as Record<string, unknown> | undefined;
    const msgRef = msg['message_reference'] as Record<string, unknown> | undefined;
    return author?.['id'] && author['id'] !== botUserId && msgRef?.['message_id'] === ref.messageId && msg['content'];
  });

  if (replies.length === 0) return null;
  const first = replies[0] as Record<string, unknown>;
  return parseTextReply(String(first['content']), prompt.questions);
}

async function discordAcknowledge(ref: RemotePromptRef, token: string): Promise<void> {
  try {
    await apiRequest(
      `${DISCORD_API}/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent('✅')}/@me`,
      'PUT', undefined, 'Bot', token, 'Discord API',
    );
  } catch { /* best-effort */ }
}

// --- Slack ---

async function slackValidate(token: string): Promise<string> {
  const res = await apiRequest(`${SLACK_API}/auth.test`, 'GET', undefined, 'Bearer', token, 'Slack API') as Record<string, unknown>;
  if (!res['ok']) throw new Error(`Slack auth failed: ${res['error'] ?? 'invalid token'}`);
  return String(res['user_id'] ?? '');
}

async function slackSend(prompt: RemotePrompt, token: string, channelId: string): Promise<DispatchResult> {
  const res = await apiRequest(
    `${SLACK_API}/chat.postMessage`,
    'POST',
    { channel: channelId, text: 'GSD needs your input', blocks: formatForSlack(prompt) },
    'Bearer', token, 'Slack API',
  ) as Record<string, unknown>;

  if (!res['ok']) throw new Error(`Slack postMessage failed: ${res['error'] ?? 'unknown'}`);

  const ts = String(res['ts']);
  const channel = String(res['channel']);

  if (prompt.questions.length === 1) {
    const reactionNames = SLACK_NUMBER_REACTION_NAMES.slice(0, prompt.questions[0].options.length);
    for (const name of reactionNames) {
      try {
        await apiRequest(`${SLACK_API}/reactions.add`, 'POST', { channel, timestamp: ts, name }, 'Bearer', token, 'Slack API');
      } catch { /* best-effort */ }
    }
  }

  return {
    ref: {
      id: prompt.id,
      channel: 'slack',
      messageId: ts,
      threadTs: ts,
      channelId: channel,
      threadUrl: `https://slack.com/archives/${channel}/p${ts.replace('.', '')}`,
    },
  };
}

async function slackPoll(prompt: RemotePrompt, ref: RemotePromptRef, token: string, botUserId: string): Promise<RemoteAnswer | null> {
  // Check reactions for single-question prompts
  if (prompt.questions.length === 1) {
    const qs = new URLSearchParams({ channel: ref.channelId, timestamp: ref.messageId, full: 'true' }).toString();
    const res = await apiRequest(`${SLACK_API}/reactions.get?${qs}`, 'GET', undefined, 'Bearer', token, 'Slack API') as Record<string, unknown>;

    if (res['ok']) {
      const message = (res['message'] ?? {}) as { reactions?: Array<{ name?: string; count?: number; users?: string[] }> };
      const reactions = Array.isArray(message.reactions) ? message.reactions : [];
      const picked = reactions
        .filter((r) => r.name && SLACK_NUMBER_REACTION_NAMES.includes(r.name))
        .filter((r) => {
          const count = Number(r.count ?? 0);
          const users = Array.isArray(r.users) ? r.users.map(String) : [];
          const botIncluded = botUserId ? users.includes(botUserId) : false;
          return count > (botIncluded ? 1 : 0);
        })
        .map((r) => String(r.name));

      if (picked.length > 0) return parseSlackReactions(picked, prompt.questions);
    }
  }

  // Check thread replies
  const qs = new URLSearchParams({ channel: ref.channelId, ts: ref.threadTs!, limit: '20' }).toString();
  const res = await apiRequest(`${SLACK_API}/conversations.replies?${qs}`, 'GET', undefined, 'Bearer', token, 'Slack API') as Record<string, unknown>;

  if (!res['ok']) return null;

  const messages = (res['messages'] ?? []) as Array<{ user?: string; text?: string; ts: string }>;
  const userReplies = messages.filter((m) => m.ts !== ref.threadTs && m.user && m.user !== botUserId && m.text);
  if (userReplies.length === 0) return null;

  return parseTextReply(String(userReplies[0].text), prompt.questions);
}

async function slackAcknowledge(ref: RemotePromptRef, token: string): Promise<void> {
  try {
    await apiRequest(
      `${SLACK_API}/reactions.add`,
      'POST',
      { channel: ref.channelId, timestamp: ref.messageId, name: 'white_check_mark' },
      'Bearer', token, 'Slack API',
    );
  } catch { /* best-effort */ }
}

// --- Telegram ---

async function telegramValidate(token: string): Promise<number> {
  const res = await apiRequest(`${TELEGRAM_API}/bot${token}/getMe`, 'GET', undefined, 'Bearer', token, 'Telegram API') as Record<string, unknown>;
  const result = res['result'] as Record<string, unknown> | undefined;
  if (!res['ok'] || !result?.['id']) throw new Error('Telegram auth failed: invalid bot token');
  return result['id'] as number;
}

async function telegramSend(prompt: RemotePrompt, token: string, chatId: string): Promise<DispatchResult> {
  const payload = formatForTelegram(prompt);
  const params: Record<string, unknown> = { chat_id: chatId, text: payload.text, parse_mode: payload.parse_mode };
  if (payload.reply_markup) params['reply_markup'] = payload.reply_markup;

  const res = await apiRequest(`${TELEGRAM_API}/bot${token}/sendMessage`, 'POST', params, 'Bearer', token, 'Telegram API') as Record<string, unknown>;
  const result = res['result'] as Record<string, unknown> | undefined;
  if (!res['ok'] || !result?.['message_id']) throw new Error(`Telegram sendMessage failed: ${JSON.stringify(res)}`);

  const messageId = String(result['message_id']);
  // Build public URL only for public channels (negative IDs are private groups)
  const isPublic = !chatId.startsWith('-');
  const messageUrl = isPublic ? `https://t.me/${chatId.replace('@', '')}/${messageId}` : undefined;

  return { ref: { id: prompt.id, channel: 'telegram', messageId, channelId: chatId, threadUrl: messageUrl } };
}

async function telegramPoll(
  prompt: RemotePrompt,
  ref: RemotePromptRef,
  token: string,
  botUserId: number,
  lastUpdateId: { value: number },
): Promise<RemoteAnswer | null> {
  const params: Record<string, unknown> = {
    offset: lastUpdateId.value + 1,
    timeout: 0,
    allowed_updates: ['message', 'callback_query'],
  };

  const res = await apiRequest(`${TELEGRAM_API}/bot${token}/getUpdates`, 'POST', params, 'Bearer', token, 'Telegram API') as Record<string, unknown>;
  if (!res['ok'] || !Array.isArray(res['result'])) return null;

  for (const update of res['result'] as Record<string, unknown>[]) {
    if ((update['update_id'] as number) > lastUpdateId.value) {
      lastUpdateId.value = update['update_id'] as number;
    }

    // Callback query (inline keyboard button press)
    if (update['callback_query']) {
      const cq = update['callback_query'] as Record<string, unknown>;
      const msg = cq['message'] as Record<string, unknown> | undefined;
      const from = cq['from'] as Record<string, unknown> | undefined;
      if (msg && String((msg['chat'] as Record<string, unknown>)?.['id']) === ref.channelId &&
          String(msg['message_id']) === ref.messageId && from?.['id'] !== botUserId) {
        // Dismiss loading spinner
        try {
          await apiRequest(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, 'POST', { callback_query_id: cq['id'] }, 'Bearer', token, 'Telegram API');
        } catch { /* best-effort */ }
        const callbackData = cq['data'] ? String(cq['data']) : null;
        if (callbackData) {
          const parsed = parseTelegramCallbackData(callbackData, prompt.questions, prompt.id);
          if (parsed) return parsed;
        }
      }
    }

    // Text message reply
    if (update['message']) {
      const msg = update['message'] as Record<string, unknown>;
      const from = msg['from'] as Record<string, unknown> | undefined;
      if (String((msg['chat'] as Record<string, unknown>)?.['id']) === ref.channelId &&
          from?.['id'] !== botUserId && msg['text']) {
        return parseTextReply(String(msg['text']), prompt.questions);
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface ChannelState {
  botUserId: string | number;
  guildId?: string | null; // Discord only
  lastUpdateId?: { value: number }; // Telegram only
}

async function pollUntilDone(
  config: ResolvedConfig,
  prompt: RemotePrompt,
  ref: RemotePromptRef,
  state: ChannelState,
  signal?: AbortSignal,
): Promise<RemoteAnswer | null> {
  while (Date.now() < prompt.timeoutAt && !signal?.aborted) {
    try {
      let answer: RemoteAnswer | null = null;

      if (config.channel === 'discord') {
        answer = await discordPoll(prompt, ref, config.token, String(state.botUserId));
      } else if (config.channel === 'slack') {
        answer = await slackPoll(prompt, ref, config.token, String(state.botUserId));
      } else {
        answer = await telegramPoll(prompt, ref, config.token, state.botUserId as number, state.lastUpdateId!);
      }

      if (answer) return answer;
    } catch {
      // Non-fatal poll error — wait and retry
    }

    await sleep(prompt.pollIntervalMs, signal);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function buildPrompt(questions: RemoteQuestion[], config: ResolvedConfig): RemotePrompt {
  const createdAt = Date.now();
  return {
    id: randomUUID(),
    channel: config.channel,
    createdAt,
    timeoutAt: createdAt + config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    context: { source: 'ask_user_questions' },
    questions: questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      options: q.options,
      allowMultiple: q.allowMultiple ?? false,
    })),
  };
}

function formatForTool(answer: RemoteAnswer): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = {};
  for (const [id, data] of Object.entries(answer.answers)) {
    const list = [...data.answers];
    if (data.user_note) list.push(`user_note: ${data.user_note}`);
    out[id] = { answers: list };
  }
  return out;
}

/**
 * Dispatch questions to the configured remote channel and wait for a response.
 *
 * Returns null when no remote channel is configured.
 * Returns a tool result shaped like { content, details } on success or
 * timeout — callers should check details.timed_out before trusting the result.
 */
export async function tryRemoteQuestions(
  questions: RemoteQuestion[],
  signal?: AbortSignal,
): Promise<RemoteToolResult | null> {
  const config = resolveRemoteConfig();
  if (!config) return null;

  const prompt = buildPrompt(questions, config);

  // Validate auth and send the prompt
  let ref: RemotePromptRef;
  let state: ChannelState;

  try {
    if (config.channel === 'discord') {
      const { botUserId, guildId } = await discordValidate(config.token, config.channelId);
      state = { botUserId, guildId };
      const dispatch = await discordSend(prompt, config.token, config.channelId, guildId);
      ref = dispatch.ref;
    } else if (config.channel === 'slack') {
      const botUserId = await slackValidate(config.token);
      state = { botUserId };
      const dispatch = await slackSend(prompt, config.token, config.channelId);
      ref = dispatch.ref;
    } else {
      const botUserId = await telegramValidate(config.token);
      state = { botUserId, lastUpdateId: { value: 0 } };
      const dispatch = await telegramSend(prompt, config.token, config.channelId);
      ref = dispatch.ref;
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Remote questions failed (${config.channel}): ${(err as Error).message}` }],
      details: { remote: true, channel: config.channel, error: true, status: 'failed' },
    };
  }

  const answer = await pollUntilDone(config, prompt, ref, state, signal);

  if (!answer) {
    const timedOut = !signal?.aborted;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          timed_out: timedOut,
          channel: config.channel,
          prompt_id: prompt.id,
          timeout_minutes: config.timeoutMs / 60000,
          thread_url: ref.threadUrl ?? null,
          message: `User did not respond within ${config.timeoutMs / 60000} minutes.`,
        }),
      }],
      details: {
        remote: true,
        channel: config.channel,
        timed_out: timedOut,
        promptId: prompt.id,
        threadUrl: ref.threadUrl ?? null,
        status: signal?.aborted ? 'cancelled' : 'timed_out',
      },
    };
  }

  // Best-effort acknowledgement
  try {
    if (config.channel === 'discord') await discordAcknowledge(ref, config.token);
    else if (config.channel === 'slack') await slackAcknowledge(ref, config.token);
  } catch { /* best-effort */ }

  return {
    content: [{ type: 'text', text: JSON.stringify({ answers: formatForTool(answer) }) }],
    details: {
      remote: true,
      channel: config.channel,
      timed_out: false,
      promptId: prompt.id,
      threadUrl: ref.threadUrl ?? null,
      questions,
      status: 'answered',
    },
  };
}
