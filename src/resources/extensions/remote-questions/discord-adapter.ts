/**
 * Remote Questions — Discord adapter
 */

import type { ChannelAdapter, RemotePrompt, RemoteDispatchResult, RemoteAnswer, RemotePromptRef } from "./types.js";
import { formatForDiscord, parseDiscordResponse } from "./format.js";

const DISCORD_API = "https://discord.com/api/v10";
const PER_REQUEST_TIMEOUT_MS = 15_000;
const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord" as const;
  private botUserId: string | null = null;
  private guildId: string | null = null;
  private readonly token: string;
  private readonly channelId: string;

  constructor(token: string, channelId: string) {
    this.token = token;
    this.channelId = channelId;
  }

  async validate(): Promise<void> {
    const res = await this.discordApi("GET", "/users/@me");
    if (!res.id) throw new Error("Discord auth failed: invalid token");
    this.botUserId = String(res.id);

    // Resolve guild ID for message URL generation.
    // The channel belongs to a guild — fetch channel info to discover it.
    try {
      const channelInfo = await this.discordApi("GET", `/channels/${this.channelId}`);
      if (channelInfo.guild_id) {
        this.guildId = String(channelInfo.guild_id);
      }
    } catch {
      // Non-fatal — message URLs will be omitted if guild ID can't be resolved
    }
  }

  async sendPrompt(prompt: RemotePrompt): Promise<RemoteDispatchResult> {
    const { embeds, reactionEmojis } = formatForDiscord(prompt);
    const res = await this.discordApi("POST", `/channels/${this.channelId}/messages`, {
      content: "**GSD needs your input** — reply to this message with your answer",
      embeds,
    });

    if (!res.id) throw new Error(`Discord send failed: ${JSON.stringify(res)}`);

    const messageId = String(res.id);
    if (prompt.questions.length === 1) {
      for (const emoji of reactionEmojis) {
        try {
          await this.discordApi("PUT", `/channels/${this.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
        } catch {
          // Best-effort only
        }
      }
    }

    // Build message URL if guild ID is available
    const messageUrl = this.guildId
      ? `https://discord.com/channels/${this.guildId}/${this.channelId}/${messageId}`
      : undefined;

    return {
      ref: {
        id: prompt.id,
        channel: "discord",
        messageId,
        channelId: this.channelId,
        threadUrl: messageUrl,
      },
    };
  }

  async pollAnswer(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    if (!this.botUserId) await this.validate();

    if (prompt.questions.length === 1) {
      const reactionAnswer = await this.checkReactions(prompt, ref);
      if (reactionAnswer) return reactionAnswer;
    }

    return this.checkReplies(prompt, ref);
  }

  /**
   * Acknowledge that an answer was received by adding a ✅ reaction to the
   * original prompt message. Best-effort — failures are silently ignored.
   */
  async acknowledgeAnswer(ref: RemotePromptRef): Promise<void> {
    try {
      await this.discordApi(
        "PUT",
        `/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent("✅")}/@me`,
      );
    } catch {
      // Best-effort — don't let acknowledgement failures affect the flow
    }
  }

  private async checkReactions(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    const reactions: Array<{ emoji: string; count: number }> = [];
    for (const emoji of NUMBER_EMOJIS) {
      try {
        const users = await this.discordApi("GET", `/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent(emoji)}`);
        if (Array.isArray(users)) {
          const humanUsers = users.filter((u: { id: string }) => u.id !== this.botUserId);
          if (humanUsers.length > 0) reactions.push({ emoji, count: humanUsers.length });
        }
      } catch (err) {
        const msg = String((err as Error).message ?? "");
        // 404 = no reactions for this emoji — expected, continue
        if (msg.includes("HTTP 404")) continue;
        // 401/403 = auth failure — surface to caller so it can fail the poll
        if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) throw err;
        // Other errors (rate limit, network) — skip this emoji, best-effort
      }
    }

    if (reactions.length === 0) return null;
    return parseDiscordResponse(reactions, null, prompt.questions);
  }

  private async checkReplies(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    const messages = await this.discordApi("GET", `/channels/${ref.channelId}/messages?after=${ref.messageId}&limit=10`);
    if (!Array.isArray(messages)) return null;

    const replies = messages.filter(
      (m: { author?: { id?: string }; message_reference?: { message_id?: string }; content?: string }) =>
        m.author?.id &&
        m.author.id !== this.botUserId &&
        m.message_reference?.message_id === ref.messageId &&
        m.content,
    );

    if (replies.length === 0) return null;
    return parseDiscordResponse([], String(replies[0].content), prompt.questions);
  }

  private async discordApi(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bot ${this.token}` };
    const init: RequestInit = { method, headers };
    if (body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    init.signal = AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS);
    const response = await fetch(`${DISCORD_API}${path}`, init);
    if (response.status === 204) return {};
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // Limit error body length to avoid leaking verbose Discord error responses
      const safeText = text.length > 200 ? text.slice(0, 200) + "…" : text;
      throw new Error(`Discord API HTTP ${response.status}: ${safeText}`);
    }
    return response.json();
  }
}
