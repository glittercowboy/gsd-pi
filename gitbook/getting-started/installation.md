# Installation

## Install GSD

```bash
npm install -g gsd-pi
```

Requires **Node.js 22.0.0 or later** (24 LTS recommended) and **Git**.

{% hint style="info" %}
**`command not found: gsd`?** Your shell may not have npm's global bin directory in `$PATH`. Run `npm prefix -g` to find it, then add `$(npm prefix -g)/bin` to your PATH. See [Troubleshooting](../reference/troubleshooting.md) for details.
{% endhint %}

GSD checks for updates once every 24 hours. When a new version is available, you'll see a prompt at startup with the option to update immediately or skip. You can also update from within a session with `/gsd update`.

## Set Up Your LLM Provider

Launch GSD for the first time:

```bash
gsd
```

The setup wizard walks you through:

1. **LLM Provider** — choose from 20+ providers (Anthropic, OpenAI, Google, OpenRouter, GitHub Copilot, Amazon Bedrock, Azure, and more). OAuth flows handle Claude Max and Copilot subscriptions automatically; otherwise paste an API key.
2. **Tool API Keys** (optional) — Brave Search, Context7, Jina, Slack, Discord. Press Enter to skip any.

Re-run the wizard anytime with:

```bash
gsd config
```

For detailed provider setup, see [Provider Setup](../configuration/providers.md).

## Set Up API Keys for Tools

If you use a non-Anthropic model, you may need a search API key for web search. Run `/gsd config` inside any GSD session to set keys globally — they're saved to `~/.gsd/agent/auth.json` and apply to all projects.

| Tool | Purpose | Get a Key |
|------|---------|-----------|
| Tavily Search | Web search for non-Anthropic models | [tavily.com](https://tavily.com/app/api-keys) |
| Brave Search | Web search for non-Anthropic models | [brave.com](https://brave.com/search/api) |
| Context7 Docs | Library documentation lookup | [context7.com](https://context7.com/dashboard) |

Anthropic models have built-in web search and don't need these keys.

## VS Code Extension

GSD is also available as a VS Code extension. Install from the marketplace (publisher: FluxLabs) or search for "GSD" in VS Code extensions.

The extension provides:

- **`@gsd` chat participant** — talk to the agent in VS Code Chat
- **Sidebar dashboard** — connection status, model info, token usage, quick actions
- **Full command palette** — start/stop agent, switch models, export sessions

The CLI (`gsd-pi`) must be installed first — the extension connects to it via RPC.

## Web Interface

GSD also has a browser-based interface:

```bash
gsd --web
```

This starts a local web server with a visual dashboard, real-time progress, and multi-project support. See [Web Interface](../features/web-interface.md) for details.

## Alternative Binary Name

If the `gsd` command conflicts with another tool (e.g., the oh-my-zsh git plugin aliases `gsd` to `git svn dcommit`), use the alternative:

```bash
gsd-cli
```

Both `gsd` and `gsd-cli` point to the same binary. To remove the conflict permanently, add this to your `~/.zshrc`:

```bash
unalias gsd 2>/dev/null
```
