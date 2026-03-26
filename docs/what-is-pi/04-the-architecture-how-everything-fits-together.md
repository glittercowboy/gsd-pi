# The Architecture — How Everything Fits Together

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Pi Runtime                                    │
│                                                                         │
│  ┌─────────────────┐     ┌─────────────────┐     ┌──────────────────┐  │
│  │  Model Registry  │     │  Auth Storage    │     │  Settings        │  │
│  │  (all providers) │     │  (API keys,      │     │  (global +       │  │
│  │                  │     │   OAuth tokens)  │     │   project)       │  │
│  └────────┬─────────┘     └────────┬────────┘     └────────┬─────────┘  │
│           │                        │                        │            │
│  ┌────────▼────────────────────────▼────────────────────────▼─────────┐ │
│  │                        Agent Session                               │ │
│  │                                                                    │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │ │
│  │  │ Session       │  │ Agent Loop   │  │ Tool Executor            │ │ │
│  │  │ Manager       │  │              │  │                          │ │ │
│  │  │ ┌───────────┐ │  │ user prompt  │  │ read │ bash │ edit │    │ │ │
│  │  │ │ JSONL Tree│ │  │    ↓         │  │ write│ grep │ find │    │ │ │
│  │  │ │ (entries, │ │  │ LLM call     │  │ ls   │ custom tools │   │ │ │
│  │  │ │ branches) │ │  │    ↓         │  │                          │ │ │
│  │  │ └───────────┘ │  │ tool calls   │  └──────────────────────────┘ │ │
│  │  │               │  │    ↓         │                               │ │
│  │  │ Compaction    │  │ tool results │                               │ │
│  │  │ Engine        │  │    ↓         │                               │ │
│  │  │               │  │ (loop until  │                               │ │
│  │  │ Branch        │  │  LLM stops)  │                               │ │
│  │  │ Summarizer    │  │              │                               │ │
│  │  └──────────────┘  └──────────────┘                               │ │
│  │                                                                    │ │
│  │  ┌──────────────────────────────────────────────────────────────┐  │ │
│  │  │                    Event System                              │  │ │
│  │  │  session_start → input → before_agent_start → agent_start   │  │ │
│  │  │  → turn_start → context → tool_call → tool_result →        │  │ │
│  │  │  turn_end → agent_end → session_shutdown                    │  │ │
│  │  └──────────────────────────┬───────────────────────────────────┘  │ │
│  │                             │                                      │ │
│  └─────────────────────────────┼──────────────────────────────────────┘ │
│                                │                                        │
│  ┌─────────────────────────────▼───────────────────────────────────────┐│
│  │                      Extension Runtime                              ││
│  │  Extension A    Extension B    Extension C    ...                   ││
│  │  (tools, cmds,  (event gates,  (custom UI,                         ││
│  │   events)        tool mods)     providers)                         ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                    Resource Loader                                  ││
│  │  Skills │ Prompt Templates │ Themes │ Context Files (AGENTS.md)    ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                    Mode Layer (TUI / RPC / JSON / Print)            ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### The key subsystems:

| Subsystem | What it does |
|-----------|-------------|
| **Model Registry** | Tracks all available models across all providers, handles API key lookup |
| **Auth Storage** | Stores API keys and OAuth tokens securely |
| **Agent Session** | The main orchestrator — manages the agent loop, session, tools, and events |
| **Session Manager** | Reads/writes JSONL session files, manages the entry tree, handles branching |
| **Agent Loop** | The core cycle: send messages to LLM → execute tool calls → repeat until LLM stops |
| **Tool Executor** | Runs tools (built-in and custom) with cancellation support |
| **Compaction Engine** | Summarizes old messages when context gets too large |
| **Event System** | Every action emits events that extensions can observe and modify |
| **Extension Runtime** | Loads and manages extensions, routes events, handles tool/command registration |
| **Resource Loader** | Discovers and loads skills, prompts, themes, and context files |
| **Mode Layer** | Handles I/O for the current mode (TUI rendering, RPC protocol, JSON streaming, print) |

---
