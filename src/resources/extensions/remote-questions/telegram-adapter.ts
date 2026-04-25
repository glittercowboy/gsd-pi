/**
 * Remote Questions — Telegram adapter
 */

import { type ChannelAdapter, type RemotePrompt, type RemoteDispatchResult, type RemoteAnswer, type RemotePromptRef } from "./types.js";
import { formatForTelegram, parseTelegramResponse } from "./format.js";
import { apiRequest } from "./http-client.js";
import { isCommand, handleCommand, type CommandSender } from "./commands.js";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram" as const;
  private botUserId: number | null = null;
  private lastUpdateId = 0;
  private lastSentText = "";
  private readonly token: string;
  private readonly chatId: string;
  private readonly basePath: string;

  constructor(token: string, chatId: string, basePath: string) {
    this.token = token;
    this.chatId = chatId;
    this.basePath = basePath;
  }

  async validate(): Promise<void> {
    const res = await this.telegramApi("getMe");
    if (!res.ok || !res.result?.id) throw new Error("Telegram auth failed: invalid bot token");
    this.botUserId = res.result.id;
  }

  async sendPrompt(prompt: RemotePrompt): Promise<RemoteDispatchResult> {
    const payload = formatForTelegram(prompt);
    this.lastSentText = payload.text;

    const params: Record<string, unknown> = {
      chat_id: this.chatId,
      text: payload.text,
      parse_mode: payload.parse_mode,
    };
    if (payload.reply_markup) {
      params.reply_markup = payload.reply_markup;
    }

    const res = await this.telegramApi("sendMessage", params);
    if (!res.ok || !res.result?.message_id) {
      throw new Error(`Telegram sendMessage failed: ${JSON.stringify(res)}`);
    }

    const messageId = String(res.result.message_id);
    const messageUrl = this.buildMessageUrl(this.chatId, messageId);

    return {
      ref: {
        id: prompt.id,
        channel: "telegram",
        messageId,
        channelId: this.chatId,
        threadUrl: messageUrl,
      },
    };
  }

  async pollAnswer(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    if (!this.botUserId) await this.validate();

    const res = await this.telegramApi("getUpdates", {
      offset: this.lastUpdateId + 1,
      timeout: 0,
      allowed_updates: ["message", "callback_query"],
    });

    if (!res.ok || !Array.isArray(res.result)) return null;

    for (const update of res.result) {
      // Advance offset for all updates to prevent reprocessing
      if (update.update_id > this.lastUpdateId) {
        this.lastUpdateId = update.update_id;
      }

      // Handle callback_query (inline keyboard button press)
      if (update.callback_query) {
        const cq = update.callback_query;
        const msg = cq.message;
        if (
          msg &&
          String(msg.chat?.id) === ref.channelId &&
          String(msg.message_id) === ref.messageId &&
          cq.from?.id !== this.botUserId
        ) {
          // Dismiss the loading spinner on the button
          try {
            await this.telegramApi("answerCallbackQuery", { callback_query_id: cq.id });
          } catch { /* best-effort */ }

          return parseTelegramResponse(cq.data ?? null, null, prompt.questions, prompt.id);
        }
      }

      // Handle text reply (reply_to_message)
      if (update.message) {
        const msg = update.message;
        // Defensive: ensure command replies go back to our configured chat, not an unvalidated chat ID.
        // ref.channelId is always set from this.chatId in sendPrompt, so this guard enforces that.
        const replyChatId = String(msg.chat?.id) === this.chatId ? this.chatId : null;
        if (!replyChatId) continue; // skip messages not from our configured chat

        if (
          String(msg.chat?.id) === ref.channelId &&
          msg.from?.id !== this.botUserId &&
          msg.text
        ) {
          // Intercept slash commands — handle and continue polling for the answer
          if (isCommand(msg.text)) {
            const sender = this.makeCommandSender(replyChatId);
            try {
              await handleCommand(msg.text, sender, this.basePath);
            } catch { /* best-effort — command errors must not disrupt polling */ }
            continue;
          }

          if (
            msg.reply_to_message &&
            String(msg.reply_to_message.message_id) === ref.messageId
          ) {
            return parseTelegramResponse(null, msg.text, prompt.questions, prompt.id);
          }
        }
      }
    }

    return null;
  }

  /**
   * Poll Telegram for incoming slash commands and handle them.
   * Intended for idle-time polling when no question prompt is active.
   * Returns the number of commands handled.
   */
  async pollAndHandleCommands(basePath: string): Promise<number> {
    if (!this.botUserId) {
      try {
        await this.validate();
      } catch {
        return 0;
      }
    }

    const res = await this.telegramApi("getUpdates", {
      offset: this.lastUpdateId + 1,
      timeout: 0,
      allowed_updates: ["message"],
    });

    if (!res.ok || !Array.isArray(res.result)) return 0;

    let handled = 0;
    for (const update of res.result) {
      if (update.update_id > this.lastUpdateId) {
        this.lastUpdateId = update.update_id;
      }

      const msg = update.message;
      if (
        msg &&
        String(msg.chat?.id) === this.chatId &&
        msg.from?.id !== this.botUserId &&
        msg.text &&
        isCommand(msg.text)
      ) {
        const sender = this.makeCommandSender(msg.chat?.id ?? this.chatId);
        try {
          await handleCommand(msg.text, sender, basePath);
          handled++;
        } catch { /* best-effort */ }
      }
    }

    return handled;
  }

  /**
   * Acknowledge receipt by editing the original message to append a checkmark.
   * Best-effort — failures are silently ignored.
   */
  async acknowledgeAnswer(ref: RemotePromptRef): Promise<void> {
    try {
      await this.telegramApi("editMessageText", {
        chat_id: ref.channelId,
        message_id: parseInt(ref.messageId, 10),
        text: this.lastSentText + "\n\n✅ Answered",
        parse_mode: "HTML",
      });
    } catch {
      // Best-effort — don't let acknowledgement failures affect the flow
    }
  }

  private makeCommandSender(chatId: string | number): CommandSender {
    const targetChatId = String(chatId);
    return {
      send: async (text: string): Promise<void> => {
        try {
          await this.telegramApi("sendMessage", {
            chat_id: targetChatId,
            text,
            parse_mode: "Markdown",
          });
        } catch { /* best-effort — command replies must not disrupt polling */ }
      },
    };
  }

  private buildMessageUrl(chatId: string, messageId: string): string | undefined {
    // Supergroups have chat IDs starting with -100
    if (chatId.startsWith("-100")) {
      return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
    }
    return undefined;
  }

  private async telegramApi(method: string, params?: Record<string, unknown>): Promise<any> {
    return apiRequest(
      `${TELEGRAM_API}/bot${this.token}/${method}`,
      "POST",
      params,
      { errorLabel: "Telegram API" },
    );
  }
}
