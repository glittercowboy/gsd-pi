Interacts with Language Server Protocol servers for code intelligence.

<operations>
- `diagnostics`: Get errors/warnings for file, glob, or entire workspace (no file)
- `definition`: Go to symbol definition → file path + position + 3-line source context
- `type_definition`: Go to symbol type definition → file path + position + 3-line source context
- `implementation`: Find concrete implementations → file path + position + 3-line source context
- `references`: Find references → locations with 3-line source context (first 50), remaining location-only
- `hover`: Get type info and documentation → type signature + docs
- `symbols`: List symbols in file, or search workspace (with query, no file)
- `incoming_calls`: Find all callers of a function → call sites with context
- `outgoing_calls`: Find all functions called by a function → callees with context
- `rename`: Rename symbol across codebase → preview or apply edits
- `code_actions`: List available quick-fixes/refactors/import actions; apply one when `apply: true` and `query` matches title or index
- `format`: Format file using language server formatter → applies edits in-place
- `signature`: Get function signature and parameter info at cursor position
- `status`: Show active language servers
- `reload`: Restart the language server
</operations>

<parameters>
- `file`: File path; for diagnostics it may be a glob pattern (e.g., `src/**/*.ts`)
- `line`: 1-indexed line number for position-based actions
- `symbol`: Substring on the target line used to resolve column automatically
- `occurrence`: 1-indexed match index when `symbol` appears multiple times on the same line
- `query`: Symbol search query, code-action kind filter (list mode), or code-action selector (apply mode)
- `new_name`: Required for rename
- `apply`: Apply edits for rename/code_actions (default true for rename, list mode for code_actions unless explicitly true)
- `tab_size`: Tab size for formatting (default: 4)
- `insert_spaces`: Use spaces for formatting (default: true)
- `timeout`: Request timeout in seconds (clamped to 5-60, default 20)
</parameters>

<caution>
- Requires running LSP server for target language
- Some operations require file to be saved to disk
- Diagnostics glob mode samples up to 20 files per request to avoid long-running stalls on broad patterns
- When `symbol` is provided for position-based actions, missing symbols or out-of-bounds `occurrence` values return an explicit error instead of silently falling back
</caution>
