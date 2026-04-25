You are merging changes from worktree **{{worktreeName}}** (branch `{{worktreeBranch}}`) into target branch `{{mainBranch}}`.

## Working Directory

Your current working directory has been set to the **main project tree** at `{{mainTreePath}}`. You are on the `{{mainBranch}}` branch. All git and file commands run from here.

- **Main tree (CWD):** `{{mainTreePath}}` — this is where you run `git merge`, read main-branch files, and commit
- **Worktree directory:** `{{worktreePath}}` — the worktree's working copy; read files here to inspect worktree versions before merging
- **Worktree branch:** `{{worktreeBranch}}`

## Context

The worktree was created as a parallel workspace. It may contain code changes, new milestones, updated roadmaps, new plans, research, decisions, or other artifacts that need to be merged into the target branch.

### Commit History (worktree)

```
{{commitLog}}
```

### Changed Files

**Added files:**
{{addedFiles}}

**Modified files:**
{{modifiedFiles}}

**Removed files:**
{{removedFiles}}

### Code Diff

```diff
{{codeDiff}}
```

### GSD Artifact Diff

```diff
{{gsdDiff}}
```

## Your Task

Analyze the changes and guide the merge. Follow these steps exactly:

### Step 1: Categorize Changes

Classify each changed file:

**Code changes:**
- **New source files** — new modules, components, utilities, tests
- **Modified source files** — changes to existing code
- **Config changes** — package.json, tsconfig, build config, etc.
- **Deleted files** — removed source or config files

**GSD artifact changes:**
- **New milestones** — entirely new M###/ directories with roadmaps
- **New slices/tasks** — new planning artifacts within existing milestones
- **Updated roadmaps** — modifications to existing M###-ROADMAP.md files
- **Updated plans** — modifications to existing slice or task plans
- **Research/context** — new or updated RESEARCH.md, CONTEXT.md files
- **Decisions** — changes to DECISIONS.md
- **Requirements** — changes to REQUIREMENTS.md
- **Other** — anything else

### Step 2: Conflict Assessment

For each **modified** file, check whether the main branch version has also changed since the worktree branched off. Flag any files where both branches have diverged — these need manual reconciliation.

To compare versions:
- **Main-branch version:** read the file at its normal path (your CWD is the main tree)
- **Worktree version:** read the file at `{{worktreePath}}/<relative-path>`
- Use `git merge-base {{mainBranch}} {{worktreeBranch}}` to find the common ancestor if needed

Classify each modified file:
- **Clean merges** — main hasn't changed, worktree changes can apply directly
- **Conflicts** — both branches changed the same file; needs reconciliation
- **Stale changes** — worktree modified a file that main has since replaced or removed

### Step 3: Merge Strategy

Present a merge plan to the user:

1. For **clean merges**: list files that will merge without conflict
2. For **conflicts**: show both versions side-by-side and propose a reconciled version
3. For **new files**: confirm they should be added to the main branch
4. For **removed files**: confirm the removals are intentional

Ask the user to confirm the merge plan before proceeding.

**CRITICAL — Non-bypassable gate:** Do NOT execute any merge commands until the user explicitly approves the merge plan. If `ask_user_questions` fails, errors, returns no response, or the user's response is ambiguous, you MUST re-ask — never rationalize past the block. "No response, I'll proceed with the clean merges," "the plan looks safe, merging," or any other self-authorization is **forbidden**. The gate exists to protect the user's branches; treat a block as an instruction to wait, not an obstacle to work around.

### Step 4: Execute Merge

Once the user has explicitly confirmed, run all commands from `{{mainTreePath}}` (your CWD):

1. Ensure you are on the target branch: `git checkout {{mainBranch}}`
2. If there are conflicts requiring manual reconciliation, apply the reconciled versions first
3. Run `git merge --squash {{worktreeBranch}}` to bring in all changes
4. Review the staged changes — if any reconciled files need adjustment, apply them now
5. Commit with message: `merge(worktree/{{worktreeName}}): <summary of what was merged>`
6. Report what was merged

### Step 5: Cleanup Prompt

After a successful merge, ask the user whether to:
- **Remove the worktree** — delete the worktree directory and the `{{worktreeBranch}}` branch
- **Keep the worktree** — leave it for continued parallel work

If the user chooses to remove it, run these commands from `{{mainTreePath}}`:
```
git worktree remove {{worktreePath}}
git branch -D {{worktreeBranch}}
```

**Do NOT use `/worktree remove` — the command handler may not have the correct state after the merge.** Use the git commands directly.

## Important

- Never silently discard changes from either branch
- When in doubt about a conflict, show both versions and ask the user
- Preserve all GSD artifact formatting conventions (frontmatter, section structure, checkbox states)
- If the worktree introduced new milestone IDs that conflict with main, flag this immediately
