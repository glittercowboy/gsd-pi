# Decisions Register

<!-- Append-only. Never edit or remove existing rows.
     To reverse a decision, add a new row that supersedes it.
     Read this file at the start of any planning or research phase. -->

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001 | arch | Model data source | models.dev/api.json | Open-source, actively maintained, used by opencode | Yes — if models.dev becomes unavailable |
| D002 | M001 | arch | Cache duration | 12 hours | User-specified, balances freshness with network usage | Yes |
| D003 | M001 | arch | Fallback chain | cache → snapshot → live fetch | Ensures offline capability, graceful degradation | No |
| D004 | M001 | arch | Snapshot generation | Commit snapshot, update via PRs | Simpler than build-time fetch, avoids network dependency during build | Yes — could automate later |
| D005 | M001 | pattern | Fetch timing | On startup when cache expired (not background polling) | Simpler, no timer management, user controls refresh | Yes |
| D006 | M001 | impl | Zod schema exports | Exported const schemas instead of namespace | --experimental-strip-types doesn't support namespaces | No |
| D007 | M001 | impl | Test imports | Use .ts extension directly | Custom ESM resolver requires explicit extension | No |
| D008 | M001 | impl | Lazy config resolution | require() for VERSION/getAgentDir at call time | Avoids build dependency during tests | No |
| D009 | M001 | impl | Network error handling | Return null instead of throwing | Enables graceful fallback chain without try/catch at call sites | No |
| D010 | M001 | impl | API type inference | Provider ID substring matching | Simple heuristic works for known providers, defaults to openai | Yes — may need explicit mapping for new providers |
| D011 | M001/S02 | impl | Cache read timing | Sync cache check in constructor | Avoids blocking startup; async refresh is fire-and-forget | No |
| D012 | M001/S02 | impl | Override application | Shared helper function for sync/async paths | Dedupes logic, ensures consistency between cache hit and refresh | No |
| D013 | M001/S02 | impl | Constructor parameter properties | Regular class properties (not parameter properties) | Node's strip-only TypeScript doesn't support parameter properties | No |
| D014 | M001/S03 | impl | Snapshot generation schemas | Inline Zod schemas in generation script | Avoids circular dependency with built pi-ai package | No |
| D015 | M001/S03 | impl | Snapshot fetch timeout | 30 seconds (longer than runtime 10s) | Generation happens at build time, can afford longer timeout | Yes |
| D016 | M001/S03 | impl | Snapshot validation | Defensive check for non-empty object | Guards against corrupted/empty snapshot file | No |
| D017 | M002 | impl | Test imports (supersedes D007) | Use .js extension in import specifiers | Node16 module resolution with allowImportingTsExtensions:false requires .js specifiers even for .ts sources; custom resolver rewrites at runtime | No |
| D018 | M002 | impl | Test isolation | Use tmpdir() instead of homedir() for registry tests | Prevents test pollution of actual ~/.gsd/agent/ config and cache | No |
| D019 | M002 | impl | Live test scope | Live models.dev verification in main suite | User explicitly chose this tradeoff for upstream compatibility checking | No |
| D020 | M002 | impl | Slice ordering | Build repair first, then scenario tests, then live verification | Build failures block all downstream verification; live tests depend on working infrastructure | No |
| D021 | M002/S02 | impl | Registry cache path injection | Optional cachePath parameter in ModelRegistry constructor | Enables production-like scenario tests with tmpdir() isolation without mocking or mutating user directories | No |
