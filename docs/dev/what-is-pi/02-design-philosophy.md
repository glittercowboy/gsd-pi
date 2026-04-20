# Design Philosophy

Pi has a very specific philosophy that explains almost every architectural decision:

### "Extend, don't fork"

Other coding agents bake features in. If you want sub-agents, plan mode, permission gates, or custom tools, you either use what they built or you fork the project. Pi takes the opposite approach: the core is deliberately minimal, and everything beyond the basics is built through the extension system.

### What Pi ships without (on purpose)

| Feature | Pi's approach |
|---------|--------------|
| Sub-agents | Build with extensions, or install a package |
| Plan mode | Build with extensions, or install a package |
| Permission popups | Build with extensions — design your own security model |
| MCP support | Build with extensions — or use Skills instead |
| Background bash | Use tmux — full observability, direct interaction |
| Built-in todos | They confuse models. Use a TODO.md, or build with extensions |

This isn't missing features — it's a deliberate architectural choice. Every baked-in feature is an opinion that might not match your workflow. Pi gives you the primitives to build exactly what you need.

### The extension system as a first-class citizen

Extensions aren't an afterthought. The entire event system, tool registration, command system, custom UI, and session persistence were designed from the ground up to make extensions as powerful as built-in features. An extension can:
- Override any built-in tool
- Replace the system prompt
- Modify every message sent to the LLM
- Replace the input editor entirely
- Register new model providers
- Control the agent's tool set at runtime

This is the core value proposition: **pi is a platform, not just a tool.**

---
