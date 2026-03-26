# Context & Hooks — Deep Reference

How context flows through pi, how to intercept and shape it, and advanced patterns for extension authors.

These documents fill gaps between the high-level extending-pi docs and the actual source implementation. Read the extending-pi docs first for fundamentals, then use these for precision work.

## Documents

| # | Document | When to read |
|---|----------|-------------|
| 01 | [The Context Pipeline](01-the-context-pipeline.md) | Understanding the full journey of a user prompt through every transformation stage to the LLM |
| 02 | [Hook Reference](02-hook-reference.md) | Complete behavioral specification of every hook — timing, chaining, return shapes, edge cases |
| 03 | [Context Injection Patterns](03-context-injection-patterns.md) | Practical recipes for injecting, filtering, transforming, and managing context |
| 04 | [Message Types and LLM Visibility](04-message-types-and-llm-visibility.md) | How every message type is converted for the LLM, what it sees, what it doesn't |
| 05 | [Inter-Extension Communication](05-inter-extension-communication.md) | `pi.events`, shared state patterns, and multi-extension coordination |
| 06 | [Advanced Patterns from Source](06-advanced-patterns-from-source.md) | Production patterns extracted from the pi codebase and built-in extensions |
| 07 | [The System Prompt Anatomy](07-the-system-prompt-anatomy.md) | How the system prompt is built, every input source, when it's rebuilt, and every lever to shape it |
