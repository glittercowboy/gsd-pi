---
name: github-workflows
description: Work with GitHub Actions CI/CD workflows - read live syntax, monitor runs, and debug failures. Use when writing, running, or debugging GitHub Actions workflows.
---

# GitHub Workflows

**Mission:** Work with GitHub Actions without using stale training data. All syntax, versions, and parameters come from live sources.

---

## Structural Principle

**All CI operations go through ci_monitor.cjs.** Never reach for `gh` CLI directly — the script wraps it with observable output.

---

## Primary Tool: ci_monitor.cjs

**Path:** `scripts/ci_monitor.cjs`

```bash
node scripts/ci_monitor.cjs <command>
```

**Before using any command:**
- [ ] Run `--help` to discover available arguments

**Routing Table:**

| When You Need | Command |
|---------------|---------|
| List recent runs | `runs [--branch <name>]` |
| Monitor running workflow | `watch <run-id>` |
| Fail fast in scripts | `fail-fast <run-id>` |
| See why run failed | `log-failed <run-id>` |
| Test pass/fail counts | `test-summary <run-id>` |
| Check action versions | `check-actions [file]` |
| Search logs | `grep <run-id> --pattern <regex>` |
| Wait for deployment | `wait-for <run-id> <job> --keyword <text>` |

---

## Documentation Routing

**Base URL:** `https://docs.github.com/en/actions/reference/workflows-and-actions/`

**Before writing any workflow syntax:**
- [ ] Fetch the relevant `.md` file from the URL above
- [ ] Read only the section you need

| Task | File | Section |
|------|------|---------|
| Create workflow | workflow-syntax.md | `name`, `on`, `jobs` |
| Set triggers | workflow-syntax.md | `on` |
| Set permissions | workflow-syntax.md | `permissions` |
| Concurrency | workflow-syntax.md | `concurrency` |
| Reusable workflow | workflow-syntax.md | `on.workflow_call` |
| Annotations | workflow-commands.md | "Setting an error/warning/notice message" |
| Output variables | workflow-commands.md | "Environment files" |
| Conditionals | expressions.md | "Operators", "Functions" |
| Contexts | contexts.md | "<context> context" |
| Events | events-that-trigger-workflows.md | Event tables |

---

## Version Verification

| What | Where |
|------|-------|
| Action versions | `node ci_monitor.cjs check-actions <file>` |
| Node.js LTS | `curl -s https://nodejs.org/dist/index.json \| jq '.[0].version'` |

---

## Validation Constraint

**"No errors" is not validation.** Prove observable change:

```
BEFORE: [specific state]
AFTER:  [different state]
EVIDENCE: [output from ci_monitor.cjs]
```

---

## References

- `references/gh/SKILL.md` — gh CLI reference
- `scripts/ci_monitor.cjs` — CI monitoring tool
- `scripts/ci_monitor.md` — Tool usage documentation
