# Getting Started with GSD

GSD is an AI coding agent that handles planning, execution, verification, and shipping so you can focus on what to build. This guide walks you through installation on macOS, Windows, and Linux, then gets you running your first session.

---

## Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **[Node.js](https://nodejs.org/)** | 22.0.0 | 24 LTS |
| **[Git](https://git-scm.com/)** | 2.20+ | Latest |
| **LLM API key** | Any supported provider | Anthropic (Claude) |

Don't have Node.js or Git yet? Follow the OS-specific instructions below.

---

## Install by Operating System

### macOS

> **Downloads:** [Node.js](https://nodejs.org/) | [Git](https://git-scm.com/download/mac) | [Homebrew](https://brew.sh/)

**Step 1 — Install Homebrew** (skip if you already have it):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**Step 2 — Install Node.js and Git:**

```bash
brew install node git
```

**Step 3 — Verify dependencies are installed:**

```bash
node --version   # should print v22.x or higher
git --version    # should print 2.20+
```

**Step 4 — Install GSD:**

```bash
npm install -g gsd-pi
```

**Step 5 — Set up your LLM provider:**

```bash
# Option A: Set an environment variable (Anthropic recommended)
export ANTHROPIC_API_KEY="sk-ant-..."

# Option B: Use the built-in config wizard
gsd config
```

To persist the key, add the export line to `~/.zshrc`:

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

See [Provider Setup Guide](./providers.md) for all 20+ supported providers.

**Step 6 — Launch GSD:**

```bash
cd ~/my-project   # navigate to any project
gsd               # start a session
```

**Step 7 — Verify everything works:**

```bash
gsd --version     # prints the installed version
```

Inside the session, type `/model` to confirm your LLM is connected.

> **Apple Silicon PATH fix:** If `gsd` isn't found after install, npm's global bin may not be in your PATH:
> ```bash
> echo 'export PATH="$(npm prefix -g)/bin:$PATH"' >> ~/.zshrc
> source ~/.zshrc
> ```

> **oh-my-zsh conflict:** The oh-my-zsh git plugin defines `alias gsd='git svn dcommit'`. Fix with `unalias gsd 2>/dev/null` in `~/.zshrc`, or use `gsd-cli` instead.

---

### Windows

> **Downloads:** [Node.js](https://nodejs.org/) | [Git for Windows](https://git-scm.com/download/win) | [Windows Terminal](https://aka.ms/terminal)

#### Option A: winget (recommended for Windows 10/11)

**Step 1 — Install Node.js and Git:**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

**Step 2 — Restart your terminal** (close and reopen PowerShell or Windows Terminal).

**Step 3 — Verify dependencies are installed:**

```powershell
node --version   # should print v22.x or higher
git --version    # should print 2.20+
```

**Step 4 — Install GSD:**

```powershell
npm install -g gsd-pi
```

**Step 5 — Set up your LLM provider:**

```powershell
# Option A: Set an environment variable (current session)
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# Option B: Use the built-in config wizard
gsd config
```

To persist the key permanently, add it via System Settings > Environment Variables, or run:

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "sk-ant-...", "User")
```

See [Provider Setup Guide](./providers.md) for all 20+ supported providers.

**Step 6 — Launch GSD:**

```powershell
cd C:\Users\you\my-project   # navigate to any project
gsd                           # start a session
```

**Step 7 — Verify everything works:**

```powershell
gsd --version     # prints the installed version
```

Inside the session, type `/model` to confirm your LLM is connected.

#### Option B: Manual install

1. Download and install [Node.js LTS](https://nodejs.org/) — check **"Add to PATH"** during setup
2. Download and install [Git for Windows](https://git-scm.com/download/win) — use default options
3. Open a **new** terminal, then follow Steps 3-7 above

> **Windows tips:**
> - Use **Windows Terminal** or **PowerShell** for the best experience. Command Prompt works but has limited color support.
> - If `gsd` isn't recognized, restart your terminal. Windows needs a fresh terminal to pick up new PATH entries.
> - **WSL2** also works — install WSL, then follow the Linux instructions inside your distro.

---

### Linux

> **Downloads:** [Node.js](https://nodejs.org/) | [Git](https://git-scm.com/download/linux) | [nvm](https://github.com/nvm-sh/nvm)

Pick your distro, then follow the steps.

#### Ubuntu / Debian

**Step 1 — Install Node.js and Git:**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

#### Fedora / RHEL / CentOS

**Step 1 — Install Node.js and Git:**

```bash
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs git
```

#### Arch Linux

**Step 1 — Install Node.js and Git:**

```bash
sudo pacman -S nodejs npm git
```

#### Using nvm (any distro)

**Step 1 — Install nvm, then Node.js:**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc   # or ~/.zshrc
nvm install 24
nvm use 24
```

#### All distros: Steps 2-7

**Step 2 — Verify dependencies are installed:**

```bash
node --version   # should print v22.x or higher
git --version    # should print 2.20+
```

**Step 3 — Install GSD:**

```bash
npm install -g gsd-pi
```

**Step 4 — Set up your LLM provider:**

```bash
# Option A: Set an environment variable (Anthropic recommended)
export ANTHROPIC_API_KEY="sk-ant-..."

# Option B: Use the built-in config wizard
gsd config
```

To persist the key, add the export line to `~/.bashrc` (or `~/.zshrc`):

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

See [Provider Setup Guide](./providers.md) for all 20+ supported providers.

**Step 5 — Launch GSD:**

```bash
cd ~/my-project   # navigate to any project
gsd               # start a session
```

**Step 6 — Verify everything works:**

```bash
gsd --version     # prints the installed version
```

Inside the session, type `/model` to confirm your LLM is connected.

> **Permission errors on `npm install -g`?** Don't use `sudo npm`. Fix npm's global directory instead:
> ```bash
> mkdir -p ~/.npm-global
> npm config set prefix '~/.npm-global'
> echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
> source ~/.bashrc
> npm install -g gsd-pi
> ```

---

### Docker (any OS)

> **Downloads:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

Run GSD in an isolated sandbox without installing Node.js on your host.

**Step 1 — Install Docker Desktop** (4.58+ required).

**Step 2 — Clone the GSD repo:**

```bash
git clone https://github.com/gsd-build/gsd-2.git
cd gsd-2/docker
```

**Step 3 — Create and enter a sandbox:**

```bash
docker sandbox create --template . --name gsd-sandbox
docker sandbox exec -it gsd-sandbox bash
```

**Step 4 — Set your API key and run GSD:**

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
gsd auto "implement the feature described in issue #42"
```

See [Docker Sandbox docs](../../docker/README.md) for full configuration, resource limits, and compose files.

---

## After Installation

### Choose a Model

GSD auto-selects a default model after provider setup. Switch anytime inside a session:

```
/model
```

Or configure per-phase models in preferences — see [Configuration](./configuration.md).

---

## Two Ways to Work

### Step Mode — `/gsd`

Type `/gsd` inside a session. GSD executes one unit of work at a time, pausing between each with a wizard showing what completed and what's next.

- **No `.gsd/` directory** — starts a discussion flow to capture your project vision
- **Milestone exists, no roadmap** — discuss or research the milestone
- **Roadmap exists, slices pending** — plan the next slice or execute a task
- **Mid-task** — resume where you left off

Step mode keeps you in the loop, reviewing output between each step.

### Auto Mode — `/gsd auto`

Type `/gsd auto` and walk away. GSD autonomously researches, plans, executes, verifies, commits, and advances through every slice until the milestone is complete.

```
/gsd auto
```

See [Auto Mode](./auto-mode.md) for full details.

---

## Recommended Workflow: Two Terminals

Run auto mode in one terminal, steer from another.

**Terminal 1 — let it build:**

```bash
gsd
/gsd auto
```

**Terminal 2 — steer while it works:**

```bash
gsd
/gsd discuss    # talk through architecture decisions
/gsd status     # check progress
/gsd queue      # queue the next milestone
```

Both terminals read and write the same `.gsd/` files. Decisions in terminal 2 are picked up at the next phase boundary automatically.

---

## How GSD Organizes Work

```
Milestone  →  a shippable version (4-10 slices)
  Slice    →  one demoable vertical capability (1-7 tasks)
    Task   →  one context-window-sized unit of work
```

The iron rule: **a task must fit in one context window.** If it can't, it's two tasks.

All state lives on disk in `.gsd/`:

```
.gsd/
  PROJECT.md          — what the project is right now
  REQUIREMENTS.md     — requirement contract
  DECISIONS.md        — append-only architectural decisions
  KNOWLEDGE.md        — cross-session rules and patterns
  STATE.md            — quick-glance status
  milestones/
    M001/
      M001-ROADMAP.md — slice plan with dependencies
      slices/
        S01/
          S01-PLAN.md     — task decomposition
          S01-SUMMARY.md  — what happened
```

---

## VS Code Extension

GSD is also available as a VS Code extension. Install from the marketplace (publisher: FluxLabs) or search for "GSD" in VS Code extensions:

- **`@gsd` chat participant** — talk to the agent in VS Code Chat
- **Sidebar dashboard** — connection status, model info, token usage
- **Full command palette** — start/stop agent, switch models, export sessions

The CLI (`gsd-pi`) must be installed first — the extension connects to it via RPC.

---

## Web Interface

GSD has a browser-based interface for visual project management:

```bash
gsd --web
```

See [Web Interface](./web-interface.md) for details.

---

## Resume a Session

```bash
gsd --continue    # or gsd -c
```

Resumes the most recent session for the current directory.

Browse all saved sessions:

```bash
gsd sessions
```

---

## Updating GSD

GSD checks for updates every 24 hours and prompts at startup. You can also update manually:

```bash
npm update -g gsd-pi
```

Or from within a session:

```
/gsd update
```

---

## Quick Troubleshooting

| Problem | Fix |
|---------|-----|
| `command not found: gsd` | Add npm global bin to PATH (see OS-specific notes above) |
| `gsd` runs `git svn dcommit` | oh-my-zsh conflict — `unalias gsd` or use `gsd-cli` |
| Permission errors on `npm install -g` | Fix npm prefix (see Linux notes) or use nvm |
| Can't connect to LLM | Check API key with `gsd config`, verify network access |
| `gsd` hangs on start | Check Node.js version: `node --version` (need 22+) |

For more, see [Troubleshooting](./troubleshooting.md).

---

## Next Steps

- [Auto Mode](./auto-mode.md) — deep dive into autonomous execution
- [Configuration](./configuration.md) — model selection, timeouts, budgets
- [Commands Reference](./commands.md) — all commands and shortcuts
- [Provider Setup](./providers.md) — detailed setup for every provider
- [Working in Teams](./working-in-teams.md) — multi-developer workflows
