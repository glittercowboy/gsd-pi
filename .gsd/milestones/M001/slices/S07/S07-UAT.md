# S07: End-to-end web assembly proof — UAT

**Milestone:** M001
**Written:** 2026-03-15

## UAT Type

- UAT mode: mixed
- Why this mode is sufficient: Automation now proves the assembled route/runtime contracts, mock-free integrated views, and packaged host build. The remaining risk is live human experience: no-TUI launch, current-project attachment, visible workflow controls, focused-panel interruptions, continuity after refresh, and the subjective “snappy and fast” bar.

## Preconditions

- Run from a real project with `.gsd/` artifacts available (this repo is suitable).
- A browser can open local loopback URLs on the test machine.
- For the onboarding case, use a disposable `HOME` or otherwise isolate auth state so the test does not disturb your normal credentials.
- Have one obviously invalid API key string for the failure path and one real valid provider key for the success path.
- No visible Pi/GSD TUI should already be open.

## Smoke Test

From the project root, run `gsd --web` with already-valid auth. **Expected:** the browser auto-opens the current project workspace, no TUI window appears, and the shell shows live current-project state rather than a generic launcher.

## Test Cases

### 1. Fresh onboarding gates the workspace and unlocks after a successful retry

1. Launch from a disposable home so onboarding starts locked, for example: `TMP_HOME=$(mktemp -d) && HOME="$TMP_HOME" gsd --web`.
2. Wait for the browser workspace to open.
3. Confirm the workspace is visibly gated/locked and interactive work controls are not yet usable.
4. Enter an obviously invalid API key and submit validation.
5. Confirm the validation error is visible and the workspace remains locked.
6. Enter a real valid API key and submit validation again.
7. **Expected:** the bridge refresh succeeds, the lock clears, and the workspace becomes usable without touching the terminal or opening the TUI.

### 2. Launch opens into the current project and the preserved skin shows real state

1. From the repo root (or another real GSD project), run `gsd --web` with valid auth available.
2. Confirm the browser opens directly into that project’s workspace.
3. Confirm no Pi/GSD TUI window appears at launch.
4. Inspect the main surfaces: dashboard, roadmap, files, activity, and terminal.
5. **Expected:** the project metadata, milestone/slice/task names, `.gsd` file tree, and live bridge/session state all match the current project. No placeholder/mock copy should appear in any integrated surface.

### 3. Start or resume work from visible controls, then handle a focused-panel interruption

1. Use the visible dashboard or sidebar workflow control to start, continue, or resume work. Do not type a hidden `/gsd ...` command in the terminal.
2. In the browser terminal input, send this prompt (or equivalent): `Before making any file change, ask me a single-select question with two filename options for a scratch file under .gsd/tmp/, then use my answer and create the file.`
3. Watch for streaming assistant text and any tool execution status in the workspace while the turn runs.
4. When the focused panel question appears, answer it in the panel.
5. Let the run finish.
6. **Expected:** the workflow starts from the visible UI control, streaming output appears in-browser, the focused panel receives the interruption, your answer is delivered back to the session, and the agent completes the requested file change without TUI fallback.

### 4. Refresh/reopen continuity keeps you attached to the same session

1. After test case 3 completes, refresh the browser tab.
2. Wait for the workspace to reconnect.
3. Confirm the same project/session transcript is still present.
4. Send a follow-up prompt such as `Confirm the scratch file you just created and report its path.`
5. **Expected:** the page reattaches to the existing session, prior transcript state remains visible, and follow-up interaction still works entirely in the browser.

### 5. Browser-visible failure and recovery surfaces remain usable

1. During onboarding, deliberately fail validation once (already covered in test case 1) and confirm the failure is visible in-browser.
2. During normal workspace use, if the error banner or reconnect state appears, use the visible recovery affordance (for example, Retry) rather than the terminal.
3. **Expected:** failures are understandable from the browser UI itself, and the visible recovery control gets the workspace back to a usable state without needing the TUI.

## Edge Cases

### Invalid onboarding attempt does not partially unlock the workspace

1. Start from the disposable-home onboarding flow.
2. Submit an invalid key once.
3. **Expected:** the workspace stays locked, the error is visible, and no prompt/workflow action becomes available until a valid key succeeds.

### Refresh after an interactive turn does not lose transcript or control state

1. Complete test case 3 so there is fresh transcript and an active/resumable session.
2. Refresh the page.
3. **Expected:** transcript history and usable controls return after reconnect; the page does not reset to a blank shell or generic launcher.

## Failure Signals

- A Pi/GSD TUI window opens at any point during `gsd --web` launch.
- The browser does not auto-open into the current project workspace.
- Onboarding can be bypassed without valid required setup.
- Dashboard/roadmap/files/activity surfaces show placeholder data unrelated to the current project.
- Starting or resuming work requires typing hidden terminal commands instead of using visible controls.
- Streaming output, tool activity, or focused-panel questions fail to appear in-browser.
- Refresh/reopen loses the session transcript or breaks follow-up interaction.
- Failures are only understandable/recoverable from the terminal rather than the browser UI.

## Requirements Proved By This UAT

- R004 — Primary GSD workflow runs end-to-end in the browser without opening TUI.
- R009 — Web mode feels snappy and fast in real local use.
- R001 — Browser-only `--web` launch path.
- R002 — Browser onboarding validates required setup and unlocks the workspace entirely in-browser.
- R003 — Web mode opens into the current project/cwd workspace.
- R006 — Agent interruptions are handled in a focused web panel.
- R007 — Session continuity works across refresh/reopen and supports resume inside web mode.
- R010 — Failures are visible and recoverable in-browser.

## Not Proven By This UAT

- R011 — Remaining lower-frequency TUI capabilities reaching browser parity after the primary loop.
- Deferred/non-M001 capabilities such as cross-project launchers, deep historical analytics, or remote/shared access.

## Notes for Tester

- Use a disposable `HOME` for the onboarding test if you do not want to disturb your normal auth state.
- The prompt in test case 3 is intentionally phrased to force a focused-panel question. If the agent skips the question and proceeds without asking, treat that as a real UAT failure for this slice.
- If the browser UI feels correct but only after obvious pauses, laggy streaming, or delayed control recovery, that still fails the R009 bar. This UAT is partly about feel, not just eventual correctness.
