---
name: agent-browser
description: Browser automation CLI for AI agents. Use when the user needs to interact with websites, including navigating pages, filling forms, clicking buttons, taking screenshots, extracting data, testing web apps, or automating any browser task. Triggers include requests to "open a website", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction.
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*)
---

# Browser Automation with agent-browser

## Core Workflow

Every browser automation follows this pattern:

1. **Navigate**: `agent-browser open <url>`
2. **Snapshot**: `agent-browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Command Chaining

Chain with `&&` in a single shell call. The browser persists via a background daemon.

```bash
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser snapshot -i
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "password123" && agent-browser click @e3
```

**When to chain:** Use `&&` when you don't need intermediate output. Run separately when you need to parse output first (e.g., snapshot to discover refs).

## Essential Commands

```bash
# Navigation
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser close                   # Close browser

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser snapshot -i -C          # Include cursor-interactive elements (divs with onclick, cursor:pointer)
agent-browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element
agent-browser click @e1 --new-tab     # Click and open in new tab
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser press Enter             # Press key
agent-browser keyboard type "text"    # Type at current focus (no selector)
agent-browser keyboard inserttext "text"  # Insert without key events
agent-browser scroll down 500         # Scroll page
agent-browser scroll down 500 --selector "div.content"  # Scroll within a specific container

# Get information
agent-browser get text @e1            # Get element text
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait --load networkidle # Wait for network idle
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait 2000               # Wait milliseconds

# Downloads
agent-browser download @e1 ./file.pdf          # Click element to trigger download
agent-browser wait --download ./output.zip     # Wait for any download to complete
agent-browser --download-path ./downloads open <url>  # Set default download directory

# Capture
agent-browser screenshot              # Screenshot to temp dir
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Annotated screenshot with numbered element labels
agent-browser pdf output.pdf          # Save as PDF

# Diff (compare page states)
agent-browser diff snapshot                          # Compare current vs last snapshot
agent-browser diff snapshot --baseline before.txt    # Compare current vs saved file
agent-browser diff screenshot --baseline before.png  # Visual pixel diff
agent-browser diff url <url1> <url2>                 # Compare two pages
agent-browser diff url <url1> <url2> --wait-until networkidle  # Custom wait strategy
agent-browser diff url <url1> <url2> --selector "#main"  # Scope to element
```

## Common Patterns

### Authentication

**Auth Vault** (recommended -- LLM never sees password):
```bash
echo "pass" | agent-browser auth save github --url https://github.com/login --username user --password-stdin
agent-browser auth login github
agent-browser auth list | auth show <name> | auth delete <name>
```

**State Persistence** (login once, reuse):
```bash
# After manual login flow: save state, reload later
agent-browser state save auth.json
agent-browser state load auth.json
```

**Session Persistence** (auto-save/restore cookies and localStorage):
```bash
agent-browser --session-name myapp open https://app.example.com/login
# ... login flow ... close ... next time state auto-loads:
agent-browser --session-name myapp open https://app.example.com/dashboard
```

Encrypt state at rest: `export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)`
Manage states: `state list`, `state show <name>`, `state clear <name>`, `state clean --older-than 7`

### Data Extraction

```bash
agent-browser get text @e5              # Specific element
agent-browser get text body > page.txt  # Full page text
agent-browser snapshot -i --json        # JSON output for parsing
```

### Parallel Sessions

```bash
agent-browser --session site1 open https://site-a.com
agent-browser --session site2 open https://site-b.com
agent-browser session list
```

### Connect to Existing Chrome

```bash
agent-browser --auto-connect open https://example.com   # Auto-discover
agent-browser --cdp 9222 snapshot                        # Explicit CDP port
```

### Color Scheme

`agent-browser --color-scheme dark open <url>` or `AGENT_BROWSER_COLOR_SCHEME=dark` or `agent-browser set media dark`

### Visual Browser (Debugging)

```bash
agent-browser --headed open https://example.com   # Or AGENT_BROWSER_HEADED=1
agent-browser highlight @e1                        # Highlight element
agent-browser record start demo.webm              # Record session
agent-browser profiler start                       # Start DevTools profiling
agent-browser profiler stop trace.json             # Stop and save
```

### Local Files

```bash
agent-browser --allow-file-access open file:///path/to/document.pdf
```

### iOS Simulator (Mobile Safari)

```bash
agent-browser device list                                    # List simulators
agent-browser -p ios --device "iPhone 16 Pro" open <url>    # Launch Safari
agent-browser -p ios snapshot -i | tap @e1 | fill @e2 "text" | swipe up | screenshot mobile.png
agent-browser -p ios close                                   # Shuts down simulator
```

**Requirements:** macOS with Xcode, Appium (`npm install -g appium && appium driver install xcuitest`). Real devices: `--device "<UDID>"` from `xcrun xctrace list devices`.

## Security

All security features are opt-in. No restrictions by default.

- **Content Boundaries**: `export AGENT_BROWSER_CONTENT_BOUNDARIES=1` -- wraps page output in nonce-tagged markers to help LLMs distinguish tool output from untrusted content
- **Domain Allowlist**: `export AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com"` -- restricts navigation, sub-resources, WebSocket, EventSource. Wildcards match bare domain too. Include CDN domains.
- **Action Policy**: `export AGENT_BROWSER_ACTION_POLICY=./policy.json` -- e.g. `{"default":"deny","allow":["navigate","snapshot","click","scroll","wait","get"]}`. Auth vault ops bypass policy; domain allowlist still applies.
- **Output Limits**: `export AGENT_BROWSER_MAX_OUTPUT=50000` -- prevents context flooding

