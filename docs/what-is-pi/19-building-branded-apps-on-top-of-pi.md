# Building Branded Apps on Top of Pi

This document covers the part that the extension docs, SDK docs, RPC docs, and package docs only imply when read together:

**How do you build your own product on top of pi** so users run **your** app, **your** command, and **your** UI rather than installing and managing pi directly?

Examples:
- a branded CLI like `gsd`
- a desktop app that uses pi as its backend engine
- a web or Electron app that uses pi sessions, tools, and event streaming
- an internal company agent product built on pi primitives

The short answer is:

- **Yes, you can build your own branded app on top of pi**
- **No, end users do not need to install pi globally** if you ship your own app that depends on pi packages
- **No, you do not have to rely on `~/.gsd`** if you embed pi with custom paths and storage
- **Yes, you can bundle your own extensions, prompts, themes, skills, and providers** inside your app

The rest of this document explains the architecture choices, storage choices, packaging strategies, and practical tradeoffs.

---

## 19.1 The Three Ways to Use Pi as a Foundation

There are really three layers you can build on:

1. **`@mariozechner/pi-coding-agent`**
   - Highest-level embedding API
   - Best when you want pi's session system, resource loading, tools, extension model, and coding-agent behaviors
2. **Pi CLI in RPC mode**
   - Best when you want process isolation or language-agnostic integration
3. **`@mariozechner/pi-agent-core`**
   - Lower-level agent loop without the full pi coding-agent shell
   - Best when you want more of the engine than the product surface

For most branded CLI or desktop app use cases, start with **`@mariozechner/pi-coding-agent`**.

### Rule of thumb

- Want your own **CLI/TUI** with pi behavior under the hood -> use **SDK embedding** via `createAgentSession()`
- Want your own app in a **different language** or want a **subprocess boundary** -> use **RPC mode**
- Want a more generic **agent engine** and will build more infrastructure yourself -> use **`@mariozechner/pi-agent-core`**

---

## 19.2 The Biggest Misconception: Pi Does Not Require a Global `pi` Install

If you are building a product on top of pi, your users do **not** need to install `pi` globally with npm.

You can ship your own app that depends on:

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-tui`
- `@mariozechner/pi-web-ui`

That means a branded command like:

```bash
gsd
```

can be **your** executable, backed by pi internals, without asking users to separately install and run `pi`.

### What this means in practice

Instead of telling users:

```bash
npm install -g @mariozechner/pi-coding-agent
pi
```

you can ship:

```bash
npm install -g my-gsd
# or a standalone binary / packaged desktop app

