## Skill Heal Analysis

Analyze the just-completed unit ({{unitId}}) for skill drift.

### Steps

1. **Identify loaded skill**: Check which SKILL.md file was read during this unit by examining recent tool calls. If no skill was explicitly loaded (no `read` call to a SKILL.md path), write "No skill loaded — skipping heal analysis" to {{healArtifact}} and stop.

2. **Read the skill**: Load the SKILL.md that was used during this unit.

3. **Compare execution to skill guidance**: Review what the agent actually did vs what the skill recommended. Look for:
   - API patterns the skill recommended that the agent did differently
   - Error handling approaches the skill specified but the agent bypassed
   - Conventions the skill documented that the agent ignored
   - Outdated instructions in the skill that caused errors, retries, or workarounds
   - Commands or tools the skill referenced that no longer exist or have changed

4. **Assess drift severity**:
   - **None**: Agent followed skill correctly → write "No drift detected" to {{healArtifact}} and stop
   - **Minor**: Agent found a better approach but skill isn't wrong → append a note to `.gsd/KNOWLEDGE.md` and stop
   - **Significant**: Skill has outdated or incorrect guidance → continue to step 5

5. **If significant drift found**, append a heal suggestion to `.gsd/skill-review-queue.md`:

```markdown
### {{skillName}} (flagged {{date}})
- **Unit:** {{unitId}}
- **Issue:** {1-2 sentence description of what was wrong}
- **Root cause:** {outdated API / incorrect pattern / missing context / etc.}
- **Discovery method:** {how the agent discovered the skill was wrong — error message, trial and error, docs lookup, etc.}
- **Proposed fix:**
  - File: {relative path to the file in the skill directory}
  - Section: {section heading or line range}
  - Current: {quote the incorrect/outdated text}
  - Suggested: {the corrected text}
- **Action:** [ ] Reviewed [ ] Updated [ ] Dismissed
```

Then write a brief summary of the finding to {{healArtifact}}.

**Critical rules:**
- Do NOT modify any skill files directly. Only write to the review queue.
- The SkillsBench research (Feb 2026) shows curated skills beat auto-generated ones by +16.2pp. Human review is what makes this valuable.
- Keep the analysis focused — don't flag stylistic preferences, only genuine errors or outdated content.
- If multiple issues found, write one entry per issue.