## Diffing (Verifying Changes)

```bash
agent-browser snapshot -i              # Baseline
agent-browser click @e2                # Action
agent-browser diff snapshot            # See what changed (+ additions, - removals)
```

For visual regression: `agent-browser diff screenshot --baseline baseline.png` or `agent-browser diff url <staging> <prod> --screenshot`

## Timeouts and Slow Pages

Default timeout: 25s (override: `AGENT_BROWSER_DEFAULT_TIMEOUT` in ms). For slow pages use explicit waits:

- `wait --load networkidle` -- wait for network to settle (best for slow pages)
- `wait "#content"` or `wait @e1` -- wait for specific element
- `wait --url "**/dashboard"` -- wait for URL pattern after redirects
- `wait --fn "document.readyState === 'complete'"` -- JS condition
- `wait 5000` -- fixed duration (last resort)

## Session Management and Cleanup

Use named sessions for concurrent agents: `--session agent1`, `--session agent2`. Always `agent-browser close` when done to avoid leaked processes. Use `agent-browser session list` to check active sessions.

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after clicking links/buttons that navigate, form submissions, or dynamic content loading (dropdowns, modals).

## Annotated Screenshots (Vision Mode)

`agent-browser screenshot --annotate` overlays numbered labels `[N]` mapping to refs `@eN`, and caches refs for immediate interaction. Use when: unlabeled icon buttons, visual layout verification, canvas/chart elements, spatial reasoning needed.

## Semantic Locators (Alternative to Refs)

```bash
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find role button click --name "Submit"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

## JavaScript Evaluation (eval)

**Shell quoting can corrupt complex expressions** -- use `--stdin` or `-b` to avoid issues.

```bash
agent-browser eval 'document.title'                           # Simple: single quotes OK
agent-browser eval --stdin <<'EVALEOF'                        # Complex: heredoc (recommended)
JSON.stringify(Array.from(document.querySelectorAll("img")).filter(i => !i.alt).map(i => i.src))
EVALEOF
agent-browser eval -b "$(echo -n 'expr' | base64)"           # Programmatic: base64
```

**Rules:** Single-line no nested quotes -> single quotes. Nested quotes/arrows/multiline -> `--stdin <<'EVALEOF'`. Generated scripts -> `-b` with base64.

## Configuration File

Create `agent-browser.json` in project root. Priority (low to high): `~/.agent-browser/config.json` < `./agent-browser.json` < env vars < CLI flags. Use `--config <path>` or `AGENT_BROWSER_CONFIG` for custom path. All CLI options map to camelCase keys (e.g., `--executable-path` -> `"executablePath"`).

## Deep-Dive Documentation

| Reference | When to Use |
|-----------|-------------|
| [references/commands.md](references/commands.md) | Full command reference with all options |
| [references/snapshot-refs.md](references/snapshot-refs.md) | Ref lifecycle, invalidation rules, troubleshooting |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md) | Login flows, OAuth, 2FA handling, state reuse |
| [references/video-recording.md](references/video-recording.md) | Recording workflows for debugging and documentation |
| [references/profiling.md](references/profiling.md) | Chrome DevTools profiling for performance analysis |
| [references/proxy-support.md](references/proxy-support.md) | Proxy configuration, geo-testing, rotating proxies |

## Experimental: Native Mode

Opt-in Rust daemon communicating with Chrome via CDP, bypassing Node.js/Playwright.

```bash
agent-browser --native open example.com    # Or AGENT_BROWSER_NATIVE=1
```

Supports Chromium and Safari (via WebDriver). All core commands work identically. Use `agent-browser close` before switching between native and default mode.
