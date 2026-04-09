/**
 * event-formatter.ts — Pure functions mapping RPC event types to Discord embeds.
 *
 * Each formatter returns a FormattedEvent (content string + optional EmbedBuilder +
 * optional ActionRow components). Distinct embed colors per category:
 *   green  = success / completion
 *   red    = error
 *   yellow = blocker (needs attention)
 *   blue   = info / session lifecycle
 *   grey   = tool / generic
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { SdkAgentEvent } from '@gsd-build/rpc-client';
import type { RpcExtensionUIRequest } from '@gsd-build/rpc-client';
import type { FormattedEvent, PendingBlocker } from './types.js';

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

const COLOR = {
  success: 0x2ecc71, // green
  error: 0xe74c3c,   // red
  blocker: 0xf1c40f,  // yellow
  info: 0x3498db,     // blue
  tool: 0x95a5a6,     // grey
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxLen, appending ellipsis if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/** Safe string extraction from an unknown field. */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

/** Safe number extraction. */
function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  return fallback;
}

/** Format a cost value to a readable string. */
function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatToolStart(event: SdkAgentEvent): FormattedEvent {
  const toolName = str(event.name || event.toolName, 'unknown');
  const embed = new EmbedBuilder()
    .setColor(COLOR.tool)
    .setTitle(`🔧 ${truncate(toolName, 60)}`)
    .setTimestamp();

  const input = str(event.input || event.args);
  if (input) {
    embed.setDescription(`\`\`\`\n${truncate(input, 300)}\n\`\`\``);
  }

  return { content: `🔧 Tool: ${toolName}`, embed };
}

export function formatToolEnd(event: SdkAgentEvent): FormattedEvent {
  const toolName = str(event.name || event.toolName, 'unknown');
  const isError = event.isError === true || event.error != null;
  const color = isError ? COLOR.error : COLOR.tool;
  const icon = isError ? '❌' : '✅';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} ${truncate(toolName, 60)}`)
    .setTimestamp();

  const output = str(event.output || event.result);
  if (output) {
    embed.setDescription(`\`\`\`\n${truncate(output, 300)}\n\`\`\``);
  }

  const duration = num(event.duration || event.durationMs);
  if (duration > 0) {
    embed.setFooter({ text: `${(duration / 1000).toFixed(1)}s` });
  }

  return { content: `${icon} Tool done: ${toolName}`, embed };
}

export function formatMessage(event: SdkAgentEvent): FormattedEvent {
  // Extract text from content blocks or message field
  let text = '';

  // Try content array first (most common for agent messages)
  if (Array.isArray(event.content)) {
    const blocks = event.content as Array<{ type?: string; text?: string }>;
    text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n');
  }

  // Try message field — could be string, object with content array, or object with text
  if (!text && event.message != null) {
    if (typeof event.message === 'string') {
      text = event.message;
    } else if (typeof event.message === 'object') {
      const msg = event.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        const blocks = msg.content as Array<{ type?: string; text?: string }>;
        text = blocks
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text!)
          .join('\n');
      } else if (typeof msg.text === 'string') {
        text = msg.text;
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }
    }
  }

  // Fallback to text or content as plain strings
  if (!text) {
    text = typeof event.text === 'string' ? event.text : '';
  }
  if (!text && typeof event.content === 'string') {
    text = event.content;
  }

  if (!text) {
    return { content: '💬 (empty message)' };
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR.info)
    .setDescription(truncate(text, 2000))
    .setTimestamp();

  const role = str(event.role);
  if (role) {
    embed.setAuthor({ name: role });
  }

  return { content: `💬 ${truncate(text, 200)}`, embed };
}

/**
 * Format a blocker (extension_ui_request needing user response).
 * Produces an embed with @mention and interactive buttons for select/confirm,
 * or text instructions for input/editor.
 */
export function formatBlocker(
  blocker: PendingBlocker,
  ownerId: string,
): FormattedEvent {
  const mention = `<@${ownerId}>`;
  const embed = new EmbedBuilder()
    .setColor(COLOR.blocker)
    .setTitle('⚠️ Blocker — Response Needed')
    .setDescription(truncate(blocker.message, 2000))
    .setTimestamp();

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  switch (blocker.method) {
    case 'select': {
      const evt = blocker.event as { options?: string[] };
      const options = Array.isArray(evt.options) ? evt.options : [];

      if (options.length > 0) {
        // Discord ActionRow max 5 buttons, so chunk
        const chunks = chunkArray(options.slice(0, 25), 5);
        for (const chunk of chunks) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          chunk.forEach((opt, i) => {
            const globalIndex = options.indexOf(opt);
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`blocker:${blocker.id}:select:${globalIndex}`)
                .setLabel(truncate(`${globalIndex + 1}. ${opt}`, 80))
                .setStyle(ButtonStyle.Primary),
            );
          });
          components.push(row);
        }
      }

      embed.addFields({
        name: 'Options',
        value: options.map((o, i) => `**${i + 1}.** ${truncate(o, 100)}`).join('\n') || 'No options',
      });
      break;
    }

    case 'confirm': {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`blocker:${blocker.id}:confirm:true`)
          .setLabel('Yes')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`blocker:${blocker.id}:confirm:false`)
          .setLabel('No')
          .setStyle(ButtonStyle.Danger),
      );
      components.push(row);

      const msg = str((blocker.event as { message?: string }).message);
      if (msg) {
        embed.addFields({ name: 'Details', value: truncate(msg, 1024) });
      }
      break;
    }

    case 'input': {
      const placeholder = str((blocker.event as { placeholder?: string }).placeholder);
      embed.addFields({
        name: 'How to respond',
        value: `Reply in this channel with your answer.${placeholder ? `\n*Hint: ${placeholder}*` : ''}`,
      });
      break;
    }

    case 'editor': {
      const prefill = str((blocker.event as { prefill?: string }).prefill);
      embed.addFields({
        name: 'How to respond',
        value: 'Reply in this channel with the full text.' +
          (prefill ? `\n\nCurrent value:\n\`\`\`\n${truncate(prefill, 500)}\n\`\`\`` : ''),
      });
      break;
    }

    default: {
      embed.addFields({
        name: 'How to respond',
        value: `Reply in this channel (method: ${blocker.method}).`,
      });
      break;
    }
  }

  return {
    content: `${mention} ⚠️ **Blocker** — ${truncate(blocker.message, 150)}`,
    embed,
    components: components.length > 0 ? components : undefined,
  };
}

