# Migration from v1

If you have projects with `.planning` directories from the original Get Shit Done (v1), you can migrate them to GSD-2's `.gsd` format.

## Running the Migration

```bash
# From within the project directory
/gsd migrate

# Or specify a path
/gsd migrate ~/projects/my-old-project
```

## What Gets Migrated

The migration tool:

- Parses your old `PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, phase directories, plans, summaries, and research
- Maps phases → slices, plans → tasks, milestones → milestones
- Preserves completion state (`[x]` phases stay done, summaries carry over)
- Consolidates research files into the new structure
- Shows a preview before writing anything
- Optionally runs an AI-driven review for quality assurance

## Supported Formats

The migration handles various v1 format variations:

- Milestone-sectioned roadmaps with `<details>` blocks
- Bold phase entries
- Bullet-format requirements
- Decimal phase numbering
- Duplicate phase numbers across milestones

## Requirements

Migration works best with a `ROADMAP.md` file for milestone structure. Without one, milestones are inferred from the `phases/` directory.

## Post-Migration

After migrating, verify the output:

```
/gsd doctor
```

This checks `.gsd/` integrity and flags any structural issues.
