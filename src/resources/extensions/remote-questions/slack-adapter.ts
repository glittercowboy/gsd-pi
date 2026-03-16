/**
 * Remote Questions — Slack adapter
 */

import type { ChannelAdapter, RemotePrompt, RemoteDispatchResult, RemoteAnswer, RemotePromptRef } from "./types.js";
import { formatForSlack, parseSlackReply, parseSlackReactionResponse, SLACK_NUMBER_REACTION_NAMES } from "./format.js";

const SLACK_API = "https://slack.com/api";
const PER_REQUEST_TIMEOUT_MS = 15_000;
const SLACK_ACK_REACTION = "white_check_mark";

export class SlackAdapter implements ChannelAdapter {
  readonly name = "slack" as const;
  private botUserId: string | null = null;
  private readonly token: string;
  private readonly channelId: string;

  constructor(token: string, channelId: string) {
    this.token = token;
    this.channelId = channelId;
  }

  async validate(): Promise<void> {
    const res = await this.slackApi("auth.test", {});
    if (!res.ok) throw new Error(`Slack auth failed: ${res.error ?? "invalid token"}`);
    this.botUserId = String(res.user_id ?? "");
  }

  async sendPrompt(prompt: RemotePrompt): Promise<RemoteDispatchResult> {
    const res = await this.slackApi("chat.postMessage", {
      channel: this.channelId,
      text: "GSD needs your input",
      blocks: formatForSlack(prompt),
    });

    if (!res.ok) throw new Error(`Slack postMessage failed: ${res.error ?? "unknown"}`);

    const ts = String(res.ts);
    const channel = String(res.channel);
    if (prompt.questions.length === 1) {
      const reactionNames = SLACK_NUMBER_REACTION_NAMES.slice(0, prompt.questions[0].options.length);
      for (const name of reactionNames) {
        try {
          await this.slackApi("reactions.add", { channel, timestamp: ts, name });
        } catch {
          // Best-effort only
        }
      }
    }

    return {
      ref: {
        id: prompt.id,
        channel: "slack",
        messageId: ts,
        threadTs: ts,
        channelId: channel,
        threadUrl: `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`,
      },
    };
  }

  async pollAnswer(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    if (!this.botUserId) await this.validate();

    if (prompt.questions.length === 1) {
      const reactionAnswer = await this.checkReactions(prompt, ref);
      if (reactionAnswer) return reactionAnswer;
    }

    const res = await this.slackApi("conversations.replies", {
      channel: ref.channelId,
      ts: ref.threadTs!,
      limit: "20",
    });

    if (!res.ok) return null;

    const messages = (res.messages ?? []) as Array<{ user?: string; text?: string; ts: string }>;
    const userReplies = messages.filter((m) => m.ts !== ref.threadTs && m.user && m.user !== this.botUserId && m.text);
    if (userReplies.length === 0) return null;

    return parseSlackReply(String(userReplies[0].text), prompt.questions);
  }

  async acknowledgeAnswer(ref: RemotePromptRef): Promise<void> {
    try {
      await this.slackApi("reactions.add", {
        channel: ref.channelId,
        timestamp: ref.messageId,
        name: SLACK_ACK_REACTION,
      });
    } catch {
      // Best-effort only
    }
  }

  private async checkReactions(prompt: RemotePrompt, ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    const res = await this.slackApi("reactions.get", {
      channel: ref.channelId,
      timestamp: ref.messageId,
      full: "true",
    });

    if (!res.ok) return null;

    const message = (res.message ?? {}) as {
      reactions?: Array<{ name?: string; count?: number; users?: string[] }>;
    };
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    const picked = reactions
      .filter((reaction) => reaction.name && SLACK_NUMBER_REACTION_NAMES.includes(reaction.name))
      .filter((reaction) => {
        const count = Number(reaction.count ?? 0);
        const users = Array.isArray(reaction.users) ? reaction.users.map(String) : [];
        const botIncluded = this.botUserId ? users.includes(this.botUserId) : false;
        return count > (botIncluded ? 1 : 0);
      })
      .map((reaction) => String(reaction.name));

    if (picked.length === 0) return null;
    return parseSlackReactionResponse(picked, prompt.questions);
  }

  private async slackApi(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${SLACK_API}/${method}`;
    const isGet = method === "conversations.replies" || method === "auth.test" || method === "reactions.get";

    let response: Response;
    if (isGet) {
      const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString();
      response = await fetch(`${url}?${qs}`, { method: "GET", headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
    } else {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
    }

    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}: ${response.statusText}`);
    return (await response.json()) as Record<string, unknown>;
  }
}