export function formatCompletion(event: SdkAgentEvent): FormattedEvent {
  const status = str(event.status, 'completed');
  const isError = status === 'error' || status === 'cancelled';
  const color = isError ? COLOR.error : COLOR.success;
  const icon = isError ? '⚠️' : '🏁';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} Execution ${status}`)
    .setTimestamp();

  const reason = str(event.reason);
  if (reason) {
    embed.setDescription(truncate(reason, 2000));
  }

  // Include final stats if present
  const stats = event.stats as { cost?: number; tokens?: { total?: number } } | undefined;
  if (stats) {
    const fields: string[] = [];
    if (stats.cost != null) fields.push(`Cost: ${formatCost(num(stats.cost))}`);
    if (stats.tokens?.total != null) fields.push(`Tokens: ${num(stats.tokens.total).toLocaleString()}`);
    if (fields.length) embed.addFields({ name: 'Summary', value: fields.join(' · ') });
  }

  return { content: `${icon} Execution ${status}`, embed };
}

export function formatError(sessionId: string, error: string): FormattedEvent {
  const embed = new EmbedBuilder()
    .setColor(COLOR.error)
    .setTitle('❌ Session Error')
    .setDescription(`\`\`\`\n${truncate(error, 2000)}\n\`\`\``)
    .setFooter({ text: `Session: ${sessionId}` })
    .setTimestamp();

  return { content: `❌ Error: ${truncate(error, 200)}`, embed };
}

export function formatCostUpdate(event: SdkAgentEvent): FormattedEvent {
  const cost = num(event.cumulativeCost ?? event.totalCost);
  const tokens = event.tokens as
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    | undefined;

  const embed = new EmbedBuilder()
    .setColor(COLOR.info)
    .setTitle('💰 Cost Update')
    .setTimestamp();

  const fields: string[] = [`Total: ${formatCost(cost)}`];
  if (tokens) {
    const input = num(tokens.input);
    const output = num(tokens.output);
    if (input || output) {
      fields.push(`Tokens: ${input.toLocaleString()} in / ${output.toLocaleString()} out`);
    }
  }
  embed.setDescription(fields.join('\n'));

  return { content: `💰 Cost: ${formatCost(cost)}`, embed };
}

export function formatSessionStarted(projectName: string): FormattedEvent {
  const embed = new EmbedBuilder()
    .setColor(COLOR.info)
    .setTitle('🚀 Session Started')
    .setDescription(`Project: **${truncate(projectName, 200)}**`)
    .setTimestamp();

  return { content: `🚀 Session started: ${projectName}`, embed };
}

export function formatTaskTransition(event: SdkAgentEvent): FormattedEvent {
  const taskId = str(event.taskId || event.task);
  const sliceId = str(event.sliceId || event.slice);
  const status = str(event.status || event.state);
  const icon = status === 'complete' ? '✅' : status === 'error' ? '❌' : '📋';

  const embed = new EmbedBuilder()
    .setColor(status === 'complete' ? COLOR.success : status === 'error' ? COLOR.error : COLOR.info)
    .setTitle(`${icon} Task Transition`)
    .setTimestamp();

  const fields: string[] = [];
  if (sliceId) fields.push(`Slice: ${sliceId}`);
  if (taskId) fields.push(`Task: ${taskId}`);
  if (status) fields.push(`Status: ${status}`);
  embed.setDescription(fields.join('\n'));

  return { content: `${icon} ${taskId || 'Task'} → ${status || 'unknown'}`, embed };
}

export function formatGenericEvent(event: SdkAgentEvent): FormattedEvent {
  const type = str(event.type, 'unknown');
  const embed = new EmbedBuilder()
    .setColor(COLOR.tool)
    .setTitle(`📡 ${truncate(type, 60)}`)
    .setTimestamp();

  // Include a JSON preview of the event, stripping the type field
  const { type: _t, ...rest } = event;
  const preview = JSON.stringify(rest);
  if (preview.length > 2) { // more than '{}'
    embed.setDescription(`\`\`\`json\n${truncate(preview, 1000)}\n\`\`\``);
  }

  return { content: `📡 Event: ${type}`, embed };
}

// ---------------------------------------------------------------------------
// Dispatch — maps event type to the right formatter
// ---------------------------------------------------------------------------

/**
 * Format any SdkAgentEvent for Discord. Falls back to formatGenericEvent
 * for unknown types.
 */
export function formatEvent(event: SdkAgentEvent, ownerId?: string): FormattedEvent {
  const type = str(event.type);

  switch (type) {
    case 'tool_execution_start':
      return formatToolStart(event);
    case 'tool_execution_end':
      return formatToolEnd(event);
    case 'message_start':
    case 'message_end':
    case 'message':
      return formatMessage(event);
    case 'execution_complete':
      return formatCompletion(event);
    case 'cost_update':
      return formatCostUpdate(event);
    case 'task_transition':
      return formatTaskTransition(event);
    default:
      return formatGenericEvent(event);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
