/**
 * DiscordBot — wraps discord.js Client with login/destroy lifecycle, auth guard,
 * and integration with the daemon's SessionManager.
 *
 * Auth model (D016): single Discord user ID allowlist. All non-owner interactions
 * silently ignored; rejections logged at debug level (userId only, no PII).
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ComponentType,
  type Interaction,
  type Guild,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { DaemonConfig, VerbosityLevel, ProjectInfo } from './types.js';
import type { Logger } from './logger.js';
import type { SessionManager } from './session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { buildCommands, registerGuildCommands, formatSessionStatus } from './commands.js';
import type { EventBridge } from './event-bridge.js';

// ---------------------------------------------------------------------------
// Pure helpers — exported for testability
// ---------------------------------------------------------------------------

/**
 * Auth guard: returns true iff userId matches the configured owner_id.
 * Rejects empty or missing ownerId to fail closed.
 */
export function isAuthorized(userId: string, ownerId: string): boolean {
  if (!ownerId || !userId) return false;
  return userId === ownerId;
}

/**
 * Validates that all required discord config fields are present.
 * Throws with a descriptive message on the first missing field.
 */
export function validateDiscordConfig(
  config: DaemonConfig['discord'],
): asserts config is NonNullable<DaemonConfig['discord']> {
  if (!config) {
    throw new Error('Discord config is undefined');
  }
  if (!config.token || config.token.trim() === '') {
    throw new Error('Discord config missing required field: token');
  }
  if (!config.guild_id || config.guild_id.trim() === '') {
    throw new Error('Discord config missing required field: guild_id');
  }
  if (!config.owner_id || config.owner_id.trim() === '') {
    throw new Error('Discord config missing required field: owner_id');
  }
}

// ---------------------------------------------------------------------------
// DiscordBot class
// ---------------------------------------------------------------------------

export interface DiscordBotOptions {
  config: NonNullable<DaemonConfig['discord']>;
  logger: Logger;
  sessionManager: SessionManager;
  /** Optional function to scan for projects (passed from Daemon). */
  scanProjects?: () => Promise<ProjectInfo[]>;
}

export class DiscordBot {
  private client: Client | null = null;
  private destroyed = false;
  private channelManager: ChannelManager | null = null;
  private eventBridge: EventBridge | null = null;

  private readonly config: NonNullable<DaemonConfig['discord']>;
  private readonly logger: Logger;
  private readonly sessionManager: SessionManager;
  private readonly scanProjects?: () => Promise<ProjectInfo[]>;

  constructor(opts: DiscordBotOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.sessionManager = opts.sessionManager;
    this.scanProjects = opts.scanProjects;
  }

