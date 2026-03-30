/**
 * Remote Questions — Telegram adapter
 */

import { type ChannelAdapter, type RemotePrompt, type RemoteDispatchResult, type RemoteAnswer, type RemotePromptRef } from "./types.js";
import { formatForTelegram, parseTelegramResponse } from "./format.js";
import { apiRequest } from "./http-client.js";

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram" as const;
  private botUserId: number | null = null;
  private lastUpdateId = 0;
  private lastSentText = "";
  private readonly token: string;
  private readonly chatId: string;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
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
          } catch (err) { if (process.env.GSD_DEBUG) console.error('[telegram] answerCallbackQuery failed:', (err as Error).message); }

          return parseTelegramResponse(cq.data ?? null, null, prompt.questions, prompt.id);
        }
      }

      // Handle text reply (reply_to_message)
      if (update.message) {
        const msg = update.message;
        if (
          String(msg.chat?.id) === ref.channelId &&
          msg.reply_to_message &&
          String(msg.reply_to_message.message_id) === ref.messageId &&
          msg.from?.id !== this.botUserId &&
          msg.text
        ) {
          return parseTelegramResponse(null, msg.text, prompt.questions, prompt.id);
        }
      }
    }

    return null;
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
