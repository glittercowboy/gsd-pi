// Barrel file — re-exports consumed by external modules

export { handleRemote } from "./remote-command.js";
export { createPromptRecord, writePromptRecord } from "./store.js";
export { getLatestPromptSummary } from "./status.js";
export {
	parseSlackReply,
	parseDiscordResponse,
	formatForDiscord,
	formatForSlack,
	parseSlackReactionResponse,
	formatForTelegram,
	parseTelegramResponse,
} from "./format.js";
export { resolveRemoteConfig, isValidChannelId } from "./config.js";
export { sendRemoteNotification } from "./notify.js";