gsd
```

And inside `gsd`, you import pi packages and create your own session, UI, storage, and resource loading behavior.

---

## 19.3 The Second Biggest Misconception: `~/.gsd` Is a Default, Not a Requirement

Pi CLI defaults to `~/.gsd/agent`, but embedded applications are not forced to use it.

When you use `createAgentSession()`, you can control:

- `agentDir`
- `cwd`
- `authStorage`
- `modelRegistry`
- `resourceLoader`
- `sessionManager`
- `settingsManager`

That means your app can store state under:

- `~/.gsd/agent`
- `~/Library/Application Support/GSD`
- `%APPDATA%/GSD`
- an app-local portable directory
- a project-local directory

instead of `~/.gsd`.

### Things you can relocate

- auth and OAuth credentials
- settings
- models config
- sessions
- extensions
- prompt templates
- themes
- AGENTS-style context files

### Important nuance

If you use the default resource loader and default managers, pi behaves like pi:
- standard discovery
- standard config locations
- standard session directories

If you pass custom managers and loaders, pi becomes an engine inside **your** app.

---

## 19.4 Choose an Architecture First

Before writing code, decide which of these architectures you actually want.

### Architecture A: Branded Node CLI or TUI using the SDK

This is the most natural fit for tools like `gsd`.

You create your own executable and call `createAgentSession()` directly.

#### Good for
- a branded terminal tool
- a custom TUI
- internal company coding agents
- a CLI with pi sessions, tools, and extensions under the hood

#### Benefits
- type-safe
- no subprocess management
- easy to customize storage and discovery
- easiest way to remove dependency on `~/.gsd`
- easiest way to bundle built-in resources

#### Typical stack
- `@mariozechner/pi-coding-agent`
- optionally `@mariozechner/pi-tui`
- your own entrypoint and app directories

---

### Architecture B: Branded App + Pi RPC subprocess

Here your app spawns pi as a subprocess and talks to it over JSON lines.

#### Good for
- non-Node host applications
- desktop shells with a strict engine boundary
- process isolation
- integrations where restarting the engine independently is useful

#### Benefits
- language-agnostic
- process isolation
- JSON protocol is explicit and stream-friendly

#### Costs
- you must manage subprocess lifecycle
- some UI features are degraded compared to pi's native TUI
- extension UI works through a request/response sub-protocol, not full TUI embedding

---

### Architecture C: App built on `pi-agent-core` or `pi-web-ui`

This is for cases where you want pi's model and agent infrastructure but not necessarily pi's full coding-agent product surface.

#### Good for
- browser apps
- web chat products
- custom artifact workflows
- custom message types and renderers

#### Benefits
- lower-level control
- more app-specific freedom
- easier fit for non-terminal interfaces

#### Costs
- you build more yourself
- fewer coding-agent-specific conveniences out of the box

---

## 19.5 SDK vs RPC vs Agent-Core

Use this decision table.

| Goal | Best Starting Point |
|------|---------------------|
| Branded CLI like `gsd` | `@mariozechner/pi-coding-agent` SDK |
| Branded TUI with coding tools | `@mariozechner/pi-coding-agent` SDK |
| Desktop app with subprocess boundary | pi RPC mode |
| Non-Node integration | pi RPC mode |
| Browser chat app | `@mariozechner/pi-web-ui` + `@mariozechner/pi-agent-core` |
| Generic agent engine with custom infrastructure | `@mariozechner/pi-agent-core` |
| Want pi sessions/resources/extensions but app-owned directories | `@mariozechner/pi-coding-agent` SDK |

### More detailed tradeoff matrix

| Concern | SDK | RPC | agent-core |
|--------|-----|-----|------------|
| Type safety | Excellent | Weak at protocol boundary | Excellent |
| Process isolation | No | Yes | No |
| Language agnostic | No | Yes | No |
| Full pi session/resource system | Yes | Yes | No |
| App-owned storage | Yes | Partial / external orchestration | Yes |
| Rich custom UI | Strong | Moderate | Strong |
| Uses pi extension ecosystem easily | Yes | Yes | No, not directly |
| Simplest branded CLI path | Yes | No | No |

---

## 19.6 The Recommended Path for a Branded CLI Like `gsd`

If you want users to run:

```bash
gsd
```

and you want it to feel like your product rather than "pi but renamed," the default recommendation is:

1. Build a Node/TypeScript app
2. Depend on `@mariozechner/pi-coding-agent`
3. Create your own executable entrypoint
4. Use `createAgentSession()` directly
5. Set custom directories for config/auth/sessions
6. Bundle your own extensions/prompts/themes/providers
7. Expose only the commands and UX you want

That gives you the best control over:
- branding
- defaults
- storage layout
- startup behavior
- extension loading
- model/provider setup

---

## 19.7 App-Owned Storage Layout

A branded app should usually own its own storage hierarchy.

Example:

```text
~/.gsd/
  agent/
    auth.json
    models.json
    settings.json
    extensions/
    prompts/
    themes/
    skills/
  sessions/
```

Or on macOS:

```text
~/Library/Application Support/GSD/
  agent/
  sessions/
```

### Why this matters

If your product uses `~/.gsd`, then:
- it shares state with the user's pi installation
- branding becomes muddy
- support/debugging becomes more confusing
- product boundaries become less clear

Use app-specific directories unless you intentionally want interoperability with a user's pi environment.

### Minimal example

```typescript
import path from "node:path";
import os from "node:os";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const appRoot = path.join(os.homedir(), ".gsd");
const agentDir = path.join(appRoot, "agent");
const sessionsDir = path.join(appRoot, "sessions");

