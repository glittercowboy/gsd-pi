# Skills

Skills are specialized instruction sets that GSD loads when the task matches. They provide domain-specific guidance for the LLM — coding patterns, framework idioms, testing strategies, and tool usage.

Skills follow the open [Agent Skills standard](https://agentskills.io/) and are **not GSD-specific** — they work with Claude Code, OpenAI Codex, Cursor, GitHub Copilot, Windsurf, and 40+ other agents.

## Skill Directories

GSD reads skills from two locations, in priority order:

| Location                          | Scope   | Description                                              |
|-----------------------------------|---------|----------------------------------------------------------|
| `~/.agents/skills/`              | Global  | Shared across all projects and all compatible agents     |
| `.agents/skills/` (project root) | Project | Project-specific skills, committable to version control  |

Global skills take precedence over project skills when names collide.

> **Migration from `~/.gsd/agent/skills/`:** On first launch after upgrading, GSD automatically copies skills from the legacy `~/.gsd/agent/skills/` directory to `~/.agents/skills/`. The old directory is preserved for backward compatibility.

## Installing Skills

Skills are installed via the [skills.sh CLI](https://skills.sh):

```bash
# Interactive — choose skills and target agents
npx skills add dpearson2699/swift-ios-skills

# Install specific skills non-interactively
npx skills add dpearson2699/swift-ios-skills --skill swift-concurrency --skill swiftui-patterns -y

# Install all skills from a repo
npx skills add dpearson2699/swift-ios-skills --all

# Check for updates
npx skills check

# Update installed skills
npx skills update
```

### Onboarding Catalog

During `gsd init`, GSD detects the project's tech stack and recommends relevant skill packs. For brownfield projects, detection is automatic; for greenfield projects, the user picks a tech stack.

The curated catalog is maintained in `src/resources/extensions/gsd/skill-catalog.ts`. Each entry maps a tech stack to a skills.sh repo and specific skill names.

#### Available Skill Packs

**Swift (any Swift project — `Package.swift` or `.xcodeproj` detected):**
- **SwiftUI** — layout, navigation, animations, gestures, Liquid Glass
- **Swift Core** — Swift language, concurrency, Codable, Charts, Testing, SwiftData

**iOS (only when `.xcodeproj` targets `iphoneos` via SDKROOT):**
- **iOS App Frameworks** — App Intents, Widgets, StoreKit, MapKit, Live Activities
- **iOS Data Frameworks** — CloudKit, HealthKit, MusicKit, WeatherKit, Contacts
- **iOS AI & ML** — Core ML, Vision, on-device AI, speech recognition
- **iOS Engineering** — networking, security, accessibility, localization, Instruments
- **iOS Hardware** — Bluetooth, CoreMotion, NFC, PencilKit, RealityKit
- **iOS Platform** — CallKit, EnergyKit, HomeKit, SharePlay, PermissionKit

**Web:**
- **React & Web Frontend** — React best practices, web design, composition patterns
- **React Native** — cross-platform mobile patterns
- **Frontend Design & UX** — frontend design, accessibility

**Languages:**
- **Rust** — Rust patterns and best practices
- **Python** — Python patterns and best practices
- **Go** — Go patterns and best practices

**General:**
- **Document Handling** — PDF, DOCX, XLSX, PPTX creation and manipulation

### Maintaining the Catalog

The skill catalog lives in [`src/resources/extensions/gsd/skill-catalog.ts`](../src/resources/extensions/gsd/skill-catalog.ts). To add or update a pack:

1. Add a `SkillPack` entry to the `SKILL_CATALOG` array with `repo`, `skills`, and matching criteria
2. For language-detection matching, use `matchLanguages` (values from `detection.ts` `LANGUAGE_MAP`)
3. For Xcode platform matching, use `matchXcodePlatforms` (e.g., `["iphoneos"]` — parsed from `SDKROOT` in `project.pbxproj`)
4. For file-presence matching, use `matchFiles` (checked against `PROJECT_FILES` in `detection.ts`)
5. If the pack should appear in greenfield choices, add it to `GREENFIELD_STACKS`
6. Packs sharing the same `repo` are batched into a single `npx skills add` invocation

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
1. **Bare name** — e.g., `frontend-design` → scans `~/.agents/skills/` and project `.agents/skills/`
2. **Absolute path** — e.g., `/Users/you/.agents/skills/my-skill/SKILL.md`
3. **Directory path** — e.g., `~/custom-skills/my-skill` → looks for `SKILL.md` inside

Global skills (`~/.agents/skills/`) take precedence over project skills (`.agents/skills/`).

## Custom Skills

Create your own skills by adding a directory with a `SKILL.md` file:

```
~/.agents/skills/my-skill/
  SKILL.md           — instructions for the LLM
  references/        — optional reference files
```

The `SKILL.md` file contains instructions the LLM follows when the skill is active. Reference files can be loaded by the skill instructions as needed.

### Project-Local Skills

Place skills in your project for project-specific guidance:

```
.agents/skills/my-project-skill/
  SKILL.md
```

Project-local skills can be committed to version control so team members share the same skill set.

## Skill Lifecycle Management

GSD tracks skill performance across auto-mode sessions and surfaces health data to help you maintain skill quality.

### Skill Telemetry

Every auto-mode unit records which skills were available and actively loaded. This data is stored in `metrics.json` alongside existing token and cost tracking.

### Skill Health Dashboard

View skill performance with `/gsd skill-health`:

```
/gsd skill-health              # overview table: name, uses, success%, tokens, trend, last used
/gsd skill-health rust-core    # detailed view for one skill
/gsd skill-health --stale 30   # skills unused for 30+ days
/gsd skill-health --declining  # skills with falling success rates
```

The dashboard flags skills that may need attention:
- **Success rate below 70%** over the last 10 uses
- **Token usage rising 20%+** compared to the previous window
- **Stale skills** unused beyond the configured threshold

### Staleness Detection

Skills unused for a configurable number of days are flagged as stale and can be automatically deprioritized:

```yaml
---
skill_staleness_days: 60   # default: 60, set to 0 to disable
---
```

Stale skills are excluded from automatic matching but remain invokable explicitly via `read`.

### Heal-Skill (Post-Unit Analysis)

When configured as a post-unit hook, GSD can analyze whether the agent deviated from a skill's instructions during execution. If significant drift is detected (outdated API patterns, incorrect guidance), it writes proposed fixes to `.gsd/skill-review-queue.md` for human review.

Key design principle: skills are **never auto-modified**. Research shows curated skills outperform auto-generated ones significantly, so the human review step is critical.
