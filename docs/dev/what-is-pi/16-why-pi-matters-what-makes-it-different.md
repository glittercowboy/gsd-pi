# Why Pi Matters — What Makes It Different

### vs. Other Coding Agents

| Aspect | Typical agents | Pi |
|--------|---------------|-----|
| **Customization** | Fork the repo or wait for features | Extension system — build anything without forking |
| **Model lock-in** | One provider, maybe two | 20+ providers, switch mid-conversation |
| **Session management** | Linear history, maybe undo | Tree-based branching with in-place navigation |
| **Context management** | Basic truncation | Structured compaction with summaries, customizable via extensions |
| **Distribution** | No ecosystem | Pi packages via npm/git, shareable extensions/skills/themes |
| **Embedding** | Not designed for it | SDK + RPC mode, built for integration |
| **Philosophy** | Opinionated, batteries-included | Minimal core, extend to your workflow |

### The Core Value Propositions

1. **Extensibility as architecture.** Not an afterthought. The event system, tool registration, command system, and custom UI were designed from day one to make extensions as powerful as built-in features.

2. **Session branching.** Tree-based conversations mean you never lose work. Explore different approaches, keep all of them, jump between them with `/tree`.

3. **Compaction with structure.** When context gets too large, pi summarizes it with a structured format that preserves goals, decisions, and progress. Extensions can customize this entirely.

4. **Multi-model fluidity.** Switch between Claude, GPT, Gemini, or any of 20+ providers mid-conversation. Use the best model for each part of the task.

5. **Progressive disclosure.** Skills load their full instructions only when needed. The system prompt stays lean. Extensions register tools that appear only when active.

6. **Platform, not product.** Pi is infrastructure you build on. Sub-agents, plan mode, permission gates, MCP support, custom workflows — build exactly what you need, share it as a package.

---