const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
const settingsManager = SettingsManager.create(process.cwd(), agentDir);
const sessionManager = SessionManager.create(process.cwd(), sessionsDir);

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir,
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
});
```

This is the core pattern for “my app uses pi, but not as global pi.”

---

## 19.8 Bundling Resources Inside Your App

This is another place where people often assume they must rely on discovery from `~/.gsd` or `.gsd/`.

You do not.

Your app can bundle:
- extensions
- prompts
- themes
- skills
- AGENTS-style context
- provider registrations

inside your own package or app bundle.

### Strategy 1: Use custom paths with `DefaultResourceLoader`

```typescript
import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  additionalExtensionPaths: [
    "/absolute/path/to/bundled/extension.ts",
  ],
});

await loader.reload();
```

### Strategy 2: Use inline extension factories

```typescript
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  extensionFactories: [
    (pi) => {
      pi.registerCommand("hello", {
        description: "My branded command",
        handler: async (_args, ctx) => ctx.ui.notify("Hello from GSD", "info"),
      });
    },
  ],
});
```

### Strategy 3: Override discovered resources entirely

```typescript
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  systemPromptOverride: () => "You are GSD, a specialized software delivery agent.",
});
```

### Why this matters

For a branded product, it is often better to think in terms of:
- **bundled built-ins shipped by your app**
- optional plugin support later

rather than:
- user-managed global pi resources first

---

## 19.9 Discovery vs Bundling

These are different product strategies.

### Discovery-driven product
You intentionally load from:
- `~/.gsd/agent/...`
- `.gsd/...`
- installed pi packages

#### Good when
- your product is basically pi with additions
- you want compatibility with existing pi user workflows

### Bundled-app product
You intentionally ship your own resources and avoid implicit user-level discovery.

#### Good when
- you want strong branding
- you want predictable behavior
- you want supportability and reproducibility
- you do not want random user extensions affecting behavior

### Recommendation
For a branded tool like `gsd`, default to **bundled-app product** behavior.

If you later add plugin support, make it explicit.

---

## 19.10 Using Pi Packages Internally vs Externally

Pi packages are a sharing mechanism for extensions, prompts, skills, and themes.

But when you are building your own app, there are two separate questions:

1. **Should your app itself be distributed as a pi package?**
2. **Should your app internally use pi-package-style resource organization?**

### Usually, for a branded app:
- **No** on #1
- **Maybe** on #2

If your users run your app directly, your app is usually a normal Node package, binary, or desktop app, not a pi package.

But internally, you may still organize resources in a pi-friendly structure:

```text
src/
resources/
  extensions/
  prompts/
  themes/
  skills/
```

and load them through your resource loader.

### When pi packages still matter
Pi packages are still useful when:
- you want optional add-ons
- you want to reuse existing pi ecosystem resources
- you want third parties to extend your app through pi-compatible bundles

---

## 19.11 RPC Mode for Branded Apps

RPC mode is the right answer when your product wants pi as a subprocess engine.

Start it with:

```bash
pi --mode rpc
```

or programmatically by calling `runRpcMode(session)` in your own Node process.

### RPC is good for
- non-Node clients
- desktop shells in other runtimes
- separate engine process architecture
- explicit JSON protocol boundaries

### What RPC gives you
- prompt / steer / follow_up / abort
- model selection
- state inspection
- session operations
- bash execution
- event streaming
- extension UI request/response protocol

### Important limitation
RPC is not the same thing as embedding pi's full native TUI.

Some extension UI methods degrade in RPC mode.

#### Dialogs still work
- `select`
- `confirm`
- `input`
- `editor`

#### Fire-and-forget UI signals still work
- notifications
- status
- widgets
- title
- editor text setting

#### Some richer TUI behaviors do not map cleanly
- full `custom()` component workflows
- some footer/header/editor replacement behavior
- some theme-specific TUI behavior

If your branded app needs a deeply custom UI, SDK embedding or direct app-level UI integration is usually better.

---

## 19.12 Extension UI in RPC Mode

One subtle but important point: **extensions with user interaction are still possible in RPC mode**, but through a protocol, not by directly rendering pi TUI components.

The client receives `extension_ui_request` messages and must answer with `extension_ui_response` for blocking dialogs.

This means you can build your own frontend and still support many extension-driven workflows.

### But know the boundary
RPC mode supports:
- interaction patterns
- not full TUI component identity

If your extension assumes pi's exact terminal UI surface, it may need adaptation.

---

## 19.13 Web and Browser Apps

If your app is a web app or browser-hosted UI, look closely at:

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-web-ui`

