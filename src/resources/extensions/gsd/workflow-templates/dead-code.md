# Dead Code Finder

<template_meta>
name: dead-code
version: 1
mode: oneshot
requires_project: false
artifact_dir: null
</template_meta>

<purpose>
Find functions, files, and exports that appear unused. Report them with
evidence. **Do not delete anything** — the human decides what's safe to remove.
</purpose>

<instructions>

## 1. Identify the language & toolchain

Inspect the repo root to determine the primary language. Based on that, pick
the appropriate tooling:

| Language        | Tool(s)                                                 |
| --------------- | ------------------------------------------------------- |
| TypeScript / JS | `ts-unused-exports`, `knip`, or manual `grep` fallback  |
| Python          | `vulture`                                               |
| Go              | `staticcheck` + manual dead-code detection              |
| Rust            | `cargo +nightly udeps`, `cargo-machete`                 |
| Other           | language-appropriate tool or manual symbol search       |

If a suitable tool is installed in the project, use it. Otherwise fall back to
a systematic manual search (see step 3).

## 2. Scan for candidates

Look for four kinds of dead code:
1. **Unused exports** — exports no other file imports.
2. **Unused files** — files imported by nothing (and not an entry point).
3. **Dead branches** — functions that are reachable but have branches that
   can never execute given the call sites.
4. **Unused dependencies** — packages in `package.json` / `pyproject.toml`
   that aren't imported anywhere.

## 3. Verify each candidate

Dead-code tools are noisy. Before reporting anything, manually confirm by:
- Searching for the symbol name across the repo (`grep -r` or `rg`).
- Checking build configs (webpack, vite, rollup) for dynamic imports.
- Checking test configs for fixtures or test-only code.
- Checking for usage in templates, strings, or dynamic accessors (these
  often trip tools).

If a symbol is only referenced in a test, distinguish:
- Real dead code: test exists but production never calls it.
- Test-only helper: legitimate — not dead.

## 4. Bucket by confidence

```
## High confidence (safe to remove)
- file path:line — symbol / file
  Evidence: <why you're sure — zero refs, no dynamic import candidates, etc.>

## Medium confidence (check with author)
- file path:line — symbol
  Evidence: <only referenced in one unclear place, or dynamic-import-lookalike>

## Low confidence (ignore unless suspicious)
- file path:line
  Reason: <looks dead but could be a public API, plugin surface, etc.>
```

## 5. Don't delete

End with:
> To remove high-confidence items, run `/gsd workflow refactor "remove dead code"`
> and pass the list above as context.

The user decides. Do **not** delete files, `git rm`, or open a PR.

</instructions>
