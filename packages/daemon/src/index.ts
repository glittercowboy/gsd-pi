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
  FormattedEvent,
  VerbosityLevel,
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
export { ChannelManager, sanitizeChannelName } from './channel-manager.js';
export type { ChannelManagerOptions } from './channel-manager.js';
export { buildCommands, formatSessionStatus, registerGuildCommands } from './commands.js';
export { EventBridge } from './event-bridge.js';
export type { BridgeClient, EventBridgeOptions } from './event-bridge.js';
export { Orchestrator } from './orchestrator.js';
export type { OrchestratorConfig, OrchestratorDeps, DiscordMessageLike } from './orchestrator.js';
export { MessageBatcher } from './message-batcher.js';
export type { SendPayload, SendFn, BatcherLogger, BatcherOptions } from './message-batcher.js';
export { VerbosityManager, shouldShowAtLevel } from './verbosity.js';
export {
  formatToolStart,
  formatToolEnd,
  formatMessage,
  formatBlocker,
  formatCompletion,
  formatError,
  formatCostUpdate,
  formatSessionStarted,
  formatTaskTransition,
  formatGenericEvent,
  formatEvent,
} from './event-formatter.js';
export {
  escapeXml,
  generatePlist,
  getPlistPath,
  install as installLaunchAgent,
  uninstall as uninstallLaunchAgent,
  status as launchAgentStatus,
} from './launchd.js';
export type { PlistOptions, LaunchdStatus, RunCommandFn } from './launchd.js';