`pi-web-ui` already provides:
- chat UI
- session storage
- provider key storage
- attachments
- artifacts
- model selection
- settings dialogs
- renderers and tool renderers

This is effectively a starter kit for a branded web app using pi-related primitives.

### Use pi-web-ui when
- you want a browser or Electron-friendly UI surface
- you want a ready-made chat shell
- you do not specifically want pi's TUI

### Use pi-coding-agent SDK when
- you want coding-agent-specific resource loading, sessions, extensions, and coding tool behaviors
- your app is terminal-first or Node-first

---

## 19.14 Branding Boundaries: What Still Feels Like Pi?

This matters if you are building a white-labeled or branded product.

### If you spawn the pi CLI directly
Your product is closer to “pi as a subprocess.”
That is fine, but many pi-level assumptions remain nearby.

### If you embed `@mariozechner/pi-coding-agent`
You can hide most pi branding and product surface decisions.
You keep the coding-agent infrastructure but own the app UX.

### If you use `@mariozechner/pi-agent-core`
You are even lower-level. Pi becomes more of a library source than a user-visible product.

### Practical recommendation
If branding matters, do not treat the pi CLI binary as your product surface unless you truly want pi semantics exposed.

Use the SDK or lower-level packages and build your own interface.

---

## 19.15 Session Strategy for a Branded App

Decide whether your app wants:

- **persistent sessions** with app-owned storage
- **ephemeral sessions** only
- **project-local sessions**
- **branching session history** exposed to users

### Persistent app-owned sessions
Most natural for a CLI or desktop app.

```typescript
const sessionManager = SessionManager.create(process.cwd(), sessionsDir);
```

### Ephemeral mode
Useful for task-runner or automation workflows.

```typescript
const sessionManager = SessionManager.inMemory();
```

### Important question
Do you want your app to share session files with pi itself?

Usually the answer should be **no** unless interoperability is an explicit feature.

---

## 19.16 Settings Strategy for a Branded App

You should decide whether settings are:

- file-backed
- in-memory
- app-global
- project-local
- user-editable
- controlled only by your product UI

### App-owned settings

```typescript
const settingsManager = SettingsManager.create(projectCwd, agentDir);
```

with `agentDir` pointing into your app-owned config directory.

### Fully controlled settings

```typescript
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: true },
  retry: { enabled: true, maxRetries: 2 },
});
```

Use in-memory settings when you want the host app to own the config model entirely.

---

## 19.17 Provider and Auth Strategy

A branded app should decide whether users:
- bring their own API keys
- use OAuth through pi provider support
- connect to your proxy/backend
- use your own registered providers

### App-owned auth paths
Use custom `AuthStorage` paths.

```typescript
const authStorage = AuthStorage.create("/path/to/gsd/auth.json");
```

### App-owned model config
Use your own `models.json` location or register providers dynamically.

```typescript
const modelRegistry = new ModelRegistry(authStorage, "/path/to/gsd/models.json");
```

### Custom provider strategy
If your app talks to a proxy or company backend, register providers from your app or bundled extensions.

That keeps the app experience aligned with your branding and infrastructure.

---

## 19.18 Building a Branded `gsd` CLI: Recommended Shape

A practical architecture looks like this:

```text
my-gsd/
  package.json
  src/
    cli.ts
    app-paths.ts
    session.ts
    resource-loader.ts
    ui/
  resources/
    extensions/
    prompts/
    themes/
    skills/
```

### In `cli.ts`
- parse your app flags
- compute app directories
- create auth/model/settings/session managers
- create resource loader
- create agent session
- run your own mode (custom TUI, print mode, or RPC bridge)

### In `resource-loader.ts`
- load bundled resources
- optionally disable ambient pi discovery
- add your branded system prompt and context files

### In bundled extensions
- add your commands
- register your custom tools
- control your app-specific behaviors

---

## 19.19 Minimal SDK Skeleton for a Branded CLI

