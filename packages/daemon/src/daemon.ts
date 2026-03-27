import type { DaemonConfig, ProjectInfo } from './types.js';
import type { Logger } from './logger.js';
import { SessionManager } from './session-manager.js';
import { scanForProjects } from './project-scanner.js';
import { DiscordBot, validateDiscordConfig } from './discord-bot.js';

/**
 * Core daemon class — ties config + logger together with lifecycle management.
 * Registers SIGTERM/SIGINT handlers for clean shutdown.
 */
export class Daemon {
  private shuttingDown = false;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private readonly onSigterm: () => void;
  private readonly onSigint: () => void;
  private sessionManager: SessionManager | undefined;
  private discordBot: DiscordBot | undefined;

  constructor(
    private readonly config: DaemonConfig,
    private readonly logger: Logger,
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
        });
        await this.discordBot.login();
      } catch (err) {
        // Log error but don't abort daemon startup — bot is optional
        this.logger.error('discord bot login failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.discordBot = undefined;
      }
    }
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

  /** Idempotent shutdown: log, cleanup sessions, close logger, exit. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.logger.info('daemon shutting down');

    // Remove signal handlers to avoid double-fire
    process.removeListener('SIGTERM', this.onSigterm);
    process.removeListener('SIGINT', this.onSigint);

    // Clear keepalive so the event loop can drain
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
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
