# Decisions Register

<!-- Append-only. Never edit or remove existing rows.
     To reverse a decision, add a new row that supersedes it.
     Read this file at the start of any planning or research phase. -->

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | 2026-03-12 | Architecture | Build on Pi SDK vs standalone | Pi SDK (`@mariozechner/pi-coding-agent`) | Direct TypeScript access to agent harness — context management, session control, extension system, UI | No |
| D002 | 2026-03-12 | Git | Branch-per-slice with squash-merge | `gsd/M001/S01` branches, squash-merge to main | Clean git history, isolated slice work, easy rollback | No |
| D003 | 2026-03-12 | Git | Runtime state gitignored | `STATE.md`, `metrics.json`, `auto.lock`, `activity/`, `worktrees/` excluded from git | Prevents branch-switch pollution and merge conflicts on transient state | No |
| D004 | 2026-03-12 | Architecture | Fresh session per task | Context window cleared between tasks, relevant files pre-injected | Prevents context degradation over long sessions | No |
| D005 | 2026-03-12 | Git | Abort squash-merge on conflict | `git reset --hard HEAD` on merge failure instead of leaving dirty state | Prevents auto-mode loops with corrupted working tree (merge-bug-fix) | No |
| D006 | 2026-03-12 | Architecture | Extension-based architecture | All features as Pi extensions, not monolithic | Composability, independent development, clean separation | No |
| D007 | 2026-03-12 | Search | Multi-provider search | Native Anthropic + Brave + Tavily, auto-detection | Flexibility, no hard dependency on any single search API | Yes |
| D008 | 2026-03-12 | Naming | ID-based file/dir naming | `M001/`, `S01-PLAN.md`, `T01-SUMMARY.md` — no descriptors in names | Parseable, stable references, titles live in content | No |
| D009 | 2026-03-12 | UX | Template-first custom provider setup | Write models.json template + open in $EDITOR, not step-by-step builder | models.json schema has many optional fields; template gives working starting point users can customize; consistent with Pi SDK design | Yes |
| D010 | 2026-03-12 | Auth | Custom provider keys in auth.json, not models.json | Wizard stores API key via authStorage.set() under provider name; models.json apiKey field used as placeholder/env-var ref | Keeps secrets out of models.json; uses existing auth resolution chain (auth.json → resolveConfigValue fallback) | No |
| D011 | 2026-03-12 | UX | models.json existence gates onboarding | shouldRunOnboarding() checks for models.json alongside LLM_PROVIDER_IDS auth | Prevents wizard loop for custom-only users without maintaining a separate custom provider ID list | Yes |
| D012 | 2026-03-12 | Architecture | Use getAvailable() not getAll() for startup fallback | Startup fallback chain uses `modelRegistry.getAvailable()` (auth-filtered) instead of `getAll()` | Prevents selecting models from providers the user hasn't configured auth for; `getAll()` would include unconfigured providers | No |
| D013 | 2026-03-12 | Maintenance | Full restoration of merge-conflict-lost code | Restored 5 features from pre-`3c06aa8` version of git-service.ts rather than minimal patching | Implementations were correct, complete, and tested; patching would risk subtle behavior differences | No |