```typescript
import path from "node:path";
import os from "node:os";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const appRoot = path.join(os.homedir(), ".gsd");
const agentDir = path.join(appRoot, "agent");
const sessionsDir = path.join(appRoot, "sessions");

const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
const settingsManager = SettingsManager.create(process.cwd(), agentDir);
const sessionManager = SessionManager.create(process.cwd(), sessionsDir);

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager,
  systemPromptOverride: () =>
    "You are GSD, a branded software delivery agent. Prefer project-specific workflows and terminology.",
  additionalExtensionPaths: [
    path.resolve("resources/extensions/index.ts"),
  ],
});

await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir,
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
  resourceLoader,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Help me understand this repo.");
```

This is not yet a full product, but it is the correct starting shape for one.

---

## 19.20 When to Reuse Pi's Interactive Mode

The SDK exports `InteractiveMode`, `runPrintMode`, and `runRpcMode`.

These are useful if you want to reuse existing pi surfaces while changing the surrounding setup.

### Reuse `InteractiveMode` when
- you want pi's TUI mostly intact
- but with app-owned storage, extensions, defaults, and resources

### Do not reuse it when
- you want a strongly branded UI
- you want different commands or layout metaphors
- you want your app to feel fundamentally different from pi

For a white-labeled product, `InteractiveMode` is a good prototyping step, not always the final product surface.

---

## 19.21 What to Avoid in a Branded Product

### Avoid accidental dependence on ambient user state
If your app silently loads from a user's `~/.gsd`, you may get:
- surprising extensions
- strange prompts
- odd themes
- hard-to-debug behavior differences

### Avoid mixing branding and storage casually
If your app is called `gsd`, but state lives in `~/.gsd`, users will notice.

### Avoid choosing RPC just because it sounds generic
If your app is already Node/TypeScript, SDK embedding is usually simpler and more powerful.

### Avoid exposing every pi concept unless you want to
A branded product should choose what the user sees.
You do not need to expose:
- all slash commands
- all extension loading paths
- all package concepts
- all theme/customization behaviors

---

## 19.22 Suggested Product Postures

### Posture A: “Pi-compatible branded shell”
- Uses pi concepts openly
- Supports pi packages and pi-style discovery
- Good for power users

### Posture B: “Branded app powered by pi”
- Uses pi internally
- App-owned directories and resources
- Explicit plugins only
- Good for productized tools like `gsd`

### Posture C: “Custom agent product using pi primitives”
- Uses `pi-agent-core` or selective libraries
- Pi itself is mostly invisible
- Good for SaaS or browser products

For most branded command-line products, posture **B** is the best fit.

---

## 19.23 Recommended Documentation Reading Order for This Use Case

If you are building a branded app on top of pi, read in this order:

1. `what-is-pi/14-the-sdk-rpc-embedding-pi.md`
2. this file
3. `extending-pi/19-packaging-distribution.md`
4. `extending-pi/04-extension-locations-discovery.md`
5. `extending-pi/05-extension-structure-styles.md`
6. `extending-pi/12-custom-ui-visual-components.md`
7. `pi-ui-tui/01-the-ui-architecture.md`
8. `pi-ui-tui/03-entry-points-how-ui-gets-on-screen.md`
9. `pi-ui-tui/22-quick-reference-all-ui-apis.md`

Then read the source package docs for exact API details:
- `packages/coding-agent/docs/sdk.md`
- `packages/coding-agent/docs/rpc.md`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/docs/packages.md`
- `packages/web-ui/README.md`

---

## 19.24 Bottom Line

If your goal is:

> “I want users to download and run `gsd`, and have it use pi internally without requiring a separate pi install or `~/.gsd` setup.”

Then the answer is:

- **Yes, that is a supported architecture**
- **Use the SDK first unless you have a strong reason to choose RPC**
- **Use app-owned storage directories**
- **Bundle your own resources instead of relying on global discovery**
- **Use pi packages as an ecosystem mechanism, not as a requirement for your app's internal structure**
- **Treat pi as a foundation layer, not necessarily the product surface**

That is the difference between:
- “using pi as a user tool”
- and “building your own product on top of pi.”
