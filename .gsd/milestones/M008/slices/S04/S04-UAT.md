# S04: Remote Questions Settings — UAT

**Milestone:** M008
**Written:** 2026-03-18

## UAT Type

- UAT mode: live-runtime
- Why this mode is sufficient: The panel reads/writes real YAML frontmatter in `~/.gsd/preferences.md` and checks real env vars — artifact-only verification cannot confirm the round-trip works.

## Preconditions

- Web mode running: `npm run build:web-host && npm run gsd:web`
- Note the port from startup logs (e.g. `Launching web host on port XXXXX`)
- `~/.gsd/preferences.md` exists (will be created on first POST if absent)
- No `remote_questions` block in `~/.gsd/preferences.md` (or run `curl -X DELETE http://localhost:<port>/api/remote-questions` to clear)

## Smoke Test

Open web mode in the browser, type `/gsd prefs` in the terminal. Scroll down past Budget panel — the "Remote Questions" panel should be visible with an empty state showing "No remote channel configured".

## Test Cases

### 1. Panel renders in settings surface

1. Open `http://localhost:<port>` in a browser
2. Type `/gsd prefs` in the terminal input and press Enter
3. Scroll down the settings surface
4. **Expected:** A "Remote Questions" panel appears below the Budget panel with a Radio or MessageSquare icon, showing "No remote channel configured" when unconfigured

### 2. Save Slack channel config

1. In the Remote Questions panel, select "Slack" from the channel type dropdown
2. Enter `C0123456789` in the Channel ID field
3. Set Timeout to 5 minutes
4. Set Poll Interval to 5 seconds
5. Click Save
6. **Expected:** Success banner appears briefly. Panel now shows current config as key-value entries (channel: slack, channelId: C0123456789, etc.)
7. Open `~/.gsd/preferences.md` in a text editor
8. **Expected:** A `remote_questions` block exists in the YAML frontmatter with `channel: slack`, `channel_id: "C0123456789"`, `timeout_minutes: 5`, `poll_interval_seconds: 5`

### 3. Save Discord channel config

1. Change channel type to "Discord"
2. Enter `123456789012345678` in the Channel ID field (17+ digits)
3. Click Save
4. **Expected:** Config saved, channel type shows "discord", channel ID shows the Discord ID

### 4. Save Telegram channel config

1. Change channel type to "Telegram"
2. Enter `-100123456789` in the Channel ID field
3. Click Save
4. **Expected:** Config saved with telegram channel type

### 5. Disconnect removes config

1. With a config saved (any channel type), click the Disconnect button
2. **Expected:** Panel returns to empty state showing "No remote channel configured"
3. Open `~/.gsd/preferences.md`
4. **Expected:** The `remote_questions` block is removed from YAML frontmatter

### 6. Config persists across page refresh

1. Save a Slack config (channel: slack, channelId: C0123456789)
2. Refresh the browser page (F5 or Cmd+R)
3. Type `/gsd prefs` again
4. Scroll to Remote Questions panel
5. **Expected:** Panel shows the previously saved Slack config — not empty state

### 7. Env var status shows correctly

1. Save a Slack config
2. Check if `SLACK_BOT_TOKEN` is set in the shell environment
3. Look at the env var status in the panel
4. **Expected:** If the token is set, a green checkmark badge shows "SLACK_BOT_TOKEN is set ✓". If not set, a yellow warning badge shows "SLACK_BOT_TOKEN not set — remote questions will not work until the bot token is configured". The actual token value is never displayed.

## Edge Cases

### Invalid Slack channel ID format

1. Select "Slack" as channel type
2. Enter `bad_id` in the Channel ID field
3. Click outside the field (blur) or click Save
4. **Expected:** Inline validation error appears showing the expected pattern (`^[A-Z0-9]{9,12}$`). Save should not succeed — if submitted, API returns 400 with descriptive error.

### Invalid Discord channel ID (too short)

1. Select "Discord" as channel type
2. Enter `12345` in the Channel ID field
3. Tab out of the field
4. **Expected:** Inline validation error showing Discord pattern (`^\d{17,20}$`)

### Timeout boundary values

1. Set timeout to 0 and try to save
2. **Expected:** API clamps to 1 (minimum)
3. Set timeout to 50 and try to save
4. **Expected:** API clamps to 30 (maximum)

### Poll interval boundary values

1. Set poll interval to 1 and try to save
2. **Expected:** API clamps to 2 (minimum)
3. Set poll interval to 60 and try to save
4. **Expected:** API clamps to 30 (maximum)

### Invalid channel type via API

1. `curl -X POST http://localhost:<port>/api/remote-questions -H 'Content-Type: application/json' -d '{"channel":"email","channelId":"test","timeoutMinutes":5,"pollIntervalSeconds":5}'`
2. **Expected:** 400 response: `{ "error": "Invalid channel type: must be one of slack, discord, telegram" }`

### DELETE when nothing is configured

1. Ensure no `remote_questions` block exists in preferences
2. `curl -X DELETE http://localhost:<port>/api/remote-questions`
3. **Expected:** `{ "success": true }` — DELETE is idempotent

## Failure Signals

- "Remote Questions" panel missing from `/gsd prefs` settings surface
- Panel shows spinner indefinitely (API timeout or error)
- Save succeeds in the UI but `~/.gsd/preferences.md` has no `remote_questions` block
- Disconnect removes from UI but block persists in file
- Channel ID validation not shown on blur — user can submit invalid IDs
- Env var status shows the actual token value instead of just a boolean indicator
- `npm run build:web-host` fails with errors in touched files

## Requirements Proved By This UAT

- R118 — Full remote questions configuration lifecycle: view empty state, save config for all three channel types, validate channel IDs, disconnect, persistence across refresh, env var status visibility

## Not Proven By This UAT

- Actual remote question delivery via Slack/Discord/Telegram (bot token integration and message flow are out of scope for this UI settings slice)
- Bot token setup workflow (remains TUI-only via `secure_env_collect`)

## Notes for Tester

- The panel env var status depends on whether `SLACK_BOT_TOKEN` / `DISCORD_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` is actually set in the process environment. Most test environments won't have these set, so expect the "not set" warning state.
- The web server uses a dynamic port — check the startup logs for the actual port number.
- After testing, you can clean up by running `curl -X DELETE http://localhost:<port>/api/remote-questions` to remove test config from `~/.gsd/preferences.md`.