  /**
   * Create the discord.js Client, register event handlers, and log in.
   * Throws on login failure — the caller (Daemon) decides whether to continue without the bot.
   */
  async login(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.once('ready', (readyClient) => {
      const guildNames = readyClient.guilds.cache.map((g) => g.name).join(', ');
      this.logger.info('bot ready', {
        username: readyClient.user.tag,
        guilds: guildNames,
      });

      // Register slash commands for the configured guild
      const rest = new REST({ version: '10' }).setToken(this.config.token);
      const commands = buildCommands();
      registerGuildCommands(
        rest,
        readyClient.user.id,
        this.config.guild_id,
        commands,
        this.logger,
      ).catch((err) => {
        // Should not reach here — registerGuildCommands catches internally
        this.logger.warn('unexpected command registration error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    client.on('interactionCreate', (interaction: Interaction) => {
      this.handleInteraction(interaction);
    });

    // Debug: log all incoming messages at debug level
    client.on('messageCreate', (msg) => {
      this.logger.debug('raw messageCreate', {
        authorId: msg.author.id,
        authorBot: msg.author.bot,
        channelId: msg.channelId,
        contentLength: msg.content.length,
        hasContent: msg.content.length > 0,
      });
    });

    // Reconnection observability — structured logging for all shard lifecycle events (R027)
    client.on('shardError', (error) => {
      this.logger.error('discord shard error', { error: error.message });
    });
    client.on('shardDisconnect', (event, shardId) => {
      this.logger.warn('discord shard disconnected', { shardId, code: event.code });
    });
    client.on('shardReconnecting', (shardId) => {
      this.logger.info('discord shard reconnecting', { shardId });
    });
    client.on('shardResume', (shardId, replayedEvents) => {
      this.logger.info('discord shard resumed', { shardId, replayedEvents });
    });
    client.on('warn', (message) => {
      this.logger.warn('discord warning', { message });
    });
    client.on('error', (error) => {
      this.logger.error('discord error', { error: error.message });
    });

    // Wait for both login AND the 'ready' event.
    // client.login() resolves on WebSocket auth, but the 'ready' event fires
    // asynchronously later. We need 'ready' before getChannelManager() works.
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    let readySettled = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyTimeout = setTimeout(() => {
        if (!readySettled) { readySettled = true; reject(new Error('Discord ready timeout (30s)')); }
      }, 30_000);
      const cleanup = () => {
        if (readyTimeout) { clearTimeout(readyTimeout); readyTimeout = undefined; }
      };
      client.once('ready', () => {
        cleanup();
        if (!readySettled) { readySettled = true; resolve(); }
      });
      client.once('error', (err) => {
        cleanup();
        if (!readySettled) { readySettled = true; reject(err); }
      });
      // shardDisconnect fires on fatal gateway errors (e.g. 4014 disallowed intents)
      client.once('shardDisconnect', (event) => {
        cleanup();
        if (!readySettled) { readySettled = true; reject(new Error(`Shard disconnected: ${event.code}`)); }
      });
    });

    try {
      await client.login(this.config.token);
    } catch (err) {
      // Login itself failed — clean up the ready timer so it doesn't fire as unhandled rejection
      if (readyTimeout) { clearTimeout(readyTimeout); readyTimeout = undefined; }
      readySettled = true;
      throw err;
    }
    await readyPromise;
    this.client = client;
    this.destroyed = false;
  }

  /**
   * Destroy the discord.js Client. Idempotent — safe to call multiple times
   * or before login().
   */
  async destroy(): Promise<void> {
    if (this.destroyed || !this.client) {
      this.destroyed = true;
      return;
    }

    try {
      // discord.js destroy() is synchronous but may throw on double-destroy
      this.client.destroy();
      this.logger.info('bot destroyed');
    } catch (err) {
      // Swallow cleanup errors — shutdown must not fail
      this.logger.debug('bot destroy error (swallowed)', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.client = null;
      this.destroyed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  /**
   * Lazily create a ChannelManager from the configured guild.
   * Returns null if the client isn't ready or the guild isn't found.
   */
  getChannelManager(): ChannelManager | null {
    if (this.channelManager) return this.channelManager;
    if (!this.client?.isReady()) return null;

    const guild = this.client.guilds.cache.get(this.config.guild_id);
    if (!guild) {
      this.logger.warn('guild not found for channel manager', { guildId: this.config.guild_id });
      return null;
    }

    this.channelManager = new ChannelManager({ guild, logger: this.logger });
    return this.channelManager;
  }

  /**
   * Return the underlying discord.js Client, or null if not logged in.
   * Used by Daemon to pass to EventBridge as BridgeClient.
   */
  getClient(): Client | null {
    return this.client;
  }

  /**
   * Set the EventBridge reference so the bot can dispatch /gsd-verbose commands.
   * Called by Daemon after creating the EventBridge.
   */
  setEventBridge(bridge: EventBridge): void {
    this.eventBridge = bridge;
  }

  // ---------------------------------------------------------------------------
  // Private: interaction handling
  // ---------------------------------------------------------------------------

  private handleInteraction(interaction: Interaction): void {
    if (!isAuthorized(interaction.user.id, this.config.owner_id)) {
      this.logger.debug('auth rejected', { userId: interaction.user.id });
      return;
    }

    // Only handle chat input (slash) commands
    if (!interaction.isChatInputCommand()) {
      this.logger.debug('non-command interaction', {
        type: interaction.type,
        userId: interaction.user.id,
      });
      return;
    }

    const { commandName } = interaction;
    this.logger.info('command handled', { commandName, userId: interaction.user.id });

    switch (commandName) {
      case 'gsd-status': {
        const sessions = this.sessionManager.getAllSessions();
        const content = formatSessionStatus(sessions);
        interaction.reply({ content, ephemeral: true }).catch((err) => {
          this.logger.warn('gsd-status reply failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }
      case 'gsd-start':
        this.handleGsdStart(interaction).catch((err) => {
          this.logger.warn('gsd-start handler error', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      case 'gsd-stop':
        this.handleGsdStop(interaction).catch((err) => {
          this.logger.warn('gsd-stop handler error', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      case 'gsd-verbose': {
        if (!this.eventBridge) {
          interaction.reply({ content: 'Event bridge not available.', ephemeral: true }).catch((err) => {
            this.logger.warn('gsd-verbose reply failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          break;
        }
        const level = (interaction.options.getString('level') ?? 'default') as VerbosityLevel;
        const channelId = interaction.channelId;
        this.eventBridge.getVerbosityManager().setLevel(channelId, level);
        interaction.reply({ content: `Verbosity set to **${level}** for this channel.`, ephemeral: true }).catch((err) => {
          this.logger.warn('gsd-verbose reply failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }
      default:
        interaction.reply({ content: 'Unknown command', ephemeral: true }).catch((err) => {
          this.logger.warn('unknown command reply failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: /gsd-start handler
  // ---------------------------------------------------------------------------

  private async handleGsdStart(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    this.logger.info('gsd-start: scanning projects');

    if (!this.scanProjects) {
      await interaction.editReply({ content: 'Project scanning not available.' });
      return;
    }

    let projects: ProjectInfo[];
    try {
      projects = await this.scanProjects();
    } catch (err) {
      this.logger.error('gsd-start: scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      await interaction.editReply({ content: 'Failed to scan for projects.' });
      return;
    }

    if (projects.length === 0) {
      await interaction.editReply({ content: 'No projects found.' });
      return;
    }

    // Discord select menus support max 25 options
    const truncated = projects.slice(0, 25);
    const select = new StringSelectMenuBuilder()
      .setCustomId('gsd-start-select')
      .setPlaceholder('Select a project to start')
      .addOptions(
        truncated.map((p) => ({
          label: p.name.slice(0, 100), // Discord label max 100 chars
          value: p.path,
          description: p.markers.join(', ').slice(0, 100) || undefined,
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const reply = await interaction.editReply({
      content: `Select a project to start (${truncated.length}${projects.length > 25 ? ` of ${projects.length}` : ''} projects):`,
      components: [row],
    });

    try {
      const collected = await reply.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 60_000,
        filter: (i) => i.user.id === interaction.user.id,
      }) as StringSelectMenuInteraction;

      const projectPath = collected.values[0];
      this.logger.info('gsd-start: project selected', { projectPath });

      // Defer the update immediately — startSession can take 10-30s to spawn the GSD process,
      // and Discord's component interaction token expires in 3 seconds without deferral.
      await collected.deferUpdate();

      try {
        const sessionId = await this.sessionManager.startSession({ projectDir: projectPath });
        await interaction.editReply({
          content: `✅ Session started for **${projectPath}** (ID: \`${sessionId}\`)`,
          components: [],
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error('gsd-start: startSession failed', { error: errMsg, projectPath });
        await interaction.editReply({
          content: `❌ Failed to start session: ${errMsg}`,
          components: [],
        });
      }
    } catch {
      // Timeout or other collector error
      this.logger.info('gsd-start: selection timed out');
      await interaction.editReply({ content: 'Selection timed out.', components: [] });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: /gsd-stop handler
  // ---------------------------------------------------------------------------

  private async handleGsdStop(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    this.logger.info('gsd-stop: listing sessions');

    const allSessions = this.sessionManager.getAllSessions();
    const activeSessions = allSessions.filter(
      (s) => s.status === 'running' || s.status === 'blocked' || s.status === 'starting',
    );

    if (activeSessions.length === 0) {
      await interaction.editReply({ content: 'No active sessions.' });
      return;
    }

    // Discord select menus support max 25 options
    const truncated = activeSessions.slice(0, 25);
    const select = new StringSelectMenuBuilder()
      .setCustomId('gsd-stop-select')
      .setPlaceholder('Select a session to stop')
      .addOptions(
        truncated.map((s) => ({
          label: `${s.projectName} (${s.status})`.slice(0, 100),
          value: s.sessionId,
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const reply = await interaction.editReply({
      content: `Select a session to stop (${truncated.length} active):`,
      components: [row],
    });

    try {
      const collected = await reply.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 60_000,
        filter: (i) => i.user.id === interaction.user.id,
      }) as StringSelectMenuInteraction;

      const sessionId = collected.values[0];
      this.logger.info('gsd-stop: session selected', { sessionId });

      try {
        await this.sessionManager.cancelSession(sessionId);
        await collected.update({
          content: `✅ Session \`${sessionId}\` stopped.`,
          components: [],
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error('gsd-stop: cancelSession failed', { error: errMsg, sessionId });
        await collected.update({
          content: `❌ Failed to stop session: ${errMsg}`,
          components: [],
        });
      }
    } catch {
      // Timeout or other collector error
      this.logger.info('gsd-stop: selection timed out');
      await interaction.editReply({ content: 'Selection timed out.', components: [] });
    }
  }
}
