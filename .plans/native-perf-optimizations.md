# Native Performance Optimizations — deriveState, JSONL, Paths, Parsing

## Overview

Four native Rust optimizations to eliminate hot-path bottlenecks in GSD's dispatch cycle.
Building on the existing git2 migration and native parser infrastructure.

---

## 1. Native deriveState — Eliminate Frontmatter Re-serialization

### Problem
`state.ts:134-176` — When `nativeBatchParseGsdFiles()` returns parsed files, the JS
side re-serializes frontmatter back into YAML strings so downstream parsers can re-parse
them. This is a round-trip waste: Rust parses → JS re-serializes → JS re-parses.

### Solution
The native batch parser already returns `{ metadata: JSON, body, sections }`.
Instead of re-serializing frontmatter to YAML in JS, modify `cachedLoadFile()` to
return the raw body directly, and update downstream parsers to accept pre-parsed
metadata. This eliminates the entire lines 143-172 re-serialization loop.

However, the parsers (`parseRoadmap`, `parseSummary`, `parsePlan`, etc.) all expect
raw markdown strings with frontmatter. Changing their signatures would be a massive
refactor. Instead:

**Approach: Make Rust return the original file content alongside parsed data.**

Add a new field `rawContent: String` to `ParsedGsdFile` that contains the complete
original file content. The JS batch cache stores this directly, eliminating the
re-serialization entirely. Downstream parsers get exactly what `loadFile()` would return.

### Implementation
- **Rust** (`gsd_parser.rs`): Add `raw_content` field to `ParsedGsdFile`, populate with
  the original file content read from disk.
- **TS** (`native-parser-bridge.ts`): Expose `rawContent` in `BatchParsedFile`.
- **TS** (`state.ts`): Replace the 30-line re-serialization loop with
  `fileContentCache.set(absPath, f.rawContent)`.

### Impact
Eliminates ~30 lines of JS string building per dispatch. Removes JSON.parse of metadata
that was only used to re-serialize back to YAML.

---

## 2. Native JSONL Streaming Parser

### Problem
`session-forensics.ts:68-78` — Parses JSONL by `split("\n").map(JSON.parse)` with a
10MB cap. Large session files cause OOM or slowness.

### Solution
Add a Rust JSONL parser that streams through the file with constant memory, returning
structured data. Uses `serde_json` for parsing and handles arbitrary file sizes.

### Implementation
- **Rust** (`gsd_parser.rs`): Add `parse_jsonl_tail(path, max_entries?)` function that:
  1. Memory-maps or streams the file from the tail
  2. Parses each line as JSON
  3. Returns the last N entries as a JSON array string
- **TS** (`native-parser-bridge.ts`): Add bridge function.
- **TS** (`session-forensics.ts`): Use native parser, fall back to JS implementation.

### Impact
Handles arbitrary file sizes. 3-5x faster parsing on 10MB files.

---

## 3. Native Directory Tree Index

### Problem
`paths.ts:20-34` — `cachedReaddirSync()` caches per-directory, but caches are
cleared every dispatch via `invalidateAllCaches()`. Each `resolveMilestoneFile`,
`resolveSliceFile`, `resolveTaskFile` triggers separate directory reads.

### Solution
Add a Rust function that walks the entire `.gsd/` tree once and returns a flat
file listing. The JS side builds a Map from this, making all path resolution O(1)
lookups instead of repeated `readdirSync` + regex matching.

### Implementation
- **Rust** (`gsd_parser.rs`): The `batchParseGsdFiles` already walks the tree.
  Add `scan_gsd_tree(directory)` that returns `Vec<{ path, isDir, name }>` for
  ALL entries (not just .md files).
- **TS** (`native-parser-bridge.ts`): Add bridge function.
- **TS** (`paths.ts`): Add native tree cache. On first access, call native scan
  and build lookup maps. `clearPathCache()` clears the native cache too.

### Impact
Eliminates 20-50 `readdirSync` calls per dispatch. Makes `resolveDir`/`resolveFile`
O(1) lookups.

---

## 4. Expand Native Markdown Parsing

### Problem
`files.ts` parsers (`parsePlan`, `parseSummary`, `parseContinue`) still use JS regex.
Each runs ~10-20 regex patterns per file. Only `parseRoadmap` has a native implementation.

### Solution
Add native Rust implementations for `parsePlan` and `parseSummary` — the two parsers
called most frequently during `deriveState`. `parseContinue` is called infrequently
and can stay in JS.

### Implementation
- **Rust** (`gsd_parser.rs`): Add `parse_plan_file(content)` and `parse_summary_file(content)`.
- **TS** (`native-parser-bridge.ts`): Add bridge functions with JS fallback.
- **TS** (`files.ts`): Call native versions first, fall back to JS.

### Impact
3-5x faster parsing per file. With ~20 files per deriveState, saves 20-40ms.

---

## Implementation Order

1. **deriveState raw content** (smallest change, biggest immediate impact)
2. **Directory tree index** (eliminates readdirSync overhead)
3. **JSONL streaming parser** (helps crash recovery path)
4. **Plan/Summary native parsers** (improves parsing throughput)

## Files Modified

### Rust
- `native/crates/engine/src/gsd_parser.rs` — new functions + rawContent field

### TypeScript
- `src/resources/extensions/gsd/native-parser-bridge.ts` — new bridge functions
- `src/resources/extensions/gsd/state.ts` — simplified batch cache
- `src/resources/extensions/gsd/paths.ts` — native tree cache
- `src/resources/extensions/gsd/session-forensics.ts` — native JSONL
- `src/resources/extensions/gsd/files.ts` — native plan/summary parsers
