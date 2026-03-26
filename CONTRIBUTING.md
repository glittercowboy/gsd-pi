# Contributing to GSD-2

We're glad you're here. GSD-2 is an open project and contributions are welcome across the entire codebase. We hold a high bar for what gets merged — not to be gatekeepers, but because every change ships to real users and stability matters.

Read [VISION.md](VISION.md) before contributing. It defines what GSD-2 is, what it isn't, and what we won't accept.

## Before you start

1. **Check existing issues.** Someone may already be working on it.
2. **Claim the issue.** Comment on the issue to get it assigned to you before writing code. This prevents duplicate work and wasted effort.
3. **No issue? Create one first** for new features. Bug fixes for obvious problems can skip this step.
4. **Architectural changes require an RFC.** If your change touches core systems (auto-mode, agent-core, orchestration), open an issue describing your approach and get approval before writing code. We use Architecture Decision Records (ADRs) for significant decisions.

## Branching and commits

Always work on a dedicated branch. Never push directly to `main`.

**Branch naming:** `<type>/<short-description>`

| Type | When to use |
|------|-------------|
| `feat/` | New functionality |
| `fix/` | Bug or defect correction |
| `refactor/` | Code restructuring, no behavior change |
| `test/` | Adding or updating tests |
| `docs/` | Documentation only |
| `chore/` | Dependencies, tooling, housekeeping |
| `ci/` | CI/CD configuration |

**Commit messages** must follow [Conventional Commits](https://www.conventionalcommits.org/). The commit-msg hook enforces this locally; CI enforces it on push.

```
<type>(<scope>): <short summary>
```

Valid types: `feat` `fix` `docs` `chore` `refactor` `test` `infra` `ci` `perf` `build` `revert`

```
feat(pi-agent-core): add streaming output for long-running tasks
fix(pi-ai): resolve null pointer on empty provider response
chore(deps): bump typescript from 5.3.0 to 5.4.2
```

Keep branches current by rebasing onto `main` — do not merge `main` into your feature branch:

```bash
git fetch origin
git rebase origin/main
```

## Working with GSD (team workflow)

GSD uses worktree-based isolation for multi-developer work. If you're contributing with GSD running, enable team mode in your project preferences:

```yaml
# .gsd/PREFERENCES.md
---
version: 1
mode: team
---
```

This enables unique milestone IDs, branch pushing, and pre-merge checks — preventing milestone ID collisions when multiple contributors run auto-mode simultaneously. Each developer gets their own isolated worktree; squash merges to `main` happen independently.

For full details see [docs/working-in-teams.md](docs/working-in-teams.md) and [docs/git-strategy.md](docs/git-strategy.md).

## Opening a pull request

### PR description format

Every PR needs a **TL;DR** and a **detailed explanation**. Use this structure:

```
## TL;DR

**What:** One sentence — what does this change?
**Why:** One sentence — why is it needed?
**How:** One sentence — what's the approach?

## What

Detailed description of the change. What files, modules, or systems are affected?

## Why

The motivation. What problem does this solve? What was broken, missing, or suboptimal?
Link issues where applicable: `Closes #123`

## How

The approach. How does the implementation work? What were the key decisions?
If this is a non-trivial change, explain the design and any alternatives you considered.
```

### Requirements

- **CI must pass.** If your PR breaks tests, fix them before requesting review.
- **One concern per PR.** A bug fix is a bug fix. A feature is a feature. Don't bundle unrelated changes.
- **No drive-by formatting.** Don't reformat code you didn't change. Don't reorder imports in files you're not modifying.
- **Link issues when relevant.** Not mandatory for every PR, but if an issue exists, reference it.

### Change type checklist

Include in your PR:

- [ ] `feat` — New feature or capability
- [ ] `fix` — Bug fix
- [ ] `refactor` — Code restructuring (no behavior change)
- [ ] `test` — Adding or updating tests
- [ ] `docs` — Documentation only
- [ ] `chore` — Build, CI, or tooling changes

### Breaking changes

If your PR changes any public API, CLI behavior, config format, or file structure, say so explicitly. Breaking changes need extra scrutiny and may need migration guidance.

## AI-assisted contributions

AI-generated PRs are first-class citizens here. We welcome them. We just ask for transparency:

- **Disclose it.** Note that the PR is AI-assisted in your description. Do not credit the AI tool as an author or co-author in the commit or PR.
- **Test it.** AI-generated code must be tested to the same standard as human-written code. "The AI said it works" is not a test plan.
- **Understand it.** You should be able to explain what the code does and why. If a reviewer asks a question, "I'll ask the AI" is not an answer.

AI agents opening PRs must follow the same workflow as human contributors: clean working tree, new branch per task, CI passing before requesting review. Multi-phase work should start as a Draft PR and only move to Ready when complete.

AI PRs go through the same review process as any other PR. No special treatment in either direction.

## Architecture guidelines

Before writing code, understand these principles:

- **Extension-first.** Can this be an extension instead of a core change? If yes, build it as an extension.
- **Simplicity wins.** Don't add abstractions, helpers, or utilities for one-time operations. Don't design for hypothetical future requirements.
- **Tests are the contract.** Changed behavior? The test suite tells you what you broke.

See [VISION.md](VISION.md) for the full list of what we won't accept.

## Scope areas

The codebase is organized into these areas. All are open to contributions:

| Area | Path | Notes |
|------|------|-------|
| Terminal UI | `packages/pi-tui` | Components, themes, rendering |
| AI/LLM layer | `packages/pi-ai` | Provider integrations, model handling |
| Agent core | `packages/pi-agent-core` | Agent orchestration — RFC required for changes |
| Coding agent | `packages/pi-coding-agent` | The main coding agent |
| GSD extension | `src/resources/extensions/gsd/` | GSD workflow — RFC required for auto-mode |
| Native bindings | `native/` | Platform-specific native code |
| CI/Build | `.github/`, `scripts/` | Workflows, build scripts |

## Review process

PRs go through automated review first, then human review. To help us review efficiently:

- Keep PRs focused and reasonably sized. Massive PRs take longer to review and are more likely to be sent back.
- Respond to review comments. If you disagree, explain why — discussion is welcome.
- If your PR has been open for a while without review, ping in Discord. We're a small team and things slip.

### What reviewers verify

Reading a diff is not the same as verifying a change. Our review standard is execution-based, not static-analysis-based.

**What reviewers do:**

1. **Check out the branch** — check out the PR branch locally (or in a worktree). Don't review from the diff view alone.
2. **Build the branch** — run `npm run build`. A diff that doesn't compile is not reviewable.
3. **Run the test suite** — run `npm test`. CI status is a signal, not a substitute for local verification.
4. **Trace root cause for bug fixes** — confirm the diff addresses the root cause described in the issue, not just the symptom.
5. **Check for a regression test** — bug fixes must include a test that would have caught the original bug. If it's absent, the fix is incomplete.

Only after completing these steps should a reviewer make claims about correctness.

**What "looks right" means:**

"Looks right" is the starting point for review, not the conclusion. "The tests pass" only means the tests pass — not that the claimed bug is fixed or the feature works as described. A well-written commit message on a broken change is still a broken change.

### What contributors must provide to unblock review

- **Bug fixes** — include a regression test. A fix without a test is an assertion, not a proof.
- **Features** — include tests covering the primary success path and at least one failure path.
- **Behavior changes** — update or replace any existing tests that cover the changed behavior. Don't leave passing-but-wrong tests in place.

If your PR claims to fix issue #N, reviewers will verify the fix addresses the root cause described in #N — not just that CI is green.

## Testing standards

This project uses Node.js built-in `node:test` as the test runner. All new tests must follow these patterns:

### Use `node:test` and `node:assert/strict`

```typescript
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
```

Do not use `createTestContext()` from `test-helpers.ts` (legacy, being removed). Do not introduce Jest, Vitest, or other test frameworks.

### Use `beforeEach`/`afterEach` or `t.after()` for cleanup — never `try`/`finally`

```typescript
// ✅ CORRECT — shared fixture with beforeEach/afterEach
describe("feature", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "test-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("case", () => { /* clean test body */ });
});

