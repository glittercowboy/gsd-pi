# Remote Questions

Remote questions allow GSD to ask for user input and send informational notifications via Slack, Discord, or Telegram when running in headless auto-mode. When GSD encounters a decision point that needs human input, it posts the question to your configured channel and polls for a response. Milestone completions, blockers, budget alerts, and other status events are also routed to the same channel.

## Setup

### Discord

```
/gsd remote discord
```

The setup wizard:
1. Prompts for your Discord bot token
2. Validates the token against the Discord API
3. Lists servers the bot belongs to (or lets you pick)
4. Lists text channels in the selected server
5. Sends a test message to confirm permissions
6. Saves the configuration to `~/.gsd/PREFERENCES.md`

**Bot requirements:**
- A Discord bot application with a token (from [Discord Developer Portal](https://discord.com/developers/applications))
- Bot must be invited to the target server with these permissions:
  - Send Messages
  - Read Message History
  - Add Reactions
  - View Channel
- The `DISCORD_BOT_TOKEN` environment variable must be set (the setup wizard handles this)

### Slack

```
/gsd remote slack
```

The setup wizard:
1. Prompts for your Slack bot token (`xoxb-...`)
2. Validates the token
3. Lists channels the bot can access (with manual ID fallback)
4. Sends a test message to confirm permissions
5. Saves the configuration

**Bot requirements:**
- A Slack app with a bot token (from [Slack API](https://api.slack.com/apps))
- Bot must be invited to the target channel
- Typical scopes for public/private channels: `chat:write`, `reactions:read`, `reactions:write`, `channels:read`, `groups:read`, `channels:history`, `groups:history`

### Telegram

```
/gsd remote telegram
```

The setup wizard:
1. Prompts for your Telegram bot token (from [@BotFather](https://t.me/BotFather))
2. Validates the token against the Telegram API
3. Prompts for the chat ID (group or private chat)
4. Sends a test message to confirm permissions
5. Saves the configuration

**Bot requirements:**
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Bot must be added to the target group chat (or use private chat with the bot)
- The `TELEGRAM_BOT_TOKEN` environment variable must be set

## Configuration

Remote questions are configured in `~/.gsd/PREFERENCES.md`:

```yaml
remote_questions:
  channel: discord          # or slack or telegram
  channel_id: "1234567890123456789"
  timeout_minutes: 5        # 1-30, default 5
  poll_interval_seconds: 5  # 2-30, default 5
```

## How It Works

1. GSD encounters a decision point during auto-mode
2. The question is posted to your configured channel as a rich embed (Discord) or Block Kit message (Slack)
3. GSD polls for a response at the configured interval
4. You respond by:
   - **Reacting** with a number emoji (1️⃣, 2️⃣, etc.) for single-question prompts
   - **Replying** to the message with a number (`1`), comma-separated numbers (`1,3`), or free text
5. GSD picks up the response and continues execution
6. A ✅ reaction is added to the prompt message to confirm receipt

### Response Formats

**Single question:**
- React with a number emoji (single-question prompts)
- Reply with a number: `2`
- Reply with free text (captured as a user note)

**Multiple questions:**
- Reply with semicolons: `1;2;custom text`
- Reply with newlines (one answer per line)

### Timeouts

If no response is received within `timeout_minutes`, the prompt times out and GSD continues with a timeout result. The LLM handles timeouts according to the task context — typically by making a conservative default choice or pausing auto-mode.

## Informational Notifications

In addition to interactive questions, GSD sends informational notifications to your remote channel for significant auto-mode events. These do not require a response — they are delivered alongside desktop notifications.

Events that are sent remotely:

| Event | Description |
|-------|-------------|
| Milestone complete | A milestone finished successfully |
| All milestones done | The entire roadmap is complete |
| Blocker encountered | Auto-mode stopped due to an unresolvable issue |
| Budget alert | Spending is approaching or has reached the configured ceiling |
| Budget ceiling reached | Auto-mode paused because the `budget_ceiling` was exceeded |

Informational notifications are sent whenever `notifications.enabled: true` is set in preferences **and** a remote channel is configured. The same channel that receives interactive questions also receives these status events — no separate configuration is needed.

## Telegram Commands

When Telegram is configured as your remote channel, GSD runs a background polling loop (every ~5 seconds) while auto-mode is active. This allows you to send commands directly to your bot and receive live project status updates in return.

> **Note:** Background command polling is only available for Telegram. Slack and Discord use a webhook-based model and do not support incoming commands from the chat.

### Available Commands

All command responses are prefixed with the project name (e.g., `📁 MyProject`) so you can distinguish responses when running multiple projects.

| Command | Description | Example response |
|---------|-------------|-----------------|
| `/status` | Current milestone, active unit, and session cost | `📁 MyProject — M001: Auth System · Executing S02/T03 · $1.24` |
| `/progress` | Roadmap overview showing completed and open milestones | `📁 MyProject — ✅ M001 Auth · 🔄 M002 Dashboard (active) · ⏳ M003 API` |
| `/budget` | Token usage and cost for the current session | `📁 MyProject — Session: $2.18 · 142k tokens · ceiling: $50.00` |
| `/pause` | Pause auto-mode after the current unit finishes | `📁 MyProject — Pause directive set. Auto-mode will stop after current unit.` |
| `/resume` | Clear a pause directive and continue auto-mode | `📁 MyProject — Pause directive cleared. Auto-mode will continue.` |
| `/log [n]` | Last `n` activity log entries (default: 5) | `📁 MyProject — [10:42] Completed T02 · [10:38] Started T02 · ...` |
| `/help` | List all available commands | `📁 MyProject — Available commands: /status /progress ...` |

### How Background Polling Works

While auto-mode is running, GSD polls the Telegram Bot API every ~5 seconds for new messages sent to the bot. When a command is received, GSD processes it and replies in the same chat.

Polling is active only while auto-mode is running. When auto-mode stops (normally, or via `/pause`), polling stops as well. The next `/gsd auto` resumes polling automatically.

The `/pause` command sets a stop directive that GSD checks at each unit boundary — the current unit always completes before auto-mode halts. `/resume` clears that directive so auto-mode continues without requiring a terminal interaction.

## Commands

| Command | Description |
|---------|-------------|
| `/gsd remote` | Show remote questions menu and current status |
| `/gsd remote slack` | Set up Slack integration |
| `/gsd remote discord` | Set up Discord integration |
| `/gsd remote telegram` | Set up Telegram integration |
| `/gsd remote status` | Show current configuration and last prompt status |
| `/gsd remote disconnect` | Remove remote questions configuration |

## Discord vs Slack Feature Comparison

| Feature | Discord | Slack |
|---------|---------|-------|
| Rich message format | Embeds with fields | Block Kit |
| Reaction-based answers | ✅ (single-question) | ✅ (single-question) |
| Thread-based replies | Message replies | Thread replies |
| Message URL in logs | ✅ | ✅ |
| Answer acknowledgement | ✅ reaction on receipt | ✅ reaction on receipt |
| Multi-question support | Text replies (semicolons/newlines) | Text replies (semicolons/newlines) |
| Context source in prompt | ✅ (footer) | ✅ (context block) |
| Server/channel picker | ✅ (interactive) | ✅ (interactive + manual fallback) |
| Token validation | ✅ | ✅ |
| Test message on setup | ✅ | ✅ |
| Informational notifications | ✅ | ✅ |
| Background command polling | ❌ | ❌ |

Telegram supports all the above plus background command polling (`/status`, `/pause`, `/resume`, etc.).

## Troubleshooting

### "Remote auth failed"
- Verify your bot token is correct and not expired
- For Discord: ensure the bot is still in the server
- For Slack: ensure the bot token starts with `xoxb-`

### "Could not send to channel"
- Verify the bot has Send Messages permission in the target channel
- For Discord: check the bot's role permissions in Server Settings
- For Slack: ensure the bot is invited to the channel (`/invite @botname`)

### No response detected
- Ensure you're **replying to** the prompt message (not posting a new message)
- For reactions: only number emojis (1️⃣-5️⃣) on single-question prompts are detected
- Check that `timeout_minutes` is long enough for your response time

### Channel ID format
- **Slack:** 9-12 uppercase alphanumeric characters (e.g., `C0123456789`)
- **Discord:** 17-20 digit numeric snowflake ID (e.g., `1234567890123456789`)
- Enable Developer Mode in Discord (Settings → Advanced) to copy channel IDs

### Telegram commands not responding
- Confirm auto-mode is actively running — background polling only operates while auto-mode is active
- Verify the bot token in `~/.gsd/PREFERENCES.md` matches the token from [@BotFather](https://t.me/BotFather)
- Ensure the `chat_id` (or `channel_id`) in your configuration matches the chat where you're sending the commands — the bot only responds in its configured chat
- Send `/help` first: if the bot responds, polling is working and the issue may be with a specific command
- Run `/gsd remote status` from your terminal to confirm the Telegram configuration is saved correctly
