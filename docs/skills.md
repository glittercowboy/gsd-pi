# Skills

Skills are specialized instruction sets that GSD loads when the task matches. They provide domain-specific guidance for the LLM — coding patterns, framework idioms, testing strategies, and tool usage.

## Bundled Skills

GSD ships with these skills, installed to `~/.gsd/agent/skills/`:

| Skill | Trigger | Description |
|-------|---------|-------------|
| `frontend-design` | Web UI work — components, pages, dashboards, styling | Production-grade frontend with high design quality |
| `swiftui` | macOS/iOS apps — SwiftUI, Xcode, App Store | Full lifecycle from creation to shipping |
| `debug-like-expert` | Complex debugging — after standard approaches fail | Methodical investigation with evidence gathering |
| `rust-core` | Rust code — ownership, lifetimes, traits, async | Idiomatic, safe, performant Rust patterns |
| `axum-web-framework` | Axum web apps — routing, middleware, extractors | Complete Axum development guide |
| `axum-tests` | Testing Axum apps — integration tests, mock state | Test patterns for Axum applications |
| `tauri` | Tauri v2 desktop apps — setup, plugins, bundling | Cross-platform desktop app development |
| `tauri-ipc-developer` | Tauri IPC — React-Rust type-safe communication | Command scaffolding and serialization |
| `tauri-devtools` | Tauri debugging — CrabNebula DevTools integration | Profiling and monitoring |
| `github-workflows` | GitHub Actions — CI/CD, workflow debugging | Live syntax, run monitoring, failure diagnosis |
| `security-audit` | Security auditing — dependency scanning, OWASP | Comprehensive security assessment |
| `security-review` | Code security review — injection, XSS, auth flaws | Vulnerability-focused code review |
| `security-docker` | Docker security — Dockerfile, runtime hardening | Container security best practices |

## Skill Discovery

The `skill_discovery` preference controls how GSD finds skills during auto mode:

| Mode | Behavior |
|------|----------|
| `auto` | Skills are found and applied automatically |
| `suggest` | Skills are identified but require confirmation (default) |
| `off` | No skill discovery |

## Skill Preferences

Control which skills are used via preferences:

```yaml
---
version: 1
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills:
  - security-docker
skill_rules:
  - when: task involves Clerk authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
---
```

### Resolution Order

Skills can be referenced by:
1. **Bare name** — e.g., `frontend-design` → scans `~/.gsd/agent/skills/` and project skills
2. **Absolute path** — e.g., `/Users/you/.gsd/agent/skills/my-skill/SKILL.md`
3. **Directory path** — e.g., `~/custom-skills/my-skill` → looks for `SKILL.md` inside

User skills (`~/.gsd/agent/skills/`) take precedence over project skills.

## Custom Skills

Create your own skills by adding a directory with a `SKILL.md` file:

```
~/.gsd/agent/skills/my-skill/
  SKILL.md           — instructions for the LLM
  references/        — optional reference files
```

The `SKILL.md` file contains instructions the LLM follows when the skill is active. Reference files can be loaded by the skill instructions as needed.

### Project-Local Skills

Place skills in your project for project-specific guidance:

```
.pi/agent/skills/my-project-skill/
  SKILL.md
```
