---
name: dependency-upgrade
description: Plan, batch, and verify dependency upgrades safely. Triages outdated packages into risk tiers, upgrades in order (dev/minor/patch first, runtime majors last), verifies each batch before moving on, and produces an auditable commit sequence. Use when asked to "upgrade deps", "bump packages", "update node_modules", "fix vulnerabilities", "upgrade React/Node/TypeScript", or after `/gsd start dep-upgrade`. Complements the dep-upgrade workflow template with execution-level rigor.
---

<objective>
Turn a pile of outdated packages into a series of small, verifiable upgrades with clean commits. The deliverable is an ordered upgrade plan, executed with verification between batches, and a summary that flags anything risky for follow-up. No big-bang upgrades.
</objective>

<context>
GSD-2 ships a `/gsd start dep-upgrade` workflow template (`src/resources/extensions/gsd/workflow-templates/dep-upgrade.md`) that structures the phases: assess → upgrade → fix breaks → verify. This skill is the execution-level detail inside the upgrade phase — how to batch, how to verify, how to recover from a breaking upgrade without losing the good ones.

Invocation points:
- `/gsd start dep-upgrade` workflow is running
- Ad-hoc "bump the deps" request
- Security advisory response (CVE in a direct dep)
- Framework major-version update (React 18 → 19, Node LTS bump)
- Monthly hygiene pass
</context>

<core_principle>
**BATCH BY RISK, NOT BY LAZINESS.** `npm update` is a shortcut that blends safe and risky changes into one commit. When something breaks, you can't tell which dep caused it. Always separate: patches and dev-deps first, minors next, majors individually.

**VERIFY BETWEEN BATCHES.** Run the test suite after every batch. Don't stack five batches and hope. If a batch breaks something, you need to know which one.

**ONE MAJOR PER COMMIT.** Major version bumps are where real breakage lives. Keep them isolated so the commit history tells the truth.
</core_principle>

<process>

## Step 1: Take inventory

Run the ecosystem's outdated check. Capture output, don't act on it yet:
- Node: `npm outdated` or `pnpm outdated` or `yarn outdated`
- Python: `pip list --outdated` or `uv pip list --outdated`
- Rust: `cargo outdated`
- Ruby: `bundle outdated`
- Go: `go list -m -u all`

Also capture:
- `npm audit` (or equivalent) — security advisories
- Current versions of language runtime, build tool, test runner

## Step 2: Classify each outdated package

For each outdated package, note:

- **Type:** direct dep / dev-dep / transitive
- **Kind of bump:** patch (1.2.3 → 1.2.4), minor (1.2.3 → 1.3.0), major (1.2.3 → 2.0.0)
- **Risk:** Low (dev-dep, patch), Medium (runtime minor, dev-dep major), High (runtime major, framework, TypeScript compiler)
- **Blast radius:** How many files in the repo import it? (Rough count via `rg`.)
- **Has known breaking changes:** Check the CHANGELOG or release notes for any major bumps — do NOT skip this, and do NOT infer "probably fine."

## Step 3: Build the batch plan

Order:

1. **Batch 1 — Dev dep patches and minors.** Lowest risk, fastest feedback. Includes linters, formatters, type definitions, test runners.
2. **Batch 2 — Runtime patches.** All patch bumps to runtime deps together.
3. **Batch 3 — Runtime minors.** One batch per semantic group if any minor carries risk notes; otherwise one batch for the rest.
4. **Batch 4+ — Each major, individually.** One commit per major. Framework bumps (React, Next.js, Vue, TypeScript) each get their own commit.
5. **Batch N — Language runtime.** If bumping Node/Python/Rust, last — it changes the compile/run env for everything.

Skip (for now):
- Anything with "unreleased", "pre", "beta", "rc" tags unless the user explicitly wants pre-release tracking
- Deps you know are blocked by another dep (e.g., can't bump X until Y supports it)

Present the plan to the user. One round of adjustment. Then execute.

## Step 4: Execute a batch

For each batch:

1. **Start from a clean working tree.** `git status` — no uncommitted changes.
2. **Apply the upgrades** using the ecosystem command (`npm install package@version ...`, `uv add …`, `cargo update -p …`).
3. **Regenerate the lockfile** fully if necessary.
4. **Build.** Run the project's real build — not just typecheck.
5. **Test.** Run the full suite. Not a scoped subset.
6. **Lint.** `lsp diagnostics` on changed files + the project linter.
7. **Smoke-test the app** if it has a running surface (dev server, CLI command).

If any step fails:
- Investigate before moving on. Don't skip the batch.
- If the failure is trivial (a rename, a deprecated import), fix it in the same commit — the upgrade broke it, the upgrade commit fixes it.
- If the failure is non-trivial (an API you heavily depend on was removed), either pin back or split: upgrade the other deps in the batch in this commit, and handle the problem dep separately in Step 5.

**Commit with a precise message:**

```
deps: bump <scope> — <what changed in one line>

- package-a: 1.2.3 → 1.2.9 (patch)
- package-b: 2.1.0 → 2.4.0 (minor — no breaking changes in CHANGELOG)
- package-c: 3.0.1 → 3.0.2 (patch)

Verified: npm test (84/84 pass), npm run build exit 0, lsp diagnostics clean.
```

## Step 5: Handle stuck majors

For each major that breaks something:

1. **Read the migration guide** — do not guess at the API changes.
2. **Scope the blast radius** — `rg` for the symbols that changed.
3. **Decide: upgrade now or defer?** If the migration is a weekend's work and not urgent, file a `/gsd start refactor` follow-up and pin the current major for now.
4. **If upgrading now:** branch the work as its own slice (`S##`). The dep upgrade is only one task; the migration is the rest of the slice.
5. **Verify end-to-end after migration.** The test suite alone may miss behavior changes.

## Step 6: Summary

After all batches, produce a rollup:

```markdown
## Dependency Upgrade — <date>

### Completed
- Batch 1 (dev patches): 12 packages — commit abc1234
- Batch 2 (runtime patches): 5 packages — commit def5678
- Batch 3 (runtime minors): 3 packages — commit ...
- Batch 4 (React 18 → 19): commit ... — required refactors in <files>

### Deferred
- typescript 5.3 → 5.7 — requires updating 40+ decorator usages. Filed as M005.
- vite 4 → 5 — config shape changed. Owner assigned: <user>.

### Still outdated (intentional)
- <package> — pinned because <reason>

### Security advisories
- <CVE> resolved by <package upgrade>
- <CVE> still open — not exploitable in our usage (see comment in package.json)
```

Append to `.gsd/KNOWLEDGE.md` any non-obvious gotcha from the upgrade (API changes that tripped you up, migration rituals for this codebase).

</process>

<anti_patterns>

- **`npm update` blindly.** Mixes safe and risky in one undiagnosable commit.
- **Multiple majors in one commit.** When it breaks, you don't know which.
- **No verification between batches.** You stack failures until nothing works.
- **Skipping the CHANGELOG.** "It's just a minor" — until it isn't.
- **Force-merging a failing batch with `--force`.** Leave it broken or roll back; don't lie to git.
- **Ignoring `--legacy-peer-deps` warnings.** They're telling you the dep graph is incoherent.

</anti_patterns>

<success_criteria>

- [ ] Each batch is in its own commit with a precise message.
- [ ] Majors are one-per-commit.
- [ ] Test suite, build, and lint passed after every batch (per `verify-before-complete`).
- [ ] Stuck upgrades are documented with a concrete next step (filed as slice/milestone, or pinned with a reason).
- [ ] Security advisories are addressed or explicitly triaged.
- [ ] Summary report exists for the user to review.

</success_criteria>
