<overview>
GSD-specific skill ecosystem details: directory conventions, discovery mechanics, telemetry, and health monitoring. Read this reference when creating or auditing skills within GSD.
</overview>

<skill_directories>
GSD supports two skill directories, checked in order:

**User-scope (global):** `~/.agents/skills/`
- Available in every GSD session regardless of working directory
- Installed via [skills.sh](https://skills.sh) or manually

**Project-scope (local):** `.agents/skills/`
- Available only when GSD runs inside the project directory
- Committable to version control so team members share the same skill set
- Ideal for project-specific workflows, deploy scripts, or conventions

Skills in both directories follow the same SKILL.md format and router pattern conventions.
</skill_directories>

<skill_discovery>
GSD auto-discovers skills at session start and during auto-mode:

**Session start:** All skills in both directories are enumerated and their names + descriptions are injected into the system prompt as `<available_skills>`.

**Auto-mode discovery:** `skill-discovery.ts` takes a snapshot of the skills directory at auto-mode start. On each unit boundary it diffs against the snapshot. Any new skills found are injected via a `<newly_discovered_skills>` XML block so the LLM sees them without requiring `/reload`.

**Manual reload:** Running `/reload` re-scans both directories and updates the available skills list mid-session.
</skill_discovery>

<skill_validation>
Skill metadata has validation constraints:

- **name:** lowercase letters, numbers, and hyphens only. Maximum 64 characters. Must match directory name exactly. No reserved words ("anthropic", "claude").
- **description:** Non-empty, maximum 1024 characters. No XML tags. Third person voice. Must state what it does AND when to use it.
</skill_validation>

<skill_telemetry>
`skill-telemetry.ts` tracks per-skill usage:

- **Read count:** How often each skill is loaded
- **Last used timestamp:** When the skill was most recently invoked
- **Staleness detection:** Skills unused for 60+ days are flagged as stale
- **Pass/fail rates:** Derived from unit completion status when a skill is active

Telemetry data is stored in `~/.gsd/metrics.json` alongside other GSD metrics.
</skill_telemetry>

<skill_health>
`skill-health.ts` aggregates telemetry into actionable health reports:

- **Success rate:** Units with this skill that completed without retry
- **Token trend:** Whether token usage per invocation is stable, rising, or declining
- **Staleness:** Days since last use, flagged at 60+ days
- **Flagging thresholds:**
  - Success rate below 70% → flagged for review
  - Rising token trend → flagged (may indicate skill drift or bloat)
  - 60+ days stale → flagged

The `/doctor` command surfaces skill health issues alongside other system diagnostics.
</skill_health>

<activation>
After creating or modifying a skill:

1. Run `/reload` to make it available in the current session
2. On next session start, auto-discovery picks it up automatically
3. In auto-mode, new skills are detected at unit boundaries without any action needed
</activation>
