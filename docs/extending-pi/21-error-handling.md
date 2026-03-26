# Error Handling


- **Extension errors** are logged but don't crash pi. The agent continues.
- **`tool_call` handler errors** block the tool (fail-safe behavior).
- **Tool `execute` errors** are reported to the LLM with `isError: true`, allowing it to recover.

---
