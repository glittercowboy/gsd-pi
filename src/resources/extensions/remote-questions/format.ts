/**
 * Remote Questions — payload formatting and parsing helpers
 */

import type { RemotePrompt, RemoteQuestion, RemoteAnswer } from "./types.js";

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

export const DISCORD_NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
export const SLACK_NUMBER_REACTION_NAMES = ["one", "two", "three", "four", "five"];
const MAX_USER_NOTE_LENGTH = 500;

export function formatForSlack(prompt: RemotePrompt): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "GSD needs your input" },
    },
  ];

  if (prompt.questions.length > 1) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "Reply once in thread using one line per question or semicolons (`1; 2; custom note`).",
      }],
    });
  }

  for (const q of prompt.questions) {
    const supportsReactions = prompt.questions.length === 1;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${q.header}*\n${q.question}` },
    });

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: q.options.map((opt, i) => `${i + 1}. *${opt.label}* — ${opt.description}`).join("\n"),
      },
    });

    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: prompt.questions.length > 1
          ? (q.allowMultiple
              ? "For this question, use comma-separated numbers (`1,3`) or free text."
              : "For this question, use one number (`1`) or free text.")
          : (q.allowMultiple
              ? (supportsReactions
                  ? "Reply in thread with comma-separated numbers (`1,3`) or react with matching number emoji."
                  : "Reply in thread with comma-separated numbers (`1,3`) or free text.")
              : (supportsReactions
                  ? "Reply in thread with a number (`1`) or react with the matching number emoji."
                  : "Reply in thread with a number (`1`) or free text.")),
      }],
    });

    blocks.push({ type: "divider" });
  }

  if (prompt.context?.source) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `Source: \`${prompt.context.source}\``,
      }],
    });
  }

  return blocks;
}

export function formatForDiscord(prompt: RemotePrompt): { embeds: DiscordEmbed[]; reactionEmojis: string[] } {
  const reactionEmojis: string[] = [];
  const embeds: DiscordEmbed[] = prompt.questions.map((q, questionIndex) => {
    const supportsReactions = prompt.questions.length === 1;
    const optionLines = q.options.map((opt, i) => {
      const emoji = DISCORD_NUMBER_EMOJIS[i] ?? `${i + 1}.`;
      if (supportsReactions && DISCORD_NUMBER_EMOJIS[i]) reactionEmojis.push(DISCORD_NUMBER_EMOJIS[i]);
      return `${emoji} **${opt.label}** — ${opt.description}`;
    });

    const footerParts: string[] = [];
    if (supportsReactions) {
      footerParts.push(q.allowMultiple
        ? "Reply with comma-separated choices (`1,3`) or react with matching numbers"
        : "Reply with a number or react with the matching number");
    } else {
      footerParts.push(`Question ${questionIndex + 1}/${prompt.questions.length} — reply with one line per question or use semicolons`);
    }
    if (prompt.context?.source) {
      footerParts.push(`Source: ${prompt.context.source}`);
    }

    return {
      title: q.header,
      description: q.question,
      color: 0x7c3aed,
      fields: [{ name: "Options", value: optionLines.join("\n") }],
      footer: { text: footerParts.join(" · ") },
    };
  });

  return { embeds, reactionEmojis };
}

export function parseSlackReply(text: string, questions: RemoteQuestion[]): RemoteAnswer {
  const answers: RemoteAnswer["answers"] = {};
  const trimmed = text.trim();

  if (questions.length === 1) {
    answers[questions[0].id] = parseAnswerForQuestion(trimmed, questions[0]);
    return { answers };
  }

  const parts = trimmed.includes(";")
    ? trimmed.split(";").map((s) => s.trim()).filter(Boolean)
    : trimmed.split("\n").map((s) => s.trim()).filter(Boolean);

  for (let i = 0; i < questions.length; i++) {
    answers[questions[i].id] = parseAnswerForQuestion(parts[i] ?? "", questions[i]);
  }

  return { answers };
}

export function parseDiscordResponse(
  reactions: Array<{ emoji: string; count: number }>,
  replyText: string | null,
  questions: RemoteQuestion[],
): RemoteAnswer {
  if (replyText) return parseSlackReply(replyText, questions);

  const answers: RemoteAnswer["answers"] = {};
  if (questions.length !== 1) {
    for (const q of questions) {
      answers[q.id] = { answers: [], user_note: "Discord reactions are only supported for single-question prompts" };
    }
    return { answers };
  }

  const q = questions[0];
  const picked = reactions
    .filter((r) => DISCORD_NUMBER_EMOJIS.includes(r.emoji) && r.count > 0)
    .map((r) => q.options[DISCORD_NUMBER_EMOJIS.indexOf(r.emoji)]?.label)
    .filter(Boolean) as string[];

  answers[q.id] = picked.length > 0
    ? { answers: q.allowMultiple ? picked : [picked[0]] }
    : { answers: [], user_note: "No clear response via reactions" };

  return { answers };
}

export function parseSlackReactionResponse(
  reactionNames: string[],
  questions: RemoteQuestion[],
): RemoteAnswer {
  const answers: RemoteAnswer["answers"] = {};
  if (questions.length !== 1) {
    for (const q of questions) {
      answers[q.id] = { answers: [], user_note: "Slack reactions are only supported for single-question prompts" };
    }
    return { answers };
  }

  const q = questions[0];
  const picked = reactionNames
    .filter((name) => SLACK_NUMBER_REACTION_NAMES.includes(name))
    .map((name) => q.options[SLACK_NUMBER_REACTION_NAMES.indexOf(name)]?.label)
    .filter(Boolean) as string[];

  answers[q.id] = picked.length > 0
    ? { answers: q.allowMultiple ? picked : [picked[0]] }
    : { answers: [], user_note: "No clear response via reactions" };

  return { answers };
}

function parseAnswerForQuestion(text: string, q: RemoteQuestion): { answers: string[]; user_note?: string } {
  if (!text) return { answers: [], user_note: "No response provided" };

  if (/^[\d,\s]+$/.test(text)) {
    const nums = text
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= q.options.length);

    if (nums.length > 0) {
      const selected = nums.map((n) => q.options[n - 1].label);
      return { answers: q.allowMultiple ? selected : [selected[0]] };
    }
  }

  const single = parseInt(text, 10);
  if (!Number.isNaN(single) && single >= 1 && single <= q.options.length) {
    return { answers: [q.options[single - 1].label] };
  }

  return { answers: [], user_note: truncateNote(text) };
}

function truncateNote(text: string): string {
  return text.length > MAX_USER_NOTE_LENGTH ? text.slice(0, MAX_USER_NOTE_LENGTH) + "…" : text;
}