// ✅ CORRECT — per-test cleanup with t.after()
test("case", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "test-"));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); });
  // test body
});

// ❌ WRONG — inline try/finally
test("case", () => {
  const tmp = mkdtempSync(join(tmpdir(), "test-"));
  try {
    // test body
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

**When to use which:**
- `beforeEach`/`afterEach` — when all tests in a `describe` block share the same setup/teardown pattern
- `t.after()` — when each test has unique cleanup (different fixtures, env vars, etc.)
- `try`/`finally` — only inside standalone helper functions that don't have access to the test context `t` (e.g., `withEnv()`, `capture()`)

### Template literal fixture data

When constructing multi-line fixture content (markdown, YAML, etc.) inside indented test blocks, use array join to avoid unintended leading whitespace:

```typescript
// ✅ CORRECT — no indentation leakage
const content = [
  "## Slices",
  "- [x] **S01: First slice**",
  "- [ ] **S02: Second slice**",
].join("\n");

// ❌ WRONG — template literal inside describe/test adds leading spaces
const content = `
  ## Slices
  - [x] **S01: First slice**
`;
// Each line now has 2 leading spaces, breaking ^## regex anchors
```

### Test-first for bug fixes

Bug fixes must include a regression test that fails before the fix and passes after. Write the test first, confirm it fails, then apply the fix. See the `test-first-bugfix` skill.

## Local development

```bash
# Install dependencies
npm ci

# Install git hooks (secret scanning + commit message validation)
npm run secret-scan:install-hook

# Build
npm run build

# Run tests
npm test

# Type check
npx tsc --noEmit
```

Run `npm run secret-scan:install-hook` once after cloning. It installs two hooks:
- **pre-commit** — blocks commits containing hardcoded secrets or credentials
- **commit-msg** — validates Conventional Commits format before the commit lands

CI must pass before your PR will be reviewed. Run these locally to save time.

## Security

If you find a security vulnerability, **do not open a public issue.** Email the maintainers directly or use GitHub's private vulnerability reporting.

## Questions?

Open a discussion on GitHub or ask in the Discord `#maintainers` channel.
