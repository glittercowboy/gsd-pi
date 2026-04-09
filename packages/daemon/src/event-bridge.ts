/**
 * event-bridge.ts — Orchestrator wiring SessionManager events through
 * formatter → batcher → Discord channels.
 *
 * Handles:
 *   - Session lifecycle → Discord channel creation and cleanup
 *   - Event streaming → format + verbosity filter + batcher
 *   - Blocker resolution → interactive buttons + text relay
 *   - Conversation relay → Discord messages forwarded to GSD sessions
 *   - DM backup → owner gets DM on blocker when dm_on_blocker configured
 */

import type { Client, Message, TextChannel, MessageComponentInteraction } from 'discord.js';
import { EmbedBuilder, ComponentType } from 'discord.js';
import type { SdkAgentEvent } from '@gsd-build/rpc-client';
import type { Logger } from './logger.js';
import type { DaemonConfig, PendingBlocker } from './types.js';
import type { SessionManager } from './session-manager.js';
import type { ChannelManager } from './channel-manager.js';
import { MessageBatcher } from './message-batcher.js';
import { VerbosityManager } from './verbosity.js';
import {
  formatEvent,
  formatBlocker,
  formatSessionStarted,
  formatError,
  formatCompletion,
} from './event-formatter.js';
import { isAuthorized } from './discord-bot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface for a Discord client — extracted for testability. */
export interface BridgeClient {
  on(event: 'messageCreate', listener: (message: Message) => void): void;
  off(event: 'messageCreate', listener: (message: Message) => void): void;
  users: { fetch(id: string): Promise<{ send(opts: unknown): Promise<unknown> }> };
}

/** Options for creating an EventBridge. */
export interface EventBridgeOptions {
  sessionManager: SessionManager;
  channelManager: ChannelManager;
  client: BridgeClient;
  config: DaemonConfig;
  logger: Logger;
  ownerId: string;
}

// ---------------------------------------------------------------------------
// Collector timeout
// ---------------------------------------------------------------------------

const BLOCKER_COLLECTOR_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// EventBridge
// ---------------------------------------------------------------------------

export class EventBridge {
  private readonly sessionManager: SessionManager;
  private readonly channelManager: ChannelManager;
  private readonly client: BridgeClient;
  private readonly config: DaemonConfig;
  private readonly logger: Logger;
  private readonly ownerId: string;

  /** sessionId → channelId */
  private readonly sessionToChannel = new Map<string, string>();
  /** channelId → sessionId */
  private readonly channelToSession = new Map<string, string>();
  /** sessionId → MessageBatcher */
  private readonly batchers = new Map<string, MessageBatcher>();
  /** sessionId → TextChannel (cached for send operations) */
  private readonly channels = new Map<string, TextChannel>();

  private readonly verbosity = new VerbosityManager();

  /** Bound event handlers for cleanup */
  private boundHandlers: {
    started: (...args: unknown[]) => void;
    event: (...args: unknown[]) => void;
    blocked: (...args: unknown[]) => void;
    completed: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    messageCreate: (msg: Message) => void;
  } | null = null;

