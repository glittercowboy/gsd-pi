# The Four Modes of Operation

Pi runs in four modes, each serving a different use case:

### Interactive Mode (default)

The full TUI experience. You type prompts, see responses stream, watch tool calls execute, and interact with the agent in real-time. This is how most people use pi day-to-day.

```bash
pi                                    # Start interactive
pi "List all TypeScript files"        # Start with initial prompt
pi -c                                 # Continue last session
pi -r                                 # Browse and resume a session
```

### Print Mode (`-p`)

Non-interactive. Sends a prompt, prints the response, exits. Perfect for scripting and pipelines.

```bash
pi -p "Summarize this codebase"
pi -p @screenshot.png "What's in this image?"
pi -p --tools read,grep "Review the code in src/"
```

### JSON Mode (`--mode json`)

Streams all events as JSON lines to stdout. For building tools that consume pi's output programmatically.

```bash
pi --mode json "Fix the bug in auth.ts"
```

### RPC Mode (`--mode rpc`)

Full bidirectional JSON protocol over stdin/stdout. For embedding pi in IDEs, custom UIs, or other applications. The host sends commands, pi streams events back.

```bash
pi --mode rpc --provider anthropic
```

---
