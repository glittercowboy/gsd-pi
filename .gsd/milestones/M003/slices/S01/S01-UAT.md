# S01: Upstream merge and build stabilization — UAT

**Milestone:** M003
**Written:** 2026-03-16

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S01 is a build-only gate — it proves the codebase compiles after merging upstream. Runtime correctness is verified in S02+. All checks are deterministic command outputs.

## Preconditions

- Working directory is the GSD-2 repo root
- `node` (v20+) and `npm` are available
- `upstream` remote points to the upstream repo (`git remote -v | grep upstream`)
- No uncommitted changes (merge is already committed)

## Smoke Test

```bash
npm run build && npm run build:web-host && echo "SMOKE PASS"
```
Expected: prints "SMOKE PASS" — both builds succeed.

## Test Cases

### 1. Zero conflict markers in source tree

1. Run: `rg "^<<<<<<<|^>>>>>>>|^=======$" src/ web/ packages/ .github/`
2. **Expected:** Exit code 1, no output. Zero conflict markers anywhere in the source tree.

### 2. All upstream commits present

1. Run: `git log --oneline HEAD..upstream/main | wc -l`
2. **Expected:** Output is `0`. No upstream commits are missing from the fork.

### 3. Main TypeScript build succeeds

1. Run: `npm run build`
2. **Expected:** Exit code 0. All 5 workspace packages (`@gsd/native`, `@gsd/pi-tui`, `@gsd/pi-ai`, `@gsd/pi-coding-agent`, main tsc) compile without errors.

### 4. Web host build succeeds

1. Run: `npm run build:web-host`
2. **Expected:** Exit code 0. Next.js production build completes and standalone staging succeeds. One expected warning about `@gsd/native` not resolving in the Next.js bundle (this is normal — it's a dynamic require with try/catch fallback).

### 5. Lockfile present and consistent

1. Run: `test -f package-lock.json && echo "present" || echo "absent"`
2. **Expected:** `present`
3. Run: `npm ls --all 2>&1 | grep -c "missing"`
4. **Expected:** `0` — no missing dependencies.

### 6. Fork web scripts preserved in package.json

1. Run: `grep -c "build:web-host\|stage:web-host\|gsd:web\"" package.json`
2. **Expected:** `3` or more — fork's web-specific npm scripts survived the merge.

### 7. Web-mode CLI routing wired in cli.ts

1. Run: `grep -c "cli-web-branch\|stopWebMode\|parseWebCliArgs\|runWebCliBranch\|getProjectSessionsDir" src/cli.ts`
2. **Expected:** `5` or more — all fork web-mode imports are present in the merged cli.ts.

### 8. Fork web source files resolve

1. Run: `ls src/web/bridge-service.ts src/web-mode.ts src/cli-web-branch.ts 2>&1`
2. **Expected:** All three files listed without errors — fork's web-mode modules are intact.

## Edge Cases

### Stale dist/ does not break clean rebuild

1. Run: `rm -rf packages/*/dist/ && npm run build`
2. **Expected:** Exit code 0. Build succeeds even after cleaning all dist/ directories — no circular import dependencies on pre-built artifacts.

### No false-positive conflict markers from code patterns

1. Run: `rg "=======" src/ web/ packages/ | grep -v "^<<<<<<<\|^>>>>>>>\|^=======$" | head -5`
2. **Expected:** Any matches are JavaScript strict equality (`===`) or comment dividers, not real conflict markers. Confirms the anchored-pattern approach catches only actual markers.

### Upstream's decomposed auto modules are available

1. Run: `ls src/resources/extensions/gsd/auto-dispatch.ts src/resources/extensions/gsd/auto-recovery.ts src/resources/extensions/gsd/auto-dashboard.ts 2>&1`
2. **Expected:** All three files exist — upstream's decomposed auto.ts modules are present for S02+ to consume.

### Upstream's new command modules are available

1. Run: `ls src/resources/extensions/gsd/forensics.ts src/resources/extensions/gsd/captures.ts src/resources/extensions/gsd/visualizer-data.ts src/resources/extensions/gsd/model-router.ts src/resources/extensions/gsd/skill-health.ts 2>&1`
2. **Expected:** All five files exist — upstream's new feature modules are present for S03–S07 to build browser surfaces against.

## Failure Signals

- `npm run build` or `npm run build:web-host` exits non-zero — merge broke compilation
- `rg "^<<<<<<<" src/` returns matches — unresolved conflict markers remain
- `git log --oneline HEAD..upstream/main` returns non-zero count — upstream commits are missing
- `grep "cli-web-branch" src/cli.ts` returns no matches — web-mode routing was lost during merge
- `npm ls --all 2>&1 | grep "missing"` returns matches — lockfile is inconsistent with package.json

## Requirements Proved By This UAT

- R100 — All four verification criteria (zero markers, both builds pass, all upstream commits present) are directly tested by cases 1–4.

## Not Proven By This UAT

- Runtime correctness of merged code — no processes are started, no API routes are hit
- Web UI rendering or interaction — that's S02+ scope
- Test suite green — that's S09 scope (R110)
- Correct behavior of upstream's new features — S03–S07 will verify these

## Notes for Tester

- The `@gsd/native` warning during `build:web-host` is expected — it's a dynamic require for a native Node addon that the Next.js bundler can't resolve but the runtime guards with try/catch.
- One pre-existing moderate npm vulnerability exists — it was not introduced by this merge.
- The upstream count was 415 (not the originally estimated 398) because upstream released v2.22.0 between research and execution. This is expected.