  constructor(opts: EventBridgeOptions) {
    this.sessionManager = opts.sessionManager;
    this.channelManager = opts.channelManager;
    this.client = opts.client;
    this.config = opts.config;
    this.logger = opts.logger;
    this.ownerId = opts.ownerId;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Subscribe to SessionManager events and Discord messageCreate. */
  start(): void {
    if (this.boundHandlers) return; // already started

    this.boundHandlers = {
      started: (data: unknown) => {
        void this.onSessionStarted(data as SessionStartedPayload);
      },
      event: (data: unknown) => {
        void this.onSessionEvent(data as SessionEventPayload);
      },
      blocked: (data: unknown) => {
        void this.onSessionBlocked(data as SessionBlockedPayload);
      },
      completed: (data: unknown) => {
        void this.onSessionCompleted(data as SessionCompletedPayload);
      },
      error: (data: unknown) => {
        void this.onSessionError(data as SessionErrorPayload);
      },
      messageCreate: (msg: Message) => {
        void this.handleMessageCreate(msg);
      },
    };

    this.sessionManager.on('session:started', this.boundHandlers.started);
    this.sessionManager.on('session:event', this.boundHandlers.event);
    this.sessionManager.on('session:blocked', this.boundHandlers.blocked);
    this.sessionManager.on('session:completed', this.boundHandlers.completed);
    this.sessionManager.on('session:error', this.boundHandlers.error);
    this.client.on('messageCreate', this.boundHandlers.messageCreate);

    this.logger.info('event bridge started');
  }

  /** Unsubscribe from all events, destroy batchers, clear mappings. */
  async stop(): Promise<void> {
    if (this.boundHandlers) {
      this.sessionManager.off('session:started', this.boundHandlers.started);
      this.sessionManager.off('session:event', this.boundHandlers.event);
      this.sessionManager.off('session:blocked', this.boundHandlers.blocked);
      this.sessionManager.off('session:completed', this.boundHandlers.completed);
      this.sessionManager.off('session:error', this.boundHandlers.error);
      this.client.off('messageCreate', this.boundHandlers.messageCreate);
      this.boundHandlers = null;
    }

    // Destroy all batchers
    const destroyPromises: Promise<void>[] = [];
    for (const batcher of this.batchers.values()) {
      destroyPromises.push(batcher.destroy());
    }
    await Promise.allSettled(destroyPromises);

    this.batchers.clear();
    this.sessionToChannel.clear();
    this.channelToSession.clear();
    this.channels.clear();

    this.logger.info('event bridge stopped');
  }

  /** Expose the verbosity manager for slash-command integration. */
  getVerbosityManager(): VerbosityManager {
    return this.verbosity;
  }

  // -----------------------------------------------------------------------
  // SessionManager event handlers
  // -----------------------------------------------------------------------

  private async onSessionStarted(data: SessionStartedPayload): Promise<void> {
    const { sessionId, projectDir, projectName } = data;

    try {
      const channel = await this.channelManager.createProjectChannel(projectDir);

      // Create batcher with channel.send as the send function
      const batcher = new MessageBatcher(
        async (payload) => {
          await channel.send(payload as Parameters<TextChannel['send']>[0]);
        },
        this.logger,
      );
      batcher.start();

      // Register bidirectional mapping
      this.sessionToChannel.set(sessionId, channel.id);
      this.channelToSession.set(channel.id, sessionId);
      this.batchers.set(sessionId, batcher);
      this.channels.set(sessionId, channel);

      // Post welcome embed
      const welcome = formatSessionStarted(projectName);
      batcher.enqueue(welcome);

      this.logger.info('bridge: session channel created', {
        sessionId,
        channelId: channel.id,
        projectName,
      });
    } catch (err) {
      // Failure mode: log error, skip streaming for this session
      this.logger.error('bridge: channel creation failed', {
        sessionId,
        projectDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async onSessionEvent(data: SessionEventPayload): Promise<void> {
    const { sessionId, event } = data;
    const channelId = this.sessionToChannel.get(sessionId);
    if (!channelId) return; // no channel for this session

    // Verbosity filter
    const eventType = (event as Record<string, unknown>).type as string;
    if (!this.verbosity.shouldShow(channelId, eventType)) return;

    const formatted = formatEvent(event, this.ownerId);
    const batcher = this.batchers.get(sessionId);
    if (batcher) {
      batcher.enqueue(formatted);
    }
  }

  private async onSessionBlocked(data: SessionBlockedPayload): Promise<void> {
    const { sessionId, projectName, blocker } = data;
    const channel = this.channels.get(sessionId);
    if (!channel) return;

    const formatted = formatBlocker(blocker, this.ownerId);

    // Send immediately (bypasses batching for blockers)
    const batcher = this.batchers.get(sessionId);
    if (batcher) {
      await batcher.enqueueImmediate(formatted);
    }

    // For select/confirm methods, set up button collector
    if (blocker.method === 'select' || blocker.method === 'confirm') {
      this.createButtonCollector(sessionId, channel, blocker);
    }

    // DM backup
    if (this.config.discord?.dm_on_blocker) {
      await this.sendBlockerDM(sessionId, projectName, blocker);
    }
  }

  private async onSessionCompleted(data: SessionCompletedPayload): Promise<void> {
    const { sessionId, projectName } = data;
    const batcher = this.batchers.get(sessionId);
    if (!batcher) return;

    const completion = formatCompletion({
      type: 'execution_complete',
      status: 'completed',
    } as SdkAgentEvent);

    // Flush through batcher then cleanup
    batcher.enqueue(completion);
    await this.cleanupSession(sessionId);

    this.logger.info('bridge: session completed', { sessionId, projectName });
  }

  private async onSessionError(data: SessionErrorPayload): Promise<void> {
    const { sessionId, projectName, error } = data;
    const batcher = this.batchers.get(sessionId);
    if (!batcher) return;

    const errorEmbed = formatError(sessionId, error);
    batcher.enqueue(errorEmbed);
    await this.cleanupSession(sessionId);

    this.logger.info('bridge: session error', { sessionId, projectName, error });
  }

  // -----------------------------------------------------------------------
  // Blocker resolution — button collector
  // -----------------------------------------------------------------------

  private createButtonCollector(
    sessionId: string,
    channel: TextChannel,
    blocker: PendingBlocker,
  ): void {
    // Create a message collector on the channel for button interactions
    // We use createMessageComponentCollector on the channel
    try {
      const collector = channel.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: BLOCKER_COLLECTOR_TIMEOUT_MS,
        filter: (interaction: MessageComponentInteraction) => {
          return interaction.customId.startsWith(`blocker:${blocker.id}:`);
        },
      });

      collector.on('collect', async (interaction: MessageComponentInteraction) => {
        // Auth guard
        if (!isAuthorized(interaction.user.id, this.ownerId)) {
          await interaction.reply({
            content: '⛔ Only the project owner can respond to blockers.',
            ephemeral: true,
          }).catch(() => {});
          return;
        }

        // Parse customId: blocker:{id}:{method}:{value}
        const parts = interaction.customId.split(':');
        const value = parts[3] ?? '';

        try {
          await this.sessionManager.resolveBlocker(sessionId, value);
          await interaction.update({
            content: `✅ Blocker resolved with: ${value}`,
            components: [],
          }).catch(() => {});
          collector.stop('resolved');
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error('bridge: blocker resolve failed', { sessionId, error: errMsg });
          await interaction.reply({
            content: `❌ Failed to resolve blocker: ${errMsg}`,
            ephemeral: true,
          }).catch(() => {});
        }
      });

      collector.on('end', (_collected, reason) => {
        if (reason === 'time') {
          // Timeout: edit to show expired
          this.logger.info('bridge: blocker collector timed out', { sessionId, blockerId: blocker.id });
          // Post a new message indicating expiry — editing original may fail
          const batcher = this.batchers.get(sessionId);
          if (batcher) {
            batcher.enqueue({
              content: `⏰ Blocker response timed out after 24h. Re-posting...`,
              embed: new EmbedBuilder()
                .setColor(0xf1c40f)
                .setTitle('⏰ Blocker Expired')
                .setDescription(blocker.message)
                .setTimestamp(),
            });
          }
        }
      });
    } catch (err) {
      this.logger.error('bridge: collector creation failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -----------------------------------------------------------------------
  // DM backup
  // -----------------------------------------------------------------------

  private async sendBlockerDM(
    sessionId: string,
    projectName: string,
    blocker: PendingBlocker,
  ): Promise<void> {
    try {
      const user = await this.client.users.fetch(this.ownerId);
      await user.send({
        content: `⚠️ **Blocker** in **${projectName}** — ${blocker.message}\n\nRespond in the project channel.`,
      });
      this.logger.debug('bridge: DM sent for blocker', { sessionId, blockerId: blocker.id });
    } catch (err) {
      // DM failure is non-fatal — channel message is the primary path
      this.logger.warn('bridge: DM send failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Conversation relay — Discord → GSD
  // -----------------------------------------------------------------------

  private async handleMessageCreate(message: Message): Promise<void> {
    // Filter: bot messages
    if (message.author.bot) return;

    // Filter: must be in a project channel
    const sessionId = this.channelToSession.get(message.channelId);
    if (!sessionId) return;

    // Filter: must be authorized
    if (!isAuthorized(message.author.id, this.ownerId)) return;

    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    // If session has a pending blocker with input/editor method, resolve it
    if (session.pendingBlocker && (session.pendingBlocker.method === 'input' || session.pendingBlocker.method === 'editor')) {
      try {
        await this.sessionManager.resolveBlocker(sessionId, message.content);
        await message.react('✅').catch(() => {});
        this.logger.info('bridge: blocker resolved via relay', {
          sessionId,
          method: session.pendingBlocker.method,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error('bridge: relay blocker resolve failed', { sessionId, error: errMsg });
        await message.reply(`❌ Failed to resolve blocker: ${errMsg}`).catch(() => {});
      }
      return;
    }

    // Otherwise, relay the message to the GSD session
    // Use steer() when running (injects mid-turn), prompt() otherwise (starts new turn)
    try {
      if (session.status === 'running') {
        await session.client.steer(message.content);
      } else {
        await session.client.prompt(message.content);
      }
      await message.react('📨').catch(() => {});
      this.logger.info('bridge: message relayed to session', {
        sessionId,
        method: session.status === 'running' ? 'steer' : 'prompt',
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('bridge: relay failed', { sessionId, error: errMsg });
      await message.reply(`❌ Failed to relay message: ${errMsg}`).catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private async cleanupSession(sessionId: string): Promise<void> {
    const batcher = this.batchers.get(sessionId);
    if (batcher) {
      await batcher.destroy();
      this.batchers.delete(sessionId);
    }

    const channelId = this.sessionToChannel.get(sessionId);
    if (channelId) {
      this.channelToSession.delete(channelId);
    }
    this.sessionToChannel.delete(sessionId);
    this.channels.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Internal event payload types (matching SessionManager emissions)
// ---------------------------------------------------------------------------

interface SessionStartedPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
}

interface SessionEventPayload {
  sessionId: string;
  projectDir: string;
  event: SdkAgentEvent;
}

interface SessionBlockedPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
  blocker: PendingBlocker;
}

interface SessionCompletedPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
}

interface SessionErrorPayload {
  sessionId: string;
  projectDir: string;
  projectName: string;
  error: string;
}
