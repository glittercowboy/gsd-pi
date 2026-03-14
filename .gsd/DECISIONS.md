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
