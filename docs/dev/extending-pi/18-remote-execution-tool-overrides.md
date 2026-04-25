# Remote Execution & Tool Overrides


### SSH Example Pattern

```typescript
import { createReadTool, createBashTool, createWriteTool } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH target", type: "string" });

  const localBash = createBashTool(process.cwd());

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const sshTarget = pi.getFlag("--ssh");
      if (sshTarget) {
        const remoteBash = createBashTool(process.cwd(), {
          operations: createSSHOperations(sshTarget),
        });
        return remoteBash.execute(id, params, signal, onUpdate);
      }
      return localBash.execute(id, params, signal, onUpdate);
    },
  });
}
```

### Tool Override Pattern (Logging/Access Control)

```typescript
pi.registerTool({
  name: "read",  // Same name = overrides built-in
  label: "Read (Logged)",
  description: "Read file contents with logging",
  parameters: Type.Object({
    path: Type.String(),
    offset: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    console.log(`[AUDIT] Reading: ${params.path}`);
    // Delegate to built-in implementation
    const builtIn = createReadTool(ctx.cwd);
    return builtIn.execute(toolCallId, params, signal, onUpdate);
  },
  // Omit renderCall/renderResult to use built-in renderer automatically
});
```

---
