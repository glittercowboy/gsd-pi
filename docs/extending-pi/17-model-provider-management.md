# Model & Provider Management


### Switching Models

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await pi.setModel(model);
  if (!success) ctx.ui.notify("No API key for this model", "error");
}
```

### Registering Custom Providers

```typescript
pi.registerProvider("my-proxy", {
  baseUrl: "https://proxy.example.com",
  apiKey: "PROXY_API_KEY",  // Env var name or literal
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    }
  ],
  // Optional: OAuth support for /login
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) { /* ... */ },
    async refreshToken(credentials) { /* ... */ },
    getApiKey(credentials) { return credentials.access; },
  },
});

// Override just the baseUrl for an existing provider
pi.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com",
});

// Remove a provider
pi.unregisterProvider("my-proxy");
```

### Reacting to Model Changes

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model — new model
  // event.previousModel — previous model (undefined if first)
  // event.source — "set" | "cycle" | "restore"
  ctx.ui.setStatus("model", `${event.model.provider}/${event.model.id}`);
});
```

---
