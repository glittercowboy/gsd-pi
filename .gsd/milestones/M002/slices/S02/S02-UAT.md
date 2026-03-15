# S02: Browser-native session and settings parity surfaces — UAT

**Milestone:** M002
**Written:** 2026-03-15

## UAT Type

- UAT mode: mixed
- Why this mode is sufficient: S02 is primarily a contract + integration slice, but it also shipped user-visible browser surfaces. A mixed UAT covers both: live browser checks for the new affordances and artifact-driven checks for the lower-level current-project scoping, rename semantics, and shell-signal lifecycles that are easier to prove through targeted tests.

## Preconditions

- The repo is on the S02 implementation state and `npm run build:web-host` has completed successfully.
- Launch the standalone host from the repo root with current-project env wiring:
  1. `GSD_WEB_PACKAGE_ROOT=$PWD GSD_WEB_PROJECT_CWD=$PWD PORT=3000 HOSTNAME=127.0.0.1 node dist/web/standalone/server.js`
- Open `http://127.0.0.1:3000` in a browser.
- Use a project with existing local GSD sessions so the session browser has real data.
- Run the artifact-backed parity suite once before manual exploration:
  1. `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts src/tests/web-command-parity-contract.test.ts src/tests/web-bridge-contract.test.ts src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts src/tests/integration/web-mode-assembled.test.ts`

## Smoke Test

Open the workspace, verify the terminal input and sidebar are visible, click the sidebar Git button, and confirm the shared command surface opens a Git summary instead of doing nothing.

## Test Cases

### 1. Current-project session browser parity (`/resume` + `/name`)

1. In the browser terminal, enter `/resume`.
2. Confirm the shared command surface opens a session browser rather than sending `/resume` to the model.
3. Verify the surface shows current-project session metadata and controls for search, sort mode, and named-only filtering.
4. Search for a known session and switch sort modes between threaded, recent, and relevance.
5. Resume a non-active session from the browser surface.
6. Enter `/name Browser parity check` or use the rename controls in the same surface.
7. **Expected:** The same session-oriented browser surface handles both flows, the resumed session becomes active immediately, and the new name is reflected in visible browser state without needing a full page reload.

### 2. Daily-use settings/auth parity surface

1. Open the shared settings surface using `/settings` or the Settings affordance.
2. Verify the surface contains the existing Model / Thinking / Auth controls plus the S02 sections for Queue, Auto-compaction, and Retry.
3. Change steering mode.
4. Change follow-up mode.
5. Toggle auto-compaction.
6. Toggle auto-retry.
7. If a retry is currently active, verify the abort-retry control is visible.
8. **Expected:** Each mutation updates through a real browser-native control, leaves inspectable success or failure state in the surface, and no control appears inert or browser-local.

### 3. Sidebar Git affordance and shell-state visibility

1. Click the sidebar Git button.
2. Confirm the command surface opens a Git summary card.
3. Verify it shows either:
   - current-project repo data including branch, main branch, and concise file-status counts, or
   - an explicit `not a repo` state if the current project is not inside a Git repo.
4. Run the artifact proof for shell-state rendering:
   - `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-state-surfaces-contract.test.ts src/tests/web-live-interaction-contract.test.ts`
5. **Expected:** The Git sidebar control never behaves like a dead click, and the shell-state tests prove title override rendering, widget placement rendering, blank-title clear behavior, and consume-once editor prefills remain wired.

## Edge Cases

### Rename and repo failure visibility

1. Run `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/web-session-parity-contract.test.ts`
2. Inspect the passing cases for:
   - active-session rename using bridge RPC
   - inactive-session rename using authoritative session-file mutation
   - out-of-scope rename rejection
   - explicit Git `not_repo` handling
3. **Expected:** Failure paths are explicit and inspectable; current-project scoping is enforced; the browser does not silently ignore rename or Git errors.

## Failure Signals

- Typing `/resume` or `/name` sends raw slash text to the model instead of opening the shared session surface.
- Session search/sort/filter controls are missing, or resume and rename behave differently depending on whether the flow started from slash input or a click.
- Queue / Auto-compaction / Retry sections are missing, or a settings control changes visually without bridge-backed state confirming it.
- The sidebar Git button does nothing, or Git failures appear only as console noise with no browser-visible state.
- Title override, widget, or editor-prefill behavior disappears from the browser shell even though the store/event contract still emits those signals.

## Requirements Proved By This UAT

- R011 — proves the S02 portion of browser parity: current-project session browse/resume/rename flows, daily-use settings/auth controls, the Git sidebar surface, and visible title/widget/editor shell state are real browser surfaces rather than inert or terminal-only behavior.

## Not Proven By This UAT

- S03 live freshness, targeted invalidation, and browser-visible recovery diagnostics.
- S04’s full assembled `gsd --web` proof for refresh/reopen/interrupted-run recovery under the real entrypoint.

## Notes for Tester

- Existing non-blocking warnings may still appear during Node-based tests (`MODULE_TYPELESS_PACKAGE_JSON`) and web-host build (`@gsd/native` optional warning path). They are known and not a slice failure if the commands still pass.
- For standalone host smoke, `GSD_WEB_PACKAGE_ROOT=$PWD` matters. Launching the staged host without the launcher-equivalent env can hit pre-existing workspace-loader resolution issues unrelated to S02.
- If the current project is not a Git repo, the correct result is an explicit Git empty/not-a-repo state, not repo metadata.
