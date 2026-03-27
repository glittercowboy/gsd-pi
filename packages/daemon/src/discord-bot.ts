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
  type Interaction,
} from 'discord.js';
import type { DaemonConfig } from './types.js';
import type { Logger } from './logger.js';
import type { SessionManager } from './session-manager.js';

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
}

export class DiscordBot {
  private client: Client | null = null;
  private destroyed = false;

  private readonly config: NonNullable<DaemonConfig['discord']>;
  private readonly logger: Logger;
  private readonly sessionManager: SessionManager;

  constructor(opts: DiscordBotOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.sessionManager = opts.sessionManager;
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
    });

    client.on('interactionCreate', (interaction: Interaction) => {
      this.handleInteraction(interaction);
    });

    await client.login(this.config.token);
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
  // Private: interaction handling
  // ---------------------------------------------------------------------------

  private handleInteraction(interaction: Interaction): void {
    if (!isAuthorized(interaction.user.id, this.config.owner_id)) {
      this.logger.debug('auth rejected', { userId: interaction.user.id });
      return;
    }

    // Authorized — delegate to command handler (stub for T03 slash commands)
    // For now, just log the interaction type for observability
    this.logger.debug('interaction received', {
      type: interaction.type,
      userId: interaction.user.id,
    });
  }
}
