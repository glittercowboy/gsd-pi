export type {
  DaemonConfig,
  LogLevel,
  LogEntry,
  SessionStatus,
  ManagedSession,
  PendingBlocker,
  CostAccumulator,
  ProjectInfo,
  ProjectMarker,
  StartSessionOptions,
} from './types.js';
export { MAX_EVENTS, INIT_TIMEOUT_MS } from './types.js';
export { resolveConfigPath, loadConfig, validateConfig } from './config.js';
export { Logger } from './logger.js';
export type { LoggerOptions } from './logger.js';
export { Daemon } from './daemon.js';
export { scanForProjects } from './project-scanner.js';
export { SessionManager } from './session-manager.js';
export { DiscordBot, isAuthorized, validateDiscordConfig } from './discord-bot.js';
export type { DiscordBotOptions } from './discord-bot.js';
