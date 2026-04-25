# How GSD Organizes Work

GSD uses a three-level hierarchy to break projects into manageable pieces that an AI can execute reliably.

## The Hierarchy

```
Milestone  →  a shippable version (4-10 slices)
  Slice    →  one demoable vertical feature (1-7 tasks)
    Task   →  one context-window-sized unit of work
```

### Milestones

A milestone is a shippable version of your project — an MVP, a major release, or a feature set that delivers standalone value. Milestones typically contain 4-10 slices.

Examples:
- "MVP with user auth, dashboard, and settings"
- "v2.0 with real-time collaboration and API v2"
- "Security hardening milestone"

### Slices

A slice is one demoable, vertical capability within a milestone. It cuts across layers (database, backend, frontend) to deliver something you could show to a user. Slices contain 1-7 tasks.

Examples:
- "User authentication with JWT"
- "Dashboard layout with charts"
- "API rate limiting"

### Tasks

A task is the smallest unit of work — something that fits in one AI context window. If a task can't be completed in a single AI session, it's broken into smaller tasks.

Examples:
- "Create the User model and migration"
- "Implement JWT middleware"
- "Build the login form component"

## The `.gsd/` Directory

All project state lives on disk in a `.gsd/` directory at your project root:

```
.gsd/
  PROJECT.md          — living description of what the project is
  REQUIREMENTS.md     — requirement contract (active/validated/deferred)
  DECISIONS.md        — append-only architectural decisions log
  KNOWLEDGE.md        — cross-session rules, patterns, and lessons
  RUNTIME.md          — runtime context: API endpoints, env vars, services
  STATE.md            — quick-glance status of current work
  PREFERENCES.md      — project-level preferences (optional)
  milestones/
    M001/
      M001-ROADMAP.md — slice plan with risk levels and dependencies
      M001-CONTEXT.md — scope and goals from discussion phase
      slices/
        S01/
          S01-PLAN.md     — task decomposition for this slice
          S01-SUMMARY.md  — what was built and what changed
          S01-UAT.md      — human test script
          tasks/
            T01-PLAN.md   — detailed plan for this task
            T01-SUMMARY.md — what the task accomplished
```

### Key Files

| File | Purpose |
|------|---------|
| `PROJECT.md` | High-level project description, updated as the project evolves |
| `REQUIREMENTS.md` | Formal requirement contract — tracks what's active, validated, and deferred |
| `DECISIONS.md` | Append-only log of architectural decisions with rationale |
| `KNOWLEDGE.md` | Rules, patterns, and lessons learned across sessions — GSD reads this at the start of every task |
| `RUNTIME.md` | Runtime context like API URLs, ports, and environment variables |
| `STATE.md` | Current status at a glance — auto-generated, don't edit manually |

## How Work Flows

Each slice flows through phases:

```
Plan → Execute (per task) → Complete → Reassess Roadmap → Next Slice
```

1. **Plan** — GSD scouts the codebase, researches relevant docs, and decomposes the slice into tasks with clear requirements
2. **Execute** — Each task runs in a fresh AI session with focused context
3. **Complete** — GSD writes summaries, generates a UAT script, and commits
4. **Reassess** — The roadmap is checked against reality — slices may be reordered, added, or removed
5. **Next Slice** — The loop continues until all slices are done

After all slices complete, a **milestone validation** gate checks that success criteria were actually met before sealing the milestone.

## Adding Knowledge

GSD maintains a knowledge base that persists across sessions. Add rules, patterns, or lessons:

```
/gsd knowledge rule "Always use parameterized queries for database access"
/gsd knowledge pattern "Service classes go in src/services/"
/gsd knowledge lesson "The OAuth flow requires the redirect URL to match exactly"
```

This knowledge is injected into every task prompt automatically.
