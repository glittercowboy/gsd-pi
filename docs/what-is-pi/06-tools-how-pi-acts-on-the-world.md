# Tools — How Pi Acts on the World

Tools are functions the LLM can call to interact with your system. The LLM sees tool descriptions in its system prompt and decides when to use them.

### Built-in Tools

Pi ships with 7 built-in tools (4 active by default):

| Tool | Default | What it does |
|------|---------|-------------|
| `read` | ✅ | Read file contents (text and images). Supports offset/limit for large files. Truncates to 2000 lines / 50KB. |
| `bash` | ✅ | Execute shell commands. Returns stdout, stderr, exit code. Truncates to 2000 lines / 50KB. |
| `edit` | ✅ | Surgical text replacement — find exact text and replace it. |
| `write` | ✅ | Create or overwrite files. Auto-creates parent directories. |
| `grep` | ❌ | Search file contents with regex patterns. |
| `find` | ❌ | Find files by name/pattern. |
| `ls` | ❌ | List directory contents. |

### Tool Control

```bash
pi --tools read,bash,edit,write       # Specify active tools (default)
pi --tools read,grep,find,ls          # Read-only exploration
pi --no-tools                         # No built-in tools (extensions only)
```

Extensions can also manage tools at runtime:
```typescript
pi.setActiveTools(["read", "bash"]);   // Switch to read-only + bash
pi.setActiveTools(pi.getAllTools().map(t => t.name));  // Enable all
```

### How Tools Appear to the LLM

The system prompt includes an "Available tools" section listing each active tool with its description and parameter schema. The LLM reads this and decides when to call which tool. This is standard LLM tool-calling — the model outputs a structured tool call, pi executes it, and feeds the result back.

### Output Truncation

**All tools truncate output** to 50KB / 2000 lines (whichever is hit first). This prevents a single tool call from consuming the entire context window. When truncated, the full output is saved to a temp file and the LLM is told where to find it.

---
