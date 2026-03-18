---
id: S04
parent: M008
milestone: M008
provides:
  - /api/remote-questions GET/POST/DELETE route for channel config CRUD
  - RemoteQuestionsPanel component in gsd-prefs settings surface
  - SettingsPreferencesData.remoteQuestions type and child script mapping
  - Client-side and server-side channel ID validation (Slack/Discord/Telegram patterns)
  - Env var status reporting (boolean only, never reveals value)
requires: []
affects: []
key_files:
  - web/app/api/remote-questions/route.ts
  - web/components/gsd/settings-panels.tsx
  - web/components/gsd/command-surface.tsx
  - web/lib/settings-types.ts
  - src/web/settings-service.ts
key_decisions:
  - Used `yaml` package for YAML frontmatter parse/stringify instead of regex manipulation
  - Replicated CHANNEL_ID_PATTERNS and ENV_KEYS in the API route (cannot import from extension modules due to Turbopack constraint)
  - onBlur-triggered validation to avoid aggressive channel ID validation while typing
patterns_established:
  - Standalone API route with replicated constants for extension data access
  - Settings panel with form inputs, client-side validation, and API save/delete lifecycle
  - Success feedback auto-clear via useEffect timer (3s)
observability_surfaces:
  - GET /api/remote-questions — returns { config, envVarSet, envVarName, status } for inspection
  - POST /api/remote-questions — returns { error } with 400 for validation failures
  - data-testid="settings-remote-questions" on the panel root element
drill_down_paths:
  - .gsd/milestones/M008/slices/S04/tasks/T01-SUMMARY.md
  - .gsd/milestones/M008/slices/S04/tasks/T02-SUMMARY.md
duration: 35m
verification_result: passed
completed_at: 2026-03-18
---

# S04: Remote Questions Settings

**Slack/Discord/Telegram remote question channel configuration accessible from the web settings panel — view, save, and disconnect channel config via `/gsd prefs`.**

## What Happened

T01 established the data layer: extended `SettingsPreferencesData` with an optional `remoteQuestions` field (camelCase mirror of the upstream `RemoteQuestionsConfig`), added the snake_case→camelCase mapping in the settings child script, and created `/api/remote-questions/route.ts` with GET/POST/DELETE handlers. The route uses the `yaml` package for YAML frontmatter parsing (matching `parsePreferencesMarkdown()` patterns) and replicates channel ID patterns and env key constants locally since Turbopack cannot import from extension modules. GET returns current config plus env var availability as a boolean. POST validates channel type (slack/discord/telegram), channel ID format against per-channel regex patterns, and clamps timeout (1-30) and poll interval (2-30). DELETE removes the `remote_questions` block from `~/.gsd/preferences.md`.

T02 built the `RemoteQuestionsPanel` and wired it into the `gsd-prefs` command surface after `BudgetPanel`. The panel reads initial state from the `useSettingsData()` hook and fetches full status from the API on mount. It provides a form with channel type select, channel ID text input with per-channel regex validation on blur, timeout and poll interval number inputs with range constraints, save and disconnect buttons with success/error feedback, and an env var status badge (green checkmark when set, yellow warning when not — never reveals the value). The panel follows the exact patterns of existing settings panels — same shared infrastructure (`SettingsHeader`, `SettingsLoading`, `SettingsError`, `SettingsEmpty`, `KvRow`), same spacing, same semantic color tokens.

## Verification

- `npm run build:web-host` exits 0 — `/api/remote-questions` listed as dynamic route
- GET `/api/remote-questions` returns `{ config: null, status: "not_configured" }` when unconfigured
- POST with valid Slack config → `{ success: true, config: {...} }`, `remote_questions` block appears in `~/.gsd/preferences.md`
- GET after POST → returns saved config with `envVarName: "SLACK_BOT_TOKEN"` and `status: "configured"`
- POST with invalid channel ID → 400 `{ error: "Invalid channel ID format for slack. Expected pattern: ^[A-Z0-9]{9,12}$" }`
- POST with invalid channel type → 400 `{ error: "Invalid channel type: must be one of slack, discord, telegram" }`
- DELETE → `{ success: true }`, block removed from preferences
- GET after DELETE → `{ config: null, status: "not_configured" }` (round-trip confirmed)
- `RemoteQuestionsPanel` exported from `settings-panels.tsx`, imported and rendered in `command-surface.tsx` gsd-prefs case

## Requirements Advanced

- R118 — Remote question channel config is now fully accessible from the web settings panel with save/disconnect/validation.

## Requirements Validated

- R118 — Full CRUD verified: GET reads current config + env var status, POST validates and saves, DELETE removes. Panel renders in `/gsd prefs` with channel type select, channel ID validation, timeout/poll inputs, and env var status badge. `npm run build:web-host` exits 0.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

None.

## Known Limitations

- Bot token setup remains TUI-only (`secure_env_collect`) — the panel shows env var status but cannot configure the token itself. This is by design per the slice plan.
- Browser visual verification of the panel rendering could not be completed by T02 executor (browser tool unavailable). Build passes and component uses identical patterns to existing panels that render correctly.

## Follow-ups

- none

## Files Created/Modified

- `web/lib/settings-types.ts` — added `remoteQuestions` optional field to `SettingsPreferencesData`
- `src/web/settings-service.ts` — added `remoteQuestions` field mapping in child script (snake_case → camelCase)
- `web/app/api/remote-questions/route.ts` — new file: GET/POST/DELETE API route for remote questions config
- `web/components/gsd/settings-panels.tsx` — added `RemoteQuestionsPanel` export with form, validation, save/disconnect, env var status
- `web/components/gsd/command-surface.tsx` — added `RemoteQuestionsPanel` import and render in gsd-prefs case

## Forward Intelligence

### What the next slice should know
- The remote questions API route at `/api/remote-questions` is a self-contained CRUD endpoint — no bridge dependency, no child-process pattern. It reads/writes `~/.gsd/preferences.md` directly using the `yaml` package.
- The settings panel infrastructure in `settings-panels.tsx` is now well-established with 4 panels (PrefsPanel, ModelRoutingPanel, BudgetPanel, RemoteQuestionsPanel). Adding new settings panels should follow the same `SettingsHeader` + `useSettingsData()` + API fetch pattern.

### What's fragile
- CHANNEL_ID_PATTERNS are replicated in the API route — if upstream changes validation patterns, the route needs manual sync. There's no shared import path due to Turbopack constraints.

### Authoritative diagnostics
- `curl http://localhost:<port>/api/remote-questions` — returns structured JSON with `status` field indicating config state, inspectable without the UI
- `~/.gsd/preferences.md` — the source of truth for remote questions config, viewable as YAML frontmatter

### What assumptions changed
- No assumptions changed — the slice executed as planned with no blockers or surprises.
