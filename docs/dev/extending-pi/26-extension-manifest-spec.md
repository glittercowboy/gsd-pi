# Extension Manifest Spec


Every directory-based extension can include an `extension-manifest.json` file at its root. The manifest declares what the extension provides, what it depends on, and which tier it belongs to. The registry uses manifests to control enable/disable state, enforce load order, and validate compatibility.

Extensions without manifests still load (backwards compatible), but they cannot be managed through the registry and always load before manifest-bearing extensions.

---

## File Location

```
my-extension/
├── extension-manifest.json   ← manifest lives here
├── index.ts
└── ...
```

The manifest is read from the extension's directory by `readManifest()` in `src/extension-registry.ts`.

---

## Full Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **Yes** | Unique identifier. Must match the directory name. Used as the registry key. |
| `name` | `string` | **Yes** | Human-readable display name. |
| `version` | `string` | **Yes** | Semver version string (e.g. `"1.0.0"`). |
| `description` | `string` | No | One-line summary of what the extension does. |
| `tier` | `"core" \| "bundled" \| "community"` | **Yes** | Controls disable rules and load source. See [Tier Rules](#tier-rules). |
| `requires` | `{ platform: string }` | **Yes** | Compatibility constraints. See [Platform Constraint](#platform-constraint). |
| `provides` | `object` | No | Declares tools, commands, hooks, and shortcuts. See [Provides](#provides). |
| `dependencies` | `object` | No | Extension and runtime dependencies. See [Dependencies](#dependencies). |

### Validation

The `isManifest()` function in `extension-registry.ts` checks:

```typescript
typeof obj.id === "string" &&
typeof obj.name === "string" &&
typeof obj.version === "string" &&
typeof obj.tier === "string"
```

A manifest that fails this check is treated as missing — the extension loads without registry management.

> **Note:** `description` and `requires` are not validated by `isManifest()`, but should always be provided. Future versions may enforce stricter checks.

---

## Tier Rules

| Tier | Ships with GSD | Can be disabled | Load source |
|------|---------------|-----------------|-------------|
| `core` | Yes | **No** — `disableExtension()` returns an error | Built-in `src/resources/extensions/` |
| `bundled` | Yes | Yes | Built-in `src/resources/extensions/` |
| `community` | No | Yes | `~/.gsd/agent/extensions/` or `.gsd/extensions/` |

### Core

Reserved for foundational functionality that GSD cannot operate without. Core extensions cannot be disabled — attempting to disable one returns:

```
Cannot disable "gsd" — it is a core extension.
```

### Bundled

The default tier for new features that ship with GSD. Users can disable bundled extensions via `gsd extensions disable <id>`.

### Community

User-installed extensions loaded from:
- `~/.gsd/agent/extensions/<name>/` — global (all projects)
- `.gsd/extensions/<name>/` — project-local

Community extensions should always use `"tier": "community"` in their manifest.

---

## Platform Constraint

The `requires.platform` field is a semver range constraint checked against the running GSD version.

```json
"requires": { "platform": ">=2.29.0" }
```

If the running GSD version does not satisfy the constraint, the extension will not load.

---

## Provides

The `provides` object declares what capabilities the extension registers at runtime. All arrays are optional.

```json
"provides": {
  "tools": ["resolve_library", "get_library_docs"],
  "commands": ["jobs"],
  "hooks": ["session_start"],
  "shortcuts": ["Ctrl+Alt+G"]
}
```

| Key | Type | Description |
|-----|------|-------------|
| `tools` | `string[]` | Tool names registered via `pi.registerTool()`. These become callable by the LLM. |
| `commands` | `string[]` | Slash commands registered via `pi.registerCommand()`. User-facing (`/jobs`, `/gsd`). |
| `hooks` | `string[]` | Lifecycle hooks the extension listens to (e.g. `session_start`, `session_switch`). |
| `shortcuts` | `string[]` | Keyboard shortcuts the extension binds (e.g. `Ctrl+Alt+G`). |

These declarations are informational for the registry and used for dependency resolution. The actual registration still happens in the extension's `activate()` function.

---

## Dependencies

The `dependencies` object controls load ordering and declares runtime requirements.

```json
"dependencies": {
  "extensions": ["context7", "async-jobs"],
  "runtime": ["node:crypto"]
}
```

| Key | Type | Description |
|-----|------|-------------|
| `extensions` | `string[]` | Extension IDs that must load before this one. Resolved via topological sort. |
| `runtime` | `string[]` | Node.js modules or system features required at runtime. |

### Load Ordering

Extensions are sorted in topological dependency-first order using Kahn's BFS algorithm (`sortExtensionPaths()` in `src/extension-sort.ts`):

- Extensions without manifests are prepended in input order.
- Missing dependencies produce a structured warning but do not block loading.
- Cycles produce warnings; cycle participants are appended alphabetically.
- Self-dependencies are silently ignored.

---

## Registry Relationship

The registry (`registry.json`) tracks enable/disable state separately from manifests. It lives at:

```
<appRoot>/extensions/registry.json
```

### Registry Format

```json
{
  "version": 1,
  "entries": {
    "context7": {
      "id": "context7",
      "enabled": true,
      "source": "bundled"
    },
    "voice": {
      "id": "voice",
      "enabled": false,
      "source": "bundled",
      "disabledAt": "2026-03-15T10:30:00.000Z",
      "disabledReason": "Not needed for this project"
    }
  }
}
```

### How Manifests and Registry Interact

1. On startup, `discoverAllManifests()` scans extension directories for `extension-manifest.json` files.
2. `ensureRegistryEntries()` auto-populates registry entries for newly discovered extensions (enabled by default).
3. `isExtensionEnabled()` checks the registry — missing entries default to **enabled**.
4. Core-tier manifests prevent `disableExtension()` from succeeding.

---

## Complete Examples

### Core — GSD Workflow

```json
{
  "id": "gsd",
  "name": "GSD Workflow",
  "version": "1.0.0",
  "description": "Core GSD workflow engine — milestone planning, execution, and tracking",
  "tier": "core",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "tools": [
      "bash", "write", "read", "edit",
      "gsd_decision_save", "gsd_summary_save",
      "gsd_requirement_update", "gsd_milestone_generate_id"
    ],
    "commands": ["gsd", "kill", "worktree", "exit"],
    "hooks": ["session_start", "session_switch"],
    "shortcuts": ["Ctrl+Alt+G"]
  }
}
```

### Bundled — Context7

```json
{
  "id": "context7",
  "name": "Context7",
  "version": "1.0.0",
  "description": "Fetch up-to-date library documentation and code examples from Context7",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "tools": ["resolve_library", "get_library_docs"],
    "hooks": ["session_start"]
  }
}
```

### Bundled — Async Jobs

```json
{
  "id": "async-jobs",
  "name": "Async Jobs",
  "version": "1.0.0",
  "description": "Run bash commands in the background with job tracking and cancellation",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "tools": ["async_bash", "await_job", "cancel_job"],
    "commands": ["jobs"],
    "hooks": ["session_start"]
  }
}
```

### Bundled — Slash Commands (no tools or hooks)

```json
{
  "id": "slash-commands",
  "name": "Slash Commands",
  "version": "1.0.0",
  "description": "Boilerplate generators for slash commands, extensions, and audit tools",
  "tier": "bundled",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "commands": ["create-slash-command", "create-extension", "audit", "clear"]
  }
}
```

### Community — Minimal Example

```json
{
  "id": "my-custom-tool",
  "name": "My Custom Tool",
  "version": "0.1.0",
  "description": "A custom tool for my workflow",
  "tier": "community",
  "requires": { "platform": ">=2.50.0" },
  "provides": {
    "tools": ["my_tool"]
  },
  "dependencies": {
    "extensions": ["async-jobs"]
  }
}
```

---

## Validation Rules Summary

A manifest is **valid** when:
- `id`, `name`, `version`, and `tier` are all strings
- The file is valid JSON
- The file is named `extension-manifest.json` in the extension's root directory

A manifest is **invalid** (treated as missing) when:
- Any of the four required fields is missing or not a string
- The JSON cannot be parsed
- The file does not exist

Invalid manifests do not prevent the extension from loading — the extension simply loads without registry management, dependency ordering, or tier enforcement.

---
