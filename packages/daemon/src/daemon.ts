import type { DaemonConfig, ProjectInfo } from './types.js';
import type { Logger } from './logger.js';
import { SessionManager } from './session-manager.js';
import { scanForProjects } from './project-scanner.js';
import { DiscordBot, validateDiscordConfig } from './discord-bot.js';
import { EventBridge } from './event-bridge.js';
import { Orchestrator } from './orchestrator.js';

/**
 * Core daemon class — ties config + logger together with lifecycle management.
 * Registers SIGTERM/SIGINT handlers for clean shutdown.
 */
export class Daemon {
  private shuttingDown = false;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private readonly onSigterm: () => void;
  private readonly onSigint: () => void;
  private sessionManager: SessionManager | undefined;
  private discordBot: DiscordBot | undefined;
  private eventBridge: EventBridge | undefined;
  private orchestrator: Orchestrator | undefined;

  constructor(
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
    private readonly healthIntervalMs: number = 300_000,
  ) {
    this.onSigterm = () => void this.shutdown();
    this.onSigint = () => void this.shutdown();
  }

  /** Start the daemon: log startup info, register signal handlers, start keepalive. */
  async start(): Promise<void> {
    this.sessionManager = new SessionManager(this.logger);

    this.logger.info('daemon started', {
      log_level: this.config.log.level,
      scan_roots: this.config.projects.scan_roots.length,
      discord_configured: !!this.config.discord,
    });

    process.on('SIGTERM', this.onSigterm);
    process.on('SIGINT', this.onSigint);

    // Keep the event loop alive. The write stream alone doesn't hold a ref
    // when there's no pending I/O, so we need an explicit timer.
    this.keepaliveTimer = setInterval(() => {}, 60_000);

    // Conditionally start Discord bot if config is present and valid
    if (this.config.discord?.token) {
      try {
        validateDiscordConfig(this.config.discord);
        this.discordBot = new DiscordBot({
          config: this.config.discord,
          logger: this.logger,
          sessionManager: this.sessionManager,
          scanProjects: () => this.scanProjects(),
        });
        await this.discordBot.login();

        // Wire up EventBridge after bot is ready
        const channelManager = this.discordBot.getChannelManager();
        const client = this.discordBot.getClient();
        if (channelManager && client) {
          this.eventBridge = new EventBridge({
            sessionManager: this.sessionManager,
            channelManager,
            client,
            config: this.config,
            logger: this.logger,
            ownerId: this.config.discord.owner_id,
          });
          this.discordBot.setEventBridge(this.eventBridge);
          this.eventBridge.start();
          this.logger.info('event bridge wired');

          // Wire up Orchestrator if control_channel_id is configured
          if (this.config.discord.control_channel_id) {
            this.orchestrator = new Orchestrator({
              sessionManager: this.sessionManager,
              channelManager,
              scanProjects: () => this.scanProjects(),
              config: {
                model: this.config.discord.orchestrator?.model ?? 'claude-haiku-4-5-20251001',
                max_tokens: this.config.discord.orchestrator?.max_tokens ?? 1024,
                control_channel_id: this.config.discord.control_channel_id,
              },
              logger: this.logger,
              ownerId: this.config.discord.owner_id,
            });
            client.on('messageCreate', (message) => {
              void this.orchestrator!.handleMessage(message);
            });
            this.logger.info('orchestrator wired', {
              control_channel_id: this.config.discord.control_channel_id,
            });
          }
        } else {
          this.logger.warn('event bridge skipped — channel manager or client not available');
        }
      } catch (err) {
        // Log error but don't abort daemon startup — bot is optional
        this.logger.error('discord bot login failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.discordBot = undefined;
      }
    }

    // Health heartbeat — logs uptime, session count, Discord status, memory
    const startTime = Date.now();
    this.healthTimer = setInterval(() => {
      const sessions = this.sessionManager?.getAllSessions() ?? [];
      const activeSessions = sessions.filter(
        (s) => s.status === 'running' || s.status === 'blocked',
      ).length;
      this.logger.info('health', {
        uptime_s: Math.floor((Date.now() - startTime) / 1000),
        active_sessions: activeSessions,
        discord_connected: !!this.discordBot?.getClient()?.isReady(),
        memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      });
    }, this.healthIntervalMs);
  }

  /** Scan configured project roots for project directories. */
  async scanProjects(): Promise<ProjectInfo[]> {
    return scanForProjects(this.config.projects.scan_roots);
  }

  /** Accessor for the session manager (available after start()). */
  getSessionManager(): SessionManager {
    if (!this.sessionManager) {
      throw new Error('Daemon not started — call start() before accessing the session manager');
    }
    return this.sessionManager;
  }

  /** Accessor for the event bridge (available after start() with Discord configured). */
  getEventBridge(): EventBridge | undefined {
    return this.eventBridge;
  }

  /** Accessor for the orchestrator (available after start() with control_channel_id configured). */
  getOrchestrator(): Orchestrator | undefined {
    return this.orchestrator;
  }

  /** Idempotent shutdown: log, cleanup sessions, close logger, exit. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.info('daemon shutting down');

    // Remove signal handlers to avoid double-fire
    process.removeListener('SIGTERM', this.onSigterm);
    process.removeListener('SIGINT', this.onSigint);

    // Clear health heartbeat timer
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }

    // Clear keepalive so the event loop can drain
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }

    // Stop Orchestrator first
    if (this.orchestrator) {
      this.orchestrator.stop();
      this.orchestrator = undefined;
    }

    // Stop EventBridge before Discord bot destroy
    if (this.eventBridge) {
      await this.eventBridge.stop();
      this.eventBridge = undefined;
    }

    // Destroy Discord bot before session cleanup
    if (this.discordBot) {
      await this.discordBot.destroy();
      this.discordBot = undefined;
    }

    // Clean up active sessions before closing logger
    if (this.sessionManager) {
      await this.sessionManager.cleanup();
    }

    await this.logger.close();
    process.exit(0);
  }
}
