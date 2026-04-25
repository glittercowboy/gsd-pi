# Skills

Skills are specialized instruction sets that GSD loads when the task matches. They provide domain-specific guidance — coding patterns, framework idioms, testing strategies, and tool usage.

Skills follow the open [Agent Skills standard](https://agentskills.io/) and work across multiple AI agents, not just GSD.

## Skill Directories

| Location | Scope | Description |
|----------|-------|------------|
| `~/.agents/skills/` | Global | Shared across all projects |
| `.agents/skills/` (project root) | Project | Project-specific, committable to git |

Global skills take precedence when names collide.

## Installing Skills

Skills are installed via the [skills.sh CLI](https://skills.sh):

```bash
# Interactive — choose skills and target agents
npx skills add dpearson2699/swift-ios-skills

# Install specific skills
npx skills add dpearson2699/swift-ios-skills --skill swift-concurrency --skill swiftui-patterns -y

# Install all from a repo
npx skills add dpearson2699/swift-ios-skills --all

# Check for updates
npx skills check

# Update installed skills
npx skills update
```

## Onboarding Catalog

During `gsd init`, GSD detects your project's tech stack and recommends relevant skill packs:

- **Swift** — SwiftUI, Swift Core, concurrency, Charts, Testing
- **iOS** — App Intents, Widgets, StoreKit, MapKit, Core ML, Vision, accessibility
- **Web** — React, React Native, frontend design, accessibility
- **Languages** — Rust, Python, Go patterns and best practices
- **General** — Document handling (PDF, DOCX, XLSX)

## Skill Discovery

The `skill_discovery` preference controls how GSD finds skills during auto mode:

| Mode | Behavior |
|------|----------|
| `auto` | Skills found and applied automatically |
| `suggest` | Skills identified but require confirmation (default) |
| `off` | No skill discovery |

## Skill Preferences

Control which skills are used:

```yaml
always_use_skills:
  - debug-like-expert
prefer_skills:
  - frontend-design
avoid_skills:
  - security-docker
skill_rules:
  - when: task involves authentication
    use: [clerk]
  - when: frontend styling work
    prefer: [frontend-design]
```

## Creating Custom Skills

Create your own skill by adding a directory with a `SKILL.md` file:

```
~/.agents/skills/my-skill/
  SKILL.md           — instructions for the AI
  references/        — optional reference files
```

The `SKILL.md` contains instructions the AI follows when the skill is active.

### Project-Local Skills

Place skills in your project root for project-specific guidance:

```
.agents/skills/my-project-skill/
  SKILL.md
```

Project-local skills can be committed to git so team members share the same skill set.

## Skill Health Dashboard

Track skill performance:

```
/gsd skill-health              # overview table
/gsd skill-health rust-core    # detailed view for one skill
/gsd skill-health --stale 30   # skills unused for 30+ days
/gsd skill-health --declining  # skills with falling success rates
```

The dashboard flags:
- Success rate below 70% over the last 10 uses
- Token usage rising 20%+ compared to previous window
- Skills unused beyond the configured threshold

### Staleness Detection

```yaml
skill_staleness_days: 60   # flag skills unused for 60+ days (0 to disable)
```

Stale skills are excluded from automatic matching but remain available for explicit use.
