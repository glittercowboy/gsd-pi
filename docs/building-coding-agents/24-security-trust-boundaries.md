# Security & Trust Boundaries

### Hard Boundaries — Things the Agent Should NEVER Do (Universal Agreement)

| Forbidden Action | Why |
|-----------------|-----|
| Access production systems directly | Agent's world is the dev environment, full stop |
| Access or embed secrets | API keys, credentials should never appear in agent context or output |
| Make network requests to arbitrary destinations | Restrictive firewall, whitelist only required services |
| Modify its own orchestrator, prompts, or tools | Prevents removing safety constraints |
| Execute commands outside the project directory | Sandbox to project dir + temp working dirs only |

### The Sandboxing Architecture

| Layer | Mechanism |
|-------|-----------|
| **Execution** | Containerized (Docker + seccomp), restricted filesystem, network policy |
| **Filesystem** | Content-addressable storage — agent *proposes* changes, backend validates before writing |
| **Secrets** | Vault proxy with short-lived tokens, never direct credentials |
| **Commands** | Parsed and blocked for dangerous patterns (`rm -rf /`, `curl` to unknown hosts) |
| **Dependencies** | Approved dependency list — new deps require auto-approval (pre-approved list) or human approval |

### The Capability-Based Security Model

The orchestrator runs **outside** the sandbox. The agent requests operations through a controlled API. The orchestrator validates every request before executing. The agent doesn't have direct access to anything — it has access to **tools that the orchestrator mediates.**

### The Subtle Risk

The agent introduces vulnerabilities not through malice but through **plausible-looking insecure patterns**: string concatenation for SQL queries, disabling CORS for convenience, logging sensitive data for debugging. Security linting rules should be tuned to catch these **AI-common patterns** specifically.

### The Trust Model

> Think of the agent as a **highly capable but unvetted contractor.** Give them the codebase and dev environment. Don't give them production credentials, deployment access, or the ability to modify security infrastructure. The goal isn't to make the agent safe by limiting capabilities — it's to make the **environment** safe so the agent can be maximally capable within it.

---
