/**
 * Remote Questions — /gsd remote command
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { AuthStorage } from "@gsd/pi-coding-agent";
import { CURSOR_MARKER, Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@gsd/pi-tui";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGlobalGSDPreferencesPath, loadEffectiveGSDPreferences } from "../gsd/preferences.js";
import { getRemoteConfigStatus, isValidChannelId, resolveRemoteConfig } from "./config.js";
import { sanitizeError } from "./manager.js";
import { getLatestPromptSummary } from "./status.js";

export async function handleRemote(
  subcommand: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
): Promise<void> {
  const trimmed = subcommand.trim();

  if (trimmed === "slack") return handleSetupSlack(ctx);
  if (trimmed === "discord") return handleSetupDiscord(ctx);
  if (trimmed === "status") return handleRemoteStatus(ctx);
  if (trimmed === "disconnect") return handleDisconnect(ctx);

  return handleRemoteMenu(ctx);
}

async function handleSetupSlack(ctx: ExtensionCommandContext): Promise<void> {
  const token = await promptMaskedInput(ctx, "Slack Bot Token", "Paste your xoxb-... token");
  if (!token) return void ctx.ui.notify("Slack setup cancelled.", "info");
  if (!token.startsWith("xoxb-")) return void ctx.ui.notify("Invalid token format — Slack bot tokens start with xoxb-.", "warning");

  ctx.ui.notify("Validating token...", "info");
  const auth = await fetchJson("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${token}` } });
  if (!auth?.ok) return void ctx.ui.notify("Token validation failed — check the token and app install.", "error");

  const channels = await listSlackChannels(token);
  const MANUAL_OPTION = "Enter channel ID manually";
  let channelId: string;

  if (!channels || channels.length === 0) {
    ctx.ui.notify("Could not list Slack channels — falling back to manual entry.", "warning");
    channelId = await promptSlackChannelId(ctx) ?? "";
  } else {
    const channelOptions = [...channels.map((channel) => channel.label), MANUAL_OPTION];
    const selectedChannel = await ctx.ui.select("Select a Slack channel", channelOptions);
    if (!selectedChannel) return void ctx.ui.notify("Slack setup cancelled.", "info");

    if (selectedChannel === MANUAL_OPTION) {
      channelId = await promptSlackChannelId(ctx) ?? "";
    } else {
      const chosen = channels.find((channel) => channel.label === selectedChannel);
      if (!chosen) return void ctx.ui.notify("Slack setup cancelled.", "info");
      channelId = chosen.id;
    }
  }

  if (!channelId) return void ctx.ui.notify("Slack setup cancelled.", "info");

  const send = await fetchJson("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channelId, text: "GSD remote questions connected." }),
  });
  if (!send?.ok) return void ctx.ui.notify(`Could not send to channel: ${send?.error ?? "unknown error"}`, "error");

  saveProviderToken("slack_bot", token);
  process.env.SLACK_BOT_TOKEN = token;
  saveRemoteQuestionsConfig("slack", channelId);
  ctx.ui.notify(`Slack connected — remote questions enabled for channel ${channelId}.`, "info");
}

async function handleSetupDiscord(ctx: ExtensionCommandContext): Promise<void> {
  const token = await promptMaskedInput(ctx, "Discord Bot Token", "Paste your bot token");
  if (!token) return void ctx.ui.notify("Discord setup cancelled.", "info");

  ctx.ui.notify("Validating token...", "info");
  const headers = { Authorization: `Bot ${token}` };
  const auth = await fetchJson("https://discord.com/api/v10/users/@me", { headers });
  if (!auth?.id) return void ctx.ui.notify("Token validation failed — check the bot token.", "error");

  // Fetch guilds the bot is a member of
  const guilds: Array<{ id: string; name: string }> | null = await fetchJson("https://discord.com/api/v10/users/@me/guilds", { headers });
  if (!Array.isArray(guilds) || guilds.length === 0) {
    return void ctx.ui.notify("Bot is not in any Discord servers.", "error");
  }

  let guildId: string;
  let guildName: string;
  if (guilds.length === 1) {
    guildId = guilds[0].id;
    guildName = guilds[0].name;
  } else {
    const guildOptions = guilds.map((g) => g.name);
    const selectedGuild = await ctx.ui.select("Select a Discord server", guildOptions);
    if (!selectedGuild) return void ctx.ui.notify("Discord setup cancelled.", "info");
    const chosen = guilds.find((g) => g.name === selectedGuild);
    if (!chosen) return void ctx.ui.notify("Discord setup cancelled.", "info");
    guildId = chosen.id;
    guildName = chosen.name;
  }

  // Fetch text and announcement channels in the selected guild
  ctx.ui.notify(`Fetching channels for ${guildName}...`, "info");
  const allChannels: Array<{ id: string; name: string; type: number }> | null = await fetchJson(
    `https://discord.com/api/v10/guilds/${guildId}/channels`,
    { headers },
  );
  const textChannels = Array.isArray(allChannels)
    ? allChannels.filter((ch) => ch.type === 0 || ch.type === 5)
    : [];

  const MANUAL_OPTION = "Enter channel ID manually";
  let channelId: string;

  if (textChannels.length === 0) {
    ctx.ui.notify("No text channels found — falling back to manual entry.", "warning");
    const manualId = await promptInput(ctx, "Channel ID", "Paste the Discord channel ID (e.g. 1234567890123456789)");
    if (!manualId) return void ctx.ui.notify("Discord setup cancelled.", "info");
    if (!isValidChannelId("discord", manualId)) return void ctx.ui.notify("Invalid Discord channel ID format — expected 17-20 digit numeric ID.", "error");
    channelId = manualId;
  } else {
    const channelOptions = [...textChannels.map((ch) => `#${ch.name}`), MANUAL_OPTION];
    const selectedChannel = await ctx.ui.select("Select a channel", channelOptions);
    if (!selectedChannel) return void ctx.ui.notify("Discord setup cancelled.", "info");

    if (selectedChannel === MANUAL_OPTION) {
      const manualId = await promptInput(ctx, "Channel ID", "Paste the Discord channel ID (e.g. 1234567890123456789)");
      if (!manualId) return void ctx.ui.notify("Discord setup cancelled.", "info");
      if (!isValidChannelId("discord", manualId)) return void ctx.ui.notify("Invalid Discord channel ID format — expected 17-20 digit numeric ID.", "error");
      channelId = manualId;
    } else {
      const chosenChannel = textChannels.find((ch) => `#${ch.name}` === selectedChannel);
      if (!chosenChannel) return void ctx.ui.notify("Discord setup cancelled.", "info");
      channelId = chosenChannel.id;
    }
  }

  const sendResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "GSD remote questions connected." }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!sendResponse.ok) {
    const body = await sendResponse.text().catch(() => "");
    return void ctx.ui.notify(`Could not send to channel (HTTP ${sendResponse.status}): ${sanitizeError(body).slice(0, 200)}`, "error");
  }

  saveProviderToken("discord_bot", token);
  process.env.DISCORD_BOT_TOKEN = token;
  saveRemoteQuestionsConfig("discord", channelId);
  ctx.ui.notify(`Discord connected — remote questions enabled for channel ${channelId}.`, "info");
}

async function handleRemoteStatus(ctx: ExtensionCommandContext): Promise<void> {
  const status = getRemoteConfigStatus();
  const config = resolveRemoteConfig();
  if (!config) {
    ctx.ui.notify(status, status.includes("disabled") ? "warning" : "info");
    return;
  }

  const latestPrompt = getLatestPromptSummary();
  const lines = [status];
  if (latestPrompt) {
    lines.push(`Last prompt: ${latestPrompt.id}`);
    lines.push(`  status: ${latestPrompt.status}`);
    if (latestPrompt.updatedAt) lines.push(`  updated: ${new Date(latestPrompt.updatedAt).toLocaleString()}`);
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleDisconnect(ctx: ExtensionCommandContext): Promise<void> {
  const prefs = loadEffectiveGSDPreferences();
  const channel = prefs?.preferences.remote_questions?.channel;
  if (!channel) return void ctx.ui.notify("No remote channel configured — nothing to disconnect.", "info");

  removeRemoteQuestionsConfig();
  removeProviderToken(channel === "slack" ? "slack_bot" : "discord_bot");
  if (channel === "slack") delete process.env.SLACK_BOT_TOKEN;
  if (channel === "discord") delete process.env.DISCORD_BOT_TOKEN;
  ctx.ui.notify(`Remote questions disconnected (${channel}).`, "info");
}

async function handleRemoteMenu(ctx: ExtensionCommandContext): Promise<void> {
  const config = resolveRemoteConfig();
  const latestPrompt = getLatestPromptSummary();
  const lines = config
    ? [
        `Remote questions: ${config.channel} configured`,
        `  Timeout: ${config.timeoutMs / 60000}m, poll: ${config.pollIntervalMs / 1000}s`,
        latestPrompt ? `  Last prompt: ${latestPrompt.id} (${latestPrompt.status})` : "  No remote prompts recorded yet",
        "",
        "Commands:",
        "  /gsd remote status",
        "  /gsd remote disconnect",
        "  /gsd remote slack",
        "  /gsd remote discord",
      ]
    : [
        "No remote question channel configured.",
        "",
        "Commands:",
        "  /gsd remote slack",
        "  /gsd remote discord",
        "  /gsd remote status",
      ];

  ctx.ui.notify(lines.join("\n"), "info");
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return await response.json();
  } catch {
    return null;
  }
}

async function listSlackChannels(token: string): Promise<Array<{ id: string; label: string }> | null> {
  const headers = { Authorization: `Bearer ${token}` };
  const channels: Array<{ id: string; label: string; name: string }> = [];
  let cursor = "";

  do {
    const params = new URLSearchParams({
      exclude_archived: "true",
      limit: "200",
      types: "public_channel,private_channel",
    });
    if (cursor) params.set("cursor", cursor);

    const response = await fetchJson(`https://slack.com/api/users.conversations?${params.toString()}`, { headers });
    if (!response?.ok || !Array.isArray(response.channels)) {
      return channels.length > 0 ? channels.map(({ id, label }) => ({ id, label })) : null;
    }

    for (const channel of response.channels as Array<{ id?: string; name?: string; is_private?: boolean }>) {
      if (!channel.id || !channel.name) continue;
      channels.push({
        id: channel.id,
        name: channel.name,
        label: channel.is_private ? `[private] ${channel.name}` : `#${channel.name}`,
      });
    }

    cursor = typeof response.response_metadata?.next_cursor === "string"
      ? response.response_metadata.next_cursor
      : "";
  } while (cursor);

  channels.sort((a, b) => a.name.localeCompare(b.name));
  return channels.map(({ id, label }) => ({ id, label }));
}

async function promptSlackChannelId(ctx: ExtensionCommandContext): Promise<string | null> {
  const channelId = await promptInput(ctx, "Channel ID", "Paste the Slack channel ID (e.g. C0123456789)");
  if (!channelId) return null;
  if (!isValidChannelId("slack", channelId)) {
    ctx.ui.notify("Invalid Slack channel ID format — expected 9-12 uppercase alphanumeric characters.", "error");
    return null;
  }
  return channelId;
}

function getAuthStorage(): AuthStorage {
  const authPath = join(process.env.HOME ?? "", ".gsd", "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true });
  return AuthStorage.create(authPath);
}

function saveProviderToken(provider: string, token: string): void {
  const auth = getAuthStorage();
  auth.set(provider, { type: "api_key", key: token });
}

function removeProviderToken(provider: string): void {
  const auth = getAuthStorage();
  auth.set(provider, { type: "api_key", key: "" });
}

export function saveRemoteQuestionsConfig(channel: "slack" | "discord", channelId: string): void {
  const prefsPath = getGlobalGSDPreferencesPath();
  const block = [
    "remote_questions:",
    `  channel: ${channel}`,
    `  channel_id: \"${channelId}\"`,
    "  timeout_minutes: 5",
    "  poll_interval_seconds: 5",
  ].join("\n");

  const content = existsSync(prefsPath) ? readFileSync(prefsPath, "utf-8") : "";
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let next = content;

  if (fmMatch) {
    let frontmatter = fmMatch[1];
    const regex = /remote_questions:[\s\S]*?(?=\n[a-zA-Z_]|\n---|$)/;
    frontmatter = regex.test(frontmatter) ? frontmatter.replace(regex, block) : `${frontmatter.trimEnd()}\n${block}`;
    next = `---\n${frontmatter}\n---${content.slice(fmMatch[0].length)}`;
  } else {
    next = `---\n${block}\n---\n\n${content}`;
  }

  mkdirSync(dirname(prefsPath), { recursive: true });
  writeFileSync(prefsPath, next, "utf-8");
}

function removeRemoteQuestionsConfig(): void {
  const prefsPath = getGlobalGSDPreferencesPath();
  if (!existsSync(prefsPath)) return;
  const content = readFileSync(prefsPath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;
  const frontmatter = fmMatch[1].replace(/remote_questions:[\s\S]*?(?=\n[a-zA-Z_]|\n---|$)/, "").trim();
  const next = frontmatter ? `---\n${frontmatter}\n---${content.slice(fmMatch[0].length)}` : content.slice(fmMatch[0].length).replace(/^\n+/, "");
  writeFileSync(prefsPath, next, "utf-8");
}

function maskEditorLine(line: string): string {
  let output = "";
  let i = 0;
  while (i < line.length) {
    if (line.startsWith(CURSOR_MARKER, i)) {
      output += CURSOR_MARKER;
      i += CURSOR_MARKER.length;
      continue;
    }
    const ansiMatch = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (ansiMatch) {
      output += ansiMatch[0];
      i += ansiMatch[0].length;
      continue;
    }
    output += line[i] === " " ? " " : "*";
    i += 1;
  }
  return output;
}

async function promptMaskedInput(ctx: ExtensionCommandContext, label: string, hint: string): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (r: string | null) => void) => {
    let cachedLines: string[] | undefined;
    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    const refresh = () => { cachedLines = undefined; tui.requestRender(); };
    const handleInput = (data: string) => {
      if (matchesKey(data, Key.enter)) return done(editor.getText().trim() || null);
      if (matchesKey(data, Key.escape)) return done(null);
      editor.handleInput(data); refresh();
    };
    const render = (width: number) => {
      if (cachedLines) return cachedLines;
      const lines: string[] = [];
      const add = (s: string) => lines.push(truncateToWidth(s, width));
      add(theme.fg("accent", "─".repeat(width)));
      add(theme.fg("accent", theme.bold(` ${label}`)));
      add(theme.fg("muted", `  ${hint}`));
      lines.push("");
      add(theme.fg("muted", " Enter value:"));
      for (const line of editor.render(width - 2)) add(theme.fg("text", maskEditorLine(line)));
      lines.push("");
      add(theme.fg("dim", " enter to confirm  |  esc to cancel"));
      add(theme.fg("accent", "─".repeat(width)));
      cachedLines = lines;
      return lines;
    };
    return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
  });
}

async function promptInput(ctx: ExtensionCommandContext, label: string, hint: string): Promise<string | null> {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (r: string | null) => void) => {
    let cachedLines: string[] | undefined;
    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    const refresh = () => { cachedLines = undefined; tui.requestRender(); };
    const handleInput = (data: string) => {
      if (matchesKey(data, Key.enter)) return done(editor.getText().trim() || null);
      if (matchesKey(data, Key.escape)) return done(null);
      editor.handleInput(data); refresh();
    };
    const render = (width: number) => {
      if (cachedLines) return cachedLines;
      const lines: string[] = [];
      const add = (s: string) => lines.push(truncateToWidth(s, width));
      add(theme.fg("accent", "─".repeat(width)));
      add(theme.fg("accent", theme.bold(` ${label}`)));
      add(theme.fg("muted", `  ${hint}`));
      lines.push("");
      add(theme.fg("muted", " Enter value:"));
      for (const line of editor.render(width - 2)) add(theme.fg("text", line));
      lines.push("");
      add(theme.fg("dim", " enter to confirm  |  esc to cancel"));
      add(theme.fg("accent", "─".repeat(width)));
      cachedLines = lines;
      return lines;
    };
    return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
  });
}
